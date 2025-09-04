import { Page } from "playwright";

export async function autoscrollAll(page: Page, pauseMs = 250, maxPasses = 50): Promise<void> {
  console.log('Starting autoscroll with max passes:', maxPasses);
  let lastCount = -1;
  for (let i = 0; i < maxPasses; i += 1) {
    console.log(`Autoscroll pass ${i + 1}/${maxPasses}`);
    await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
    await page.waitForTimeout(pauseMs);
    
    // Count items using multiple selectors to handle different layouts
    const primaryCount = await page.locator('a[data-testid^="store-item-"]').count();
    const fallbackCount = await page.locator('a[data-testid*="store-item"], a[href*="/store/"]').count();
    const count = Math.max(primaryCount, fallbackCount);
    
    console.log(`Found ${count} items after pass ${i + 1} (primary: ${primaryCount}, fallback: ${fallbackCount})`);
    if (count === lastCount) {
      console.log('No new items found, stopping autoscroll');
      break;
    }
    lastCount = count;
  }
  console.log('Autoscroll completed');
}

export async function textOrNone(scope: Page | ReturnType<Page["locator"]>, selector: string): Promise<string | null> {
  console.log(`textOrNone: checking selector "${selector}"`);
  const loc = (scope as Page).locator ? (scope as Page).locator(selector) : (scope as any).locator(selector);
  const cnt = await loc.count();
  console.log(`textOrNone: found ${cnt} elements with selector "${selector}"`);
  if (cnt) {
    const txt = (await loc.first().innerText()).trim();
    console.log(`textOrNone: extracted text: "${txt}"`);
    return txt || null;
  }
  console.log(`textOrNone: no elements found, returning null`);
  return null;
}

export async function extractCategoryName(scope: Page | ReturnType<Page["locator"]>): Promise<string> {
  console.log('extractCategoryName: trying selectors...');
  
  const headerSelectors = [
    'h3[data-testid*="rich-text"]',
    'h3',
    'div[data-testid="catalog-section-header"]',
    'div[data-testid="catalog-section-title"]',
    '[data-testid="rich-text"]',
    'h1', 'h2', 'h4',
    '[data-testid*="category"]',
    '[data-testid*="tab"]',
    '.category-name',
    '.section-title',
    '.menu-category'
  ];
  
  for (const sel of headerSelectors) {
    console.log(`extractCategoryName: trying header selector "${sel}"`);
    const txt = await textOrNone(scope as any, sel);
    if (txt) {
      console.log(`extractCategoryName: found header text with selector "${sel}": "${txt}"`);
      return txt;
    }
  }
  
  console.log('extractCategoryName: no header found, trying to infer from items...');
  const firstItem = (scope as any).locator('a, button, [role="button"]').first();
  if (await firstItem.count() > 0) {
    try {
      const parentText = await firstItem.locator('xpath=ancestor::*[contains(text(), "Menu") or contains(text(), "Category") or contains(text(), "Section") or contains(text(), "Food") or contains(text(), "Dish") or contains(text(), "Item")]').first().innerText();
      if (parentText) {
        console.log(`extractCategoryName: inferred category from parent context: "${parentText}"`);
        return parentText.split('\n')[0].trim();
      }
    } catch (e) {
      console.log('extractCategoryName: error looking for parent context:', e);
    }
  }
  
  console.log('extractCategoryName: no category name found, returning "Untitled"');
  return "Untitled";
}

export async function acceptCookiesIfPresent(page: Page): Promise<boolean> {
  console.log('acceptCookiesIfPresent: checking for cookie buttons...');
  const candidates = [
    "button:has-text('Accept all')",
    "button:has-text('Accept All')",
    "button:has-text('Accept')",
    "button:has-text('I agree')",
    "button:has-text('Allow all')",
    "button:has-text('Got it')",
  ];
  for (const sel of candidates) {
    console.log(`acceptCookiesIfPresent: checking for button "${sel}"`);
    const btn = page.locator(sel).first();
    const count = await btn.count();
    console.log(`acceptCookiesIfPresent: found ${count} buttons with "${sel}"`);
    if (count > 0) {
      try {
        console.log(`acceptCookiesIfPresent: clicking button "${sel}"`);
        await btn.click({ force: true });
        await page.waitForTimeout(300);
        console.log(`acceptCookiesIfPresent: successfully clicked cookie button`);
        return true;
      } catch (error) {
        console.log(`acceptCookiesIfPresent: error clicking button "${sel}": ${error}`);
      }
    }
  }
  console.log('acceptCookiesIfPresent: no cookie buttons found or clicked');
  return false;
}

export async function waitForAnySelector(page: Page, selectors: string[], timeoutMs: number): Promise<string | null> {
  console.log('Waiting for selectors:', selectors);
  const end = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < end) {
    attempts++;
    console.log(`Selector check attempt ${attempts}...`);
    for (const sel of selectors) {
      const loc = page.locator(sel);
      const count = await loc.count();
      console.log(`Selector "${sel}": ${count} elements found`);
      if (count > 0) {
        try {
          console.log(`Waiting for "${sel}" to be visible...`);
          await loc.first().waitFor({ state: "visible", timeout: 1000 });
          console.log(`Selector "${sel}" found and visible!`);
        } catch (e) {
          console.log(`Selector "${sel}" visibility wait failed:`, e);
        }
        return sel;
      }
    }
    const remaining = Math.ceil((end - Date.now()) / 1000);
    console.log(`No selectors found, waiting 500ms... (${remaining}s remaining)`);
    await page.waitForTimeout(500);
  }
  console.log('Timeout reached, no selectors found');
  return null;
}


