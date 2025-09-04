import { NextResponse } from "next/server";
import type { Browser } from "playwright-core";
import { launchChromium } from '@/app/api/scrape-menu/launch';
import { parseLatLngFromUrl, extractUuidsFromHref } from "@/app/api/scrape-menu/parsing";
import { autoscrollAll, extractCategoryName, acceptCookiesIfPresent, waitForAnySelector } from "@/app/api/scrape-menu/dom";
import { normalizeScrapedToMenuData } from "@/app/api/scrape-menu/normalize";
import { UUID_RX } from "@/app/api/scrape-menu/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type ScrapeRequest = { url: string; fast?: boolean; maxItems?: number; timeoutMs?: number };

type JobStatus = 'running' | 'completed' | 'error' | 'cancelled';
type ProgressRecord = {
  id: string;
  status: JobStatus;
  startedAt: number;
  updatedAt: number;
  message?: string;
  stage?: string;
  processed?: number;
  success?: number;
  fail?: number;
  total?: number;
  sectionsProcessed?: number;
  sectionsTotal?: number;
  itemsDiscovered?: number;
  retryRound?: number;
  retryPending?: number;
  failedItems?: Array<{ id: string | null; href: string | null; title: string | null }>;
  meta?: Record<string, any>;
  cancelRequested?: boolean;
};

// In-memory progress store (best-effort, per process)
function getGlobalProgress(): Map<string, ProgressRecord> {
  // @ts-ignore
  const g = globalThis as any;
  if (!g.__MENAI_PROGRESS__) g.__MENAI_PROGRESS__ = new Map<string, ProgressRecord>();
  return g.__MENAI_PROGRESS__ as Map<string, ProgressRecord>;
}
const progressStore = getGlobalProgress();
function now() { return Date.now(); }
function createJob(id?: string): string {
  const finalId = id && typeof id === 'string' ? id : Math.random().toString(36).slice(2);
  progressStore.set(finalId, { id: finalId, status: 'running', startedAt: now(), updatedAt: now(), processed: 0, success: 0, fail: 0, meta: {}, cancelRequested: false, stage: 'init' });
  return finalId;
}
function updateJob(id: string, patch: Partial<ProgressRecord>) {
  const cur = progressStore.get(id);
  if (!cur) return;
  const next = { ...cur, ...patch, updatedAt: now() } as ProgressRecord;
  progressStore.set(id, next);
}
function completeJob(id: string, patch?: Partial<ProgressRecord>) {
  updateJob(id, { status: 'completed', ...(patch || {}) });
}
function errorJob(id: string, message: string, patch?: Partial<ProgressRecord>) {
  updateJob(id, { status: 'error', message, ...(patch || {}) });
}
function markCancelled(id: string, patch?: Partial<ProgressRecord>) {
  updateJob(id, { status: 'cancelled', ...(patch || {}) });
}
function getJob(id: string): ProgressRecord | undefined { return progressStore.get(id); }
function cleanupJob(id: string) { progressStore.delete(id); }
function isCancelled(id?: string): boolean { return id ? (getJob(id)?.cancelRequested === true) : false; }

type StepFn = (name: string, data?: any) => void;

function sanitizeUberUrl(input: string): string {
  try {
    const u = new URL(input);
    // Remove encoded spaces in path segments like "/%20store" -> "/store"
    u.pathname = u.pathname.replace(/%20/gi, "");
    // Collapse duplicate slashes
    u.pathname = u.pathname.replace(/\/+/g, "/");
    return u.toString();
  } catch {
    return input.replace(/\/%20store/gi, "/store");
  }
}

async function analyzeAndPreparePage(page: any, url: string, step: StepFn): Promise<{ storeName: string | null }> {
    // STEP 1: Basic page analysis
    const title = await page.title();
    step("page_title", { title });
    
    // STEP 2: Look for any content containers
    const contentSelectors = [
      'li[data-testid="store-catalog-subsection-container"]',
      'a[data-testid^="store-item-"]',
      '[data-testid="rich-text"]',
      'main section',
      '.menu-item',
      '.category',
      'section'
    ];
    
    let foundContent = false;
    for (const selector of contentSelectors) {
      const count = await page.locator(selector).count();
      if (count > 0) {
        step("content_found", { selector, count });
        foundContent = true;
        break;
      }
    }
    
    if (!foundContent) {
      step("no_content_selectors_found");
      const allElements = await page.locator('*').count();
      const bodyText = await page.locator('body').innerText();
    step("page_analysis", { totalElements: allElements, bodyTextLength: bodyText.length, bodyTextPreview: bodyText.slice(0, 500) });
  }

  // STEP 3: Accept cookies before reading store name to avoid cookie banner text
  await acceptCookiesIfPresent(page);
  step("cookies_checked");

  // STEP 4: Try to find store name
    const nameSelectors = ["header h1", '[data-testid="rich-text"] h1', "h1", ".store-name", ".restaurant-name"];
  let storeName: string | null = null;
    for (const sel of nameSelectors) {
      const loc = page.locator(sel);
      if ((await loc.count()) > 0) {
        storeName = (await loc.first().innerText()).trim();
        step("store_name_found", { name: storeName, selector: sel });
        break;
      }
    }

  // STEP 5: Basic category detection and prep
    await page.waitForLoadState("networkidle").catch(() => {});
    const foundSel = await waitForAnySelector(
      page,
      [
        'li[data-testid="store-catalog-subsection-container"]',
        'a[data-testid^="store-item-"]',
        '[data-testid="rich-text"]',
        'main section',
      ],
      25000
    );
    step("content_probe", { foundSelector: foundSel });
    if (!foundSel) {
      const html = await page.content();
      step("content_missing", { snippet: html.slice(0, 5000) });
      
      // Check for rate limiting or blocking
      if (html.includes('too many requests') || html.includes('rate limit') || html.includes('blocked')) {
        throw new Error("Website is rate limiting requests. Please try again later or use a different approach.");
      }
      
      // Check if we got a minimal HTML response (likely an error page)
      if (html.length < 1000 && html.includes('<pre>')) {
        throw new Error("Website returned an error page. The URL may be invalid or the site may be blocking automated requests.");
      }
      
      throw new Error("Store content not found after waiting for multiple selectors");
    }

    await page.waitForTimeout(3000);
    
    const sectionsCount = await page.locator('li[data-testid="store-catalog-subsection-container"]').count();
    const primaryItemsCount = await page.locator('a[data-testid^="store-item-"]').count();
    const fallbackItemsCount = await page.locator('a[data-testid*="store-item"], a[href*="/store/"]').count();
    const itemsCount = Math.max(primaryItemsCount, fallbackItemsCount);
    
    step("content_counts", { sectionsCount, primaryItemsCount, fallbackItemsCount, totalItemsCount: itemsCount });
    
    if (sectionsCount === 0 && itemsCount === 0) {
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(2000);
  }

  // Expand "see more"
    for (const sel of ["button:has-text('See more')", "button:has-text('Ver más')", "button:has-text('More')"]) {
      let buttonCount = await page.locator(sel).count();
      if (buttonCount > 0) {
        let attempts = 0;
      const maxAttempts = 10;
        while (buttonCount > 0 && attempts < maxAttempts) {
          attempts++;
          const btn = page.locator(sel).first();
          try {
            await btn.click({ force: true });
          await page.waitForTimeout(500);
            const newCount = await page.locator(sel).count();
          if (newCount >= buttonCount) break;
            buttonCount = newCount;
        } catch {
            break;
          }
        }
      }
    }
    step("expanded_all_see_more");

    await autoscrollAll(page);
    step("autoscrolled");

  return { storeName };
}
    
async function detectSections(page: any, step: StepFn): Promise<{ sections: any; nSections: number; selectedSelector: string }> {
     const categorySelectors = [
       'li[data-testid="store-catalog-subsection-container"]',
       'h3[data-testid*="rich-text"]',
       'div[data-testid="catalog-section-header"]',
       'div[data-testid="catalog-section-title"]',
       '[data-testid*="subsection"]',
       '[data-testid*="section"]',
       'section',
       '.menu-section',
       '.category-section'
     ];
    
  let sections: any = null;
    let nSections = 0;
    let selectedSelector = '';
    
    step("detect_sections_start", { selectorsToTry: categorySelectors.length });
    
    for (const selector of categorySelectors) {
      const elements = page.locator(selector);
      const count = await elements.count();
      step("selector_check", { selector, count });
      
      if (count > 0) {
        const firstElement = elements.first();
        const hasItems = await firstElement.locator('a[href*="/store/"], a[href*="item"], .menu-item, .item').count();
        step("selector_items_check", { selector, count, hasItems });
        
        if (hasItems > 0) {
          sections = elements;
          nSections = count;
          selectedSelector = selector;
          step("sections_found", { selector, nSections });
          break;
        }
      }
    }
    
    if (!sections || nSections === 0) {
      step("fallback_containers_start");
      const itemContainers = page.locator('div, section, li');
      const totalContainers = await itemContainers.count();
      step("fallback_containers_count", { totalContainers });
      
    const validContainers: any[] = [];
      for (let i = 0; i < totalContainers; i++) {
        const container = itemContainers.nth(i);
        const itemCount = await container.locator('a[href*="/store/"], a[href*="item"], .menu-item, .item').count();
        if (itemCount >= 3) validContainers.push(container);
        }
      const containerCount = validContainers.length;
      step("fallback_containers_valid", { validCount: containerCount });
      
      if (containerCount > 0) {
      sections = { count: () => Promise.resolve(containerCount), nth: (i: number) => validContainers[i] || validContainers[0] } as any;
        nSections = containerCount;
        selectedSelector = 'item-containers';
        step("fallback_containers_success", { nSections });
      }
    }
    
    if (!sections || nSections === 0) {
      step("fallback_body_start");
      const allMenuItems = page.locator('a[href*="/store/"], a[href*="item"], .menu-item, .item');
      const totalItems = await allMenuItems.count();
      step("fallback_body_items", { totalItems });
      
      if (totalItems > 0) {
      sections = page.locator('body');
        nSections = 1;
        selectedSelector = 'body-container';
        step("fallback_body_success");
      }
    }
    
  if (!sections) {
    step("sections_detection_failed");
    throw new Error('No menu sections could be detected');
  }
  
  step("sections_detection_complete", { nSections, selectedSelector });
  return { sections, nSections, selectedSelector };
}

async function collectCategories(
  page: any,
  sections: any,
  nSections: number,
  startedAt: number,
  step: StepFn,
  jobId?: string
): Promise<{ categories: any[]; allItems: any[]; storeUuidFromItems: string | null }>{
  const categories: any[] = [];
  const allItems: any[] = [];
  let storeUuidFromItems: string | null = null;
  const seenCategoryNames = new Set<string>();
  let itemsDiscovered = 0;
  let sectionsProcessed = 0;

  step("collect_categories_start", { nSections });

  for (let i = 0; i < nSections; i += 1) {
    if (isCancelled(jobId)) {
      step("collect_categories_cancelled", { i, nSections });
      break;
    }
    
    step("processing_section", { i, nSections });
    const sec = sections.nth(i);
    const catName = await extractCategoryName(sec as any);
    step("category_name_extracted", { i, catName });
    
    // Scroll to this section and wait for items to load
    step("scrolling_to_section", { i, catName });
    
    // Multiple scroll strategies to ensure lazy loading is triggered
    await sec.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    
    // Try different scroll positions to trigger lazy loading
    const sectionElement = await sec.elementHandle();
    const scrollStrategies = [
      () => sec.scrollIntoViewIfNeeded(),
      () => page.evaluate((section: any) => {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, sectionElement),
      () => page.evaluate((section: any) => {
        section.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, sectionElement),
      () => page.evaluate((section: any) => {
        section.scrollIntoView({ behavior: 'smooth', block: 'end' });
      }, sectionElement)
    ];
    
    // Wait for items to populate in this section
    let itemsLoaded = false;
    let waitAttempts = 0;
    const maxWaitAttempts = 15;
    
    while (!itemsLoaded && waitAttempts < maxWaitAttempts) {
      waitAttempts++;
      
      // Try different scroll strategies
      if (waitAttempts <= scrollStrategies.length) {
        await scrollStrategies[waitAttempts - 1]();
        await page.waitForTimeout(800);
      } else {
        // If still no items, try gentle scrolling around the section
        await page.evaluate((section: any) => {
          const rect = section.getBoundingClientRect();
          window.scrollBy(0, rect.top - window.innerHeight / 2);
        }, sectionElement);
        await page.waitForTimeout(500);
      }
      
      const currentItemCount = await sec.locator('a[data-testid^="store-item-"]').count();
      step("waiting_for_items", { i, catName, attempt: waitAttempts, currentItemCount });
      
      if (currentItemCount > 0) {
        itemsLoaded = true;
        step("items_loaded", { i, catName, itemCount: currentItemCount });
        
        // Wait a bit more to ensure all items in this section are loaded
        await page.waitForTimeout(1000);
        const finalItemCount = await sec.locator('a[data-testid^="store-item-"]').count();
        if (finalItemCount > currentItemCount) {
          step("additional_items_loaded", { i, catName, finalItemCount });
        }
      }
    }
    
    if (!itemsLoaded) {
      step("items_not_loaded_warning", { i, catName, attempts: waitAttempts });
    }
    
    if (seenCategoryNames.has(catName)) {
      step("category_duplicate_skipped", { i, catName });
      continue;
    }
    seenCategoryNames.add(catName);

    // Try multiple strategies to find store items, handling both carousel and grid layouts
    let anchors: any = null;
    let nItems = 0;
    
    // First, let's debug what's actually in this section
    const sectionHtml = await sec.innerHTML();
    const sectionText = await sec.innerText();
    step("section_debug", { 
      i, 
      catName, 
      htmlLength: sectionHtml.length,
      textLength: sectionText.length,
      textPreview: sectionText.slice(0, 200)
    });
    
    // Strategy 1: Direct store-item selector (works for both layouts)
    anchors = sec.locator('a[data-testid^="store-item-"]');
    nItems = await anchors.count();
    step("primary_items_count", { i, catName, nItems });
    
    // Debug: Let's see what containers exist in this section
    const allDivs = await sec.locator('div').count();
    const carouselDivs = await sec.locator('div[data-ref="store-carousel"]').count();
    const gridDivs = await sec.locator('div[data-testid="store-catalog-section-vertical-grid"]').count();
    const itemContainers = await sec.locator('div[class*="de"], div[class*="i4"], div[class*="i6"]').count();
    
    step("section_containers_debug", { 
      i, catName, 
      totalDivs: allDivs,
      carouselDivs,
      gridDivs, 
      itemContainers
    });
    
    // Strategy 2: If no direct items found, try layout-agnostic selectors
    if (nItems === 0) {
      step("trying_layout_agnostic_selectors", { i, catName });
      const layoutAgnosticSelectors = [
        // Look for any anchor with store-item in data-testid
        'a[data-testid*="store-item"]',
        // Look for anchors with store URLs (common pattern)
        'a[href*="/store/"]',
        // Look for any clickable elements that might be items
        'a[href*="item"]',
        'a[href*="mod=quickView"]',
        // Look for elements with item-related data attributes
        '[data-testid*="item"]',
        // Look for common menu item patterns
        '.menu-item a',
        '.item a',
        'a[role="button"]',
        'button[role="button"]',
        '[data-testid*="menu"]'
      ];
      
      for (const itemSel of layoutAgnosticSelectors) {
        const altAnchors = sec.locator(itemSel);
        const altCount = await altAnchors.count();
        step("layout_agnostic_selector_try", { i, catName, selector: itemSel, count: altCount });
        if (altCount > 0) { 
          anchors = altAnchors; 
          nItems = altCount; 
          step("layout_agnostic_selector_success", { i, catName, selector: itemSel, nItems });
          break; 
        }
      }
    }
    
    // Strategy 3: Comprehensive container-based discovery
    // This handles the case where a section has multiple item containers
    if (nItems === 0) {
      step("trying_comprehensive_container_discovery", { i, catName });
      
      // Collect ALL items from ALL containers within this section
      const allItemsFromContainers: any[] = [];
      
      // Strategy 3a: Look for specific container patterns
      const containerSelectors = [
        // Carousel containers
        'div[data-ref="store-carousel"]',
        // Grid containers  
        'div[data-testid="store-catalog-section-vertical-grid"]',
        // Generic item containers (based on the image patterns)
        'div[class*="de"][class*="oh"][class*="ag"]',
        'div[class*="i4"][class*="gn"][class*="kp"]',
        'div[class*="i6"][class*="kr"][class*="ks"]',
        // Fallback: any div that might contain items
        'div'
      ];
      
      for (const containerSel of containerSelectors) {
        const containers = sec.locator(containerSel);
        const containerCount = await containers.count();
        step("container_selector_debug", { i, catName, selector: containerSel, count: containerCount });
        
        for (let c = 0; c < containerCount; c++) {
          const container = containers.nth(c);
          
          // Look for store items within this specific container
          const containerItems = container.locator('a[data-testid^="store-item-"], a[data-testid*="store-item"], a[href*="/store/"]');
          const containerItemCount = await containerItems.count();
          
          step("container_items_debug", { 
            i, catName, 
            containerSelector: containerSel, 
            containerIndex: c,
            itemCount: containerItemCount 
          });
          
          if (containerItemCount > 0) {
            // Collect items from this container
            for (let itemIdx = 0; itemIdx < containerItemCount; itemIdx++) {
              const item = containerItems.nth(itemIdx);
              allItemsFromContainers.push(item);
            }
          }
        }
      }
      
      // If we found items in containers, use them
      if (allItemsFromContainers.length > 0) {
        anchors = { 
          count: () => Promise.resolve(allItemsFromContainers.length), 
          nth: (idx: number) => allItemsFromContainers[idx] || allItemsFromContainers[0] 
        } as any;
        nItems = allItemsFromContainers.length;
        step("comprehensive_container_discovery_success", { 
          i, catName, 
          totalItemsFound: nItems 
        });
      }
    }

    if (nItems === 0) {
      const clickableElements = sec.locator('a, button, [role="button"], [tabindex]');
      const clickableCount = await clickableElements.count();
      if (clickableCount > 0) {
        const menuItemElements: any[] = [];
        for (let j = 0; j < clickableCount; j++) {
          const element = clickableElements.nth(j);
          const text = await element.innerText();
          const hasText = text.trim().length > 0;
          if (hasText) menuItemElements.push(element);
        }
        if (menuItemElements.length > 0) {
          anchors = { count: () => Promise.resolve(menuItemElements.length), nth: (i: number) => menuItemElements[i] || menuItemElements[0] } as any;
          nItems = menuItemElements.length;
        }
      }
    }

    // Final robustness check: prefer a broader union selector if it yields more items
    try {
      const unionSelector = [
        // Direct store item selectors (both layouts)
        'a[data-testid^="store-item-"]',
        'a[data-testid*="store-item"]',
        // Store URL patterns
        'a[href*="/store/"]',
        'a[href*="/item"]',
        // Generic item patterns
        'a[data-testid*="item"]',
        'ul li a',
        // Container-based patterns (for both carousel and grid)
        'div[data-ref="store-carousel"] a',
        'div[data-testid="store-catalog-section-vertical-grid"] a',
        'div[class*="carousel"] a',
        'div[class*="grid"] a',
        // Multiple container patterns (based on the image)
        'div[class*="de"][class*="oh"] a',
        'div[class*="i4"][class*="gn"] a',
        'div[class*="i6"][class*="kr"] a',
        // Any anchor within this section
        'a'
      ].join(',');
      const wideAnchors = sec.locator(unionSelector);
      const wideCount = await wideAnchors.count();
      
      step("union_selector_debug", { i, catName, originalCount: nItems, unionCount: wideCount });
      
      if (wideCount > nItems) { 
        anchors = wideAnchors; 
        nItems = wideCount; 
        step("union_selector_improvement", { i, catName, originalCount: nItems, unionCount: wideCount });
      }
    } catch {}

    // Final safety net: if we still have very few items, try a brute force approach
    if (nItems < 5) {
      step("trying_brute_force_item_discovery", { i, catName, currentCount: nItems });
      
      // Get ALL anchors in this section and filter for store items
      const allAnchors = sec.locator('a');
      const allAnchorCount = await allAnchors.count();
      
      const validItems: any[] = [];
      for (let anchorIdx = 0; anchorIdx < allAnchorCount; anchorIdx++) {
        const anchor = allAnchors.nth(anchorIdx);
        const href = await anchor.getAttribute('href');
        const dataTestId = await anchor.getAttribute('data-testid');
        
        // Check if this looks like a store item
        if (href && (href.includes('/store/') || href.includes('/item')) || 
            dataTestId && dataTestId.includes('store-item')) {
          validItems.push(anchor);
        }
      }
      
      if (validItems.length > nItems) {
        anchors = { 
          count: () => Promise.resolve(validItems.length), 
          nth: (idx: number) => validItems[idx] || validItems[0] 
        } as any;
        nItems = validItems.length;
        step("brute_force_success", { i, catName, newCount: nItems });
      }
    }

    // Final check: scroll through the entire section to ensure all items are loaded
    if (nItems > 0) {
      step("final_section_scroll_check", { i, catName, currentItemCount: nItems });
      
      // Scroll through the section to trigger any remaining lazy loading
      const sectionElement = await sec.elementHandle();
      await page.evaluate((section: any) => {
        const rect = section.getBoundingClientRect();
        const sectionHeight = rect.height;
        const scrollSteps = Math.ceil(sectionHeight / 200); // Scroll in 200px steps
        
        for (let step = 0; step < scrollSteps; step++) {
          const scrollY = rect.top + (step * 200);
          window.scrollTo(0, scrollY);
        }
      }, sectionElement);
      
      await page.waitForTimeout(1000);
      
      // Re-count items after final scroll
      const finalItemCount = await sec.locator('a[data-testid^="store-item-"]').count();
      if (finalItemCount > nItems) {
        step("final_scroll_found_more_items", { i, catName, originalCount: nItems, finalCount: finalItemCount });
        // Update our anchors and count
        anchors = sec.locator('a[data-testid^="store-item-"]');
        nItems = finalItemCount;
      }
    }

    const catItems: any[] = [];
    step("category_scan", { idx: i, name: catName, nItems });

    for (let j = 0; j < nItems; j += 1) {
      if (j % 10 === 0 || j === nItems - 1) {
        step("processing_item", { i, catName, j, nItems });
      }
      if (isCancelled(jobId)) break;
      
      // Add progressive delays to avoid rate limiting during item scanning
      if (j > 0) {
        const baseDelay = 200; // Base 200ms delay
        const progressiveDelay = Math.min(j * 10, 1000); // Progressive delay up to 1s
        const randomDelay = Math.random() * 200; // Random 0-200ms
        const totalDelay = baseDelay + progressiveDelay + randomDelay;
        
        await page.waitForTimeout(totalDelay);
        step("item_scan_delay", { i, catName, j, delay: Math.round(totalDelay) });
      }
      
      const a = anchors.nth(j);
      const href = await a.evaluate((el: any) => {
        const anchor = el as HTMLAnchorElement;
        return anchor.getAttribute("href") || (anchor as any).href || "";
      });
      const dtid = await a.getAttribute("data-testid");

      let { sectionUuid, subsectionUuid, itemUuid, storeUuid: foundStoreUuid } = extractUuidsFromHref(href, dtid);
      if (!storeUuidFromItems && foundStoreUuid) storeUuidFromItems = foundStoreUuid;

      if (j < 3) {
        try {
          const pathOnly = href.replace(/^https?:\/\/[^/]+/i, "");
          const uuidsInHref = [...pathOnly.matchAll(UUID_RX)].map((m) => m[0]);
          console.log("HREF/DTID SAMPLE:", { href, dtid, uuidsInHref });
        } catch {}
      }

      if (!itemUuid || !sectionUuid || !subsectionUuid) {
        const itemHint = dtid?.match(UUID_RX)?.[0] ?? null;
        await a.scrollIntoViewIfNeeded().catch(() => {});
        const waitReqPromise = page
          .waitForRequest(
            (req: any) =>
              req.method() === "POST" &&
              req.url().includes("/_p/api/getMenuItemV1") &&
              (itemHint ? (req.postData() || "").includes(itemHint) : true),
            { timeout: 8000 }
          )
          .catch(() => null);

        // Add delay before clicking to avoid rate limiting
        await page.waitForTimeout(300 + Math.random() * 200);
        
        await Promise.allSettled([a.click({ force: true }), waitReqPromise]);
        const req = await waitReqPromise;
        if (req) {
          try {
            const body = (req as any).postDataJSON?.() as any;
            if (body && typeof body === "object") {
              itemUuid = body?.menuItemUuid || itemUuid;
              sectionUuid = body?.sectionUuid || sectionUuid;
              subsectionUuid = body?.subsectionUuid || subsectionUuid;
              if (!storeUuidFromItems && typeof body?.storeUuid === "string") {
                storeUuidFromItems = body.storeUuid;
              }
            }
          } catch {}
        }

        const close = page.locator("[aria-label='Close'], button:has-text('Close')");
        if ((await close.count()) > 0) await close.first().click().catch(() => {});
      }

      let name = null;
      const nameEl = a.locator('span[data-testid="rich-text"]').first();
      if (await nameEl.count() > 0) name = (await nameEl.innerText()).trim();

      let priceText: string | null = null;
      const priceEl = a.locator('span[data-testid="rich-text"]:has-text("$")');
      if (await priceEl.count() > 0) priceText = (await priceEl.innerText()).trim();

      const textCol = a.locator('div:has(span[data-testid="rich-text"]):has(span:not([data-testid]))').first();
      let desc: string | null = null;
      const nonRichRaw: string[] = await textCol.locator('span:not([data-testid])').allInnerTexts();
      const nonRichClean: string[] = nonRichRaw.map((t: string) => t.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()).filter((t: string) => t.length > 0);
      if (nonRichClean.length) {
        const sorted: string[] = [...nonRichClean].sort((a: string, b: string) => b.length - a.length);
        desc = sorted[0];
      }
      if (!desc) {
        const PRICE_RX: RegExp = /(\$|€|£|¥|₹|₩|₱|₪|R\$|S\/.|\bUSD\b|\bCOP\b|\bMXN\b|\bCLP\b|\bPEN\b|\bBRL\b)\s*\d/;
        const rich: string[] = (await textCol.locator('span[data-testid="rich-text"]').allInnerTexts()).map((t: string) => t.trim()).filter((t: string) => t.length > 0);
        const isJunk = (t: string): boolean => t === '•' || /^\d+%/.test(t) || /\(\d+\)/.test(t);
        const found: string | undefined = rich.find((t: string) => t !== name && !PRICE_RX.test(t) && !isJunk(t));
        desc = found ?? null;
      }

      let img: string | null = null;
      const imgLoc = a.locator("img");
      if ((await imgLoc.count()) > 0) img = (await imgLoc.first().getAttribute("src")) || null;

      const record = {
        name,
        description_card: desc,
        price_card: priceText,
        image_card: img,
        item_uuid: itemUuid,
        section_uuid: sectionUuid,
        subsection_uuid: subsectionUuid,
        href,
      };
      
      catItems.push(record);
      if (itemUuid && sectionUuid && subsectionUuid) {
        allItems.push(record);
      }
    }

    categories.push({ name: catName, items: catItems });
    sectionsProcessed += 1;
    itemsDiscovered += catItems.length;
    step("category_completed", { i, catName, itemsInCategory: catItems.length, sectionsProcessed, itemsDiscovered });
    if (jobId) updateJob(jobId, { stage: 'scanning_items', sectionsProcessed, itemsDiscovered });
    
    // Add delay between sections to avoid rate limiting
    if (i < nSections - 1) {
      const sectionDelay = 500 + Math.random() * 300;
      await page.waitForTimeout(sectionDelay);
      step("section_delay", { i, catName, delay: Math.round(sectionDelay) });
    }
  }

  step("collect_categories_complete", { 
    totalCategories: categories.length, 
    totalItems: allItems.length, 
    sectionsProcessed, 
    itemsDiscovered 
  });
  return { categories, allItems, storeUuidFromItems };
}

function toAbsoluteUrl(baseUrl: string, href: string): string {
  try {
    const abs = new URL(href, baseUrl);
    return abs.toString();
  } catch {
    if (href.startsWith('/')) return (baseUrl.replace(/\/$/, '')) + href;
    return href;
  }
}

async function fetchItemDetailViaClick(page: any, item: any, baseUrl: string): Promise<any | null> {
  try {
    const absUrl = toAbsoluteUrl(baseUrl, String(item.href || ''));
    if (!absUrl) return null;
    const respPred = (resp: any) => resp.request().method() === "POST" && resp.url().includes("/_p/api/getMenuItemV1");
    const waitForResp = page.waitForResponse(respPred, { timeout: 15000 }).catch(() => null);
      await Promise.allSettled([
      page.goto(absUrl, { waitUntil: "domcontentloaded" }),
        waitForResp,
      ]);
    // Try to click accept if banner appears (defensive)
    await acceptCookiesIfPresent(page).catch(() => {});
      const resp = await waitForResp;
    if (resp) {
      try {
        const bodyText = resp.request().postData() || '';
        const matches = bodyText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
        if (item.item_uuid && !matches.includes(String(item.item_uuid))) {
          const json = await resp.json().catch(() => null);
          const maybeUuid = json?.menuItemUuid || json?.data?.menuItemUuid || null;
          if (maybeUuid && String(maybeUuid) !== String(item.item_uuid)) return null;
          return json;
        }
        return await resp.json().catch(() => null);
          } catch {}
        }
      } catch {}
  return null;
}

async function fetchAllDetailsByClick(
  page: any,
  allItems: any[],
  step: StepFn
): Promise<Record<string, any>> {
  const detailsByItem: Record<string, any> = {};
  // Serial per page; UI clicks conflict if parallelized on one page
  const concurrency = 1;
  let processed = 0;
  let success = 0;
  let fail = 0;

  for (let i = 0; i < allItems.length; i += concurrency) {
    const chunk = allItems.slice(i, i + concurrency);
    await Promise.all(chunk.map(async (it) => {
      const raw = await fetchItemDetailViaClick(page, it, page.url());
      processed += 1;
      if (raw) { detailsByItem[it.item_uuid] = raw; success += 1; } else { fail += 1; }
    }));
    step("details_progress", { processed, success, fail, remaining: allItems.length - processed });
  }

  step("details_fetched", { attempted: allItems.length, success, fail });
  return detailsByItem;
}

async function fetchAllDetailsByClickConcurrent(
  context: any,
  items: any[],
  targetUrl: string,
  step: StepFn,
  workers = 4,
  jobId?: string
): Promise<{ detailsByItem: Record<string, any>; failedItems: any[] }> {
    const detailsByItem: Record<string, any> = {};
  const failedItems: any[] = [];
  if (!items.length) return { detailsByItem, failedItems };

  let processed = 0;
      let success = 0;
      let fail = 0;
  let idx = 0;
  const next = () => (idx < items.length ? idx++ : -1);

  const isCancelled = () => (jobId ? (getJob(jobId)?.cancelRequested === true) : false);

  const makeWorker = async (wid: number) => {
    const page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await acceptCookiesIfPresent(page).catch(() => {});
    
    // Add request throttling for this worker
    await page.route('**/*', async (route: any) => {
      await new Promise(resolve => setTimeout(resolve, 150 + Math.random() * 100));
      route.continue();
    });
    
    for (;;) {
      if (isCancelled()) break;
      const i = next();
      if (i === -1) break;
      
      // Add progressive delay between items to avoid rate limiting
      if (i > 0) {
        const delay = 200 + (i % 10) * 50 + Math.random() * 100;
        await page.waitForTimeout(delay);
      }
      
      const it = items[i];
      const raw = await fetchItemDetailViaClick(page, it, targetUrl);
          processed += 1;
      if (raw) { detailsByItem[it.item_uuid] = raw; success += 1; } else { fail += 1; failedItems.push(it); }
      if (processed % 10 === 0 || i === items.length - 1) {
        step("details_progress", { processed, success, fail, remaining: items.length - processed, worker: wid });
      }
    }
    await page.close().catch(() => {});
  };

  const count = Math.max(1, Math.min(workers, items.length));
  await Promise.all(Array.from({ length: count }, (_, k) => makeWorker(k)));
  step("details_fetched", { attempted: items.length, success, fail, workers: count });
  return { detailsByItem, failedItems };
}

function inferStoreUuidFromItems(items: any[]): string | null {
  for (const it of items) {
    if (typeof it.store_uuid === 'string' && it.store_uuid) return it.store_uuid;
  }
  return null;
}

function buildScraped(categories: any[], storeName: string | null, storeUuid: string | null) {
    const scraped = {
      store: { name: storeName || "Restaurant" },
    categories: categories.map((cat: any, idx: number) => ({
        id: String(idx),
        title: cat.name,
        items: cat.items.map((item: any, j: number) => ({
          id: String(item.item_uuid || `${idx}-${j}`),
          title: item.name || "",
          description: item.description_card || "",
                     price: item.price_card
          ? { amount: parseFloat(String(item.price_card).replace(/[^0-9.]/g, "")), currency_code: "USD" }
             : undefined,
          image_url: item.image_card,
          item_uuid: item.item_uuid || null,
          section_uuid: item.section_uuid || null,
          subsection_uuid: item.subsection_uuid || null,
          store_uuid: item.store_uuid || storeUuid || null,
          detail_raw: item.detail_raw || null,
        })),
      })),
    };
  const totalItems = categories.reduce((acc: number, c: any) => acc + (c.items?.length || 0), 0);
  return { scraped, totalItems };
}

export async function POST(req: Request) {
  let browser: Browser | null = null;
  const startedAt = Date.now();
  const debug: any = { steps: [] as any[], meta: {} as any };
  // read jobId if provided by client so they can poll concurrently
  let initialBody: any = null;
  try { initialBody = await req.json(); } catch {}
  const providedJobId = initialBody?.jobId ? String(initialBody.jobId) : undefined;
  const jobId = createJob(providedJobId);
  const step = (name: string, data?: any) => {
    const timestamp = Date.now() - startedAt;
    console.log(`[${timestamp}ms] STEP: ${name}`, data || '');
    debug.steps.push({ t: timestamp, name, ...(data ? { data } : {}) });
  };
  try {
    const body = initialBody as ScrapeRequest;
    const url = body?.url;
    const fast = Boolean(body?.fast);
    const maxItems = Number.isFinite(body?.maxItems as any) ? Math.max(1, Math.floor(body!.maxItems!)) : undefined;
    const timeoutMs = Number.isFinite(body?.timeoutMs as any) ? Math.max(10000, Math.floor(body!.timeoutMs!)) : 60000;
    if (!url || typeof url !== "string") {
      errorJob(jobId, "invalid_request");
      return NextResponse.json({ error: "Provide 'url' in JSON body", debug: { jobId } }, { status: 400 });
    }

    const { latitude, longitude } = parseLatLngFromUrl(url);
    step("parsed_url", { latitude, longitude, fast, maxItems, timeoutMs });
    updateJob(jobId, { message: 'launching', stage: 'navigating', meta: { url, fast, maxItems, timeoutMs } });

    let browser: Browser | null = null;
    browser = await launchChromium();
    const contextArgs: Parameters<typeof browser.newContext>[0] = {
      viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      // Add some delays to be more respectful
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1'
      }
    };
    if (latitude != null && longitude != null) {
      Object.assign(contextArgs, { geolocation: { latitude, longitude }, permissions: ["geolocation"] });
    }
    const context = await browser.newContext(contextArgs);
    const page = await context.newPage();
    
    // Add request interception to slow down requests
    await page.route('**/*', async (route) => {
      // Add a small delay to be more respectful
      await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));
      route.continue();
    });
    
    step("context_ready");

    const targetUrl = sanitizeUberUrl(url);
    
    // Try to navigate with retry logic for rate limiting
    let navigationSuccess = false;
    let retryCount = 0;
    const maxNavRetries = 3;
    
    while (!navigationSuccess && retryCount < maxNavRetries) {
      try {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        const content = await page.content();
        
        // Check if we got rate limited
        if (content.includes('too many requests') || content.includes('rate limit')) {
          throw new Error("Rate limited");
        }
        
        navigationSuccess = true;
        step("navigated", { url: page.url(), retryCount });
      } catch (error: any) {
        retryCount++;
        if (error.message.includes('Rate limited') || error.message.includes('timeout')) {
          if (retryCount < maxNavRetries) {
            const delay = Math.pow(2, retryCount) * 1000; // Exponential backoff
            step("navigation_retry", { retryCount, delay, error: error.message });
            await page.waitForTimeout(delay);
          } else {
            throw new Error(`Failed to navigate after ${maxNavRetries} retries: ${error.message}`);
          }
        } else {
          throw error;
        }
      }
    }

    updateJob(jobId, { stage: 'scanning_categories', message: 'scanning_categories' });
    const { storeName } = await analyzeAndPreparePage(page, url, step);

    const { sections, nSections, selectedSelector } = await detectSections(page, step);
    step("sections_found", { nSections, selectedSelector });
    updateJob(jobId, { stage: 'scanning_items', sectionsTotal: nSections, sectionsProcessed: 0, itemsDiscovered: 0, message: 'scanning_items' });

    const { categories, allItems, storeUuidFromItems } = await collectCategories(page, sections, nSections, startedAt, step, jobId);
    if (getJob(jobId)?.cancelRequested) {
      markCancelled(jobId, { stage: 'cancelled', message: 'cancelled_during_scan' });
      return NextResponse.json({ raw: { jobId, scraped: { store: { name: null }, categories: [] }, failedItems: [] }, normalized: null, debug });
    }
    const totalItems = categories.reduce((acc: number, c: any) => acc + (c.items?.length || 0), 0);
    step("items_collected", { totalItems });
    updateJob(jobId, { total: allItems.length, message: 'items_collected', stage: 'items_collected' });

    let storeUuid = inferStoreUuidFromItems(allItems) || storeUuidFromItems || null;
    step("store_uuid_detected", { storeUuidFound: Boolean(storeUuid), storeUuid });

    step("starting_details_fetch");
    updateJob(jobId, { stage: 'fetching_details', message: 'fetching_details', processed: 0, success: 0, fail: 0 });
    const workerCount = 3; // Reduced to be more respectful and avoid rate limiting
    let { detailsByItem, failedItems } = await fetchAllDetailsByClickConcurrent(context, allItems, targetUrl, (name, data) => {
      step(name, data);
      if (name === 'details_progress') {
        updateJob(jobId, {
          message: 'fetching_details',
          stage: 'fetching_details',
          processed: data?.processed ?? 0,
          success: data?.success ?? 0,
          fail: data?.fail ?? 0,
          total: allItems.length,
        });
      }
    }, workerCount, jobId);

    if (getJob(jobId)?.cancelRequested) {
      markCancelled(jobId, {
        processed: getJob(jobId)?.processed,
        success: getJob(jobId)?.success,
        fail: getJob(jobId)?.fail,
        total: allItems.length,
        failedItems: failedItems.map((it) => ({ id: it.item_uuid || null, href: it.href, title: it.name || null })),
      });
      const { scraped } = buildScraped(categories, storeName, inferStoreUuidFromItems(allItems) || null);
      return NextResponse.json({ raw: { jobId, scraped, failedItems }, normalized: normalizeScrapedToMenuData(scraped), debug });
    }

    const maxRetries = 10;
    for (let r = 1; r <= maxRetries && failedItems.length > 0; r++) {
      if (getJob(jobId)?.cancelRequested) break;
      step("details_retry_round", { round: r, pending: failedItems.length });
      const retryItems = failedItems;
      failedItems = [];
      const retryTotal = retryItems.length;
      updateJob(jobId, { message: `retry_round_${r}`, stage: 'retrying_details', retryRound: r, retryPending: retryTotal, processed: 0, success: 0, fail: 0, total: retryTotal });
      const retryWorkers = Math.max(1, Math.floor(workerCount / 2));
      const { detailsByItem: got, failedItems: stillFailed } = await fetchAllDetailsByClickConcurrent(context, retryItems, targetUrl, (name, data) => {
        step(name, data);
        if (name === 'details_progress') {
          updateJob(jobId, {
            message: `retry_round_${r}`,
            stage: 'retrying_details',
            processed: data?.processed ?? 0,
            success: data?.success ?? 0,
            fail: data?.fail ?? 0,
            total: retryTotal,
          });
        }
      }, retryWorkers, jobId);
      for (const [k, v] of Object.entries(got)) detailsByItem[k] = v;
      failedItems = stillFailed;
    }

    for (const cat of categories) {
      for (const it of cat.items) {
        if (storeUuid) it.store_uuid = storeUuid;
        it.detail_raw = detailsByItem[it.item_uuid] || null;
      }
    }

    const { scraped } = buildScraped(categories, storeName, storeUuid);

    const output = {
      jobId,
      scraped,
      storeUuid,
      totalItems,
      categories: categories.length,
      failedItems: failedItems.map((it) => ({ id: it.item_uuid || null, href: it.href, title: it.name || null })),
    };

    completeJob(jobId, {
      message: 'completed',
      stage: 'completed',
      processed: allItems.length,
      success: allItems.length - failedItems.length,
      fail: failedItems.length,
      total: allItems.length,
      failedItems: output.failedItems,
    });

    const normalized = normalizeScrapedToMenuData(scraped);
    return NextResponse.json({ raw: output, normalized, debug });
  } catch (err: any) {
    const message = err?.message || String(err);
    errorJob(jobId, message);
    try {
      const pageUrl = (await (browser as any)?._defaultContext?._pages?.[0]?.url?.()) || undefined;
      if (pageUrl) step("error_page_url", { url: pageUrl });
    } catch {}
    return NextResponse.json({ error: message, debug: { jobId } }, { status: 500 });
  } finally {
    try { await (browser as any)?.close(); } catch {}
  }
}



