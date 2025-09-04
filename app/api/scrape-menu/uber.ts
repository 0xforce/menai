import type { Page } from "playwright-core";

export async function fetchItemDetailV1(page: Page, args: { storeUuid: string; itemUuid: string; sectionUuid: string; subsectionUuid: string }): Promise<any> {
  console.log(`fetchItemDetailV1 called with:`, {
    storeUuid: args.storeUuid,
    itemUuid: args.itemUuid,
    sectionUuid: args.sectionUuid,
    subsectionUuid: args.subsectionUuid
  });
  
  const body = {
    itemRequestType: "ITEM",
    cbType: "EATER_ENDORSED",
    contextReferences: [
      {
        type: "GROUP_ITEMS",
        payload: {
          type: "groupItemsContextReferencePayload",
          groupItemsContextReferencePayload: { catalogSectionUUID: "" },
        },
      },
    ],
    pageContext: "UNKNOWN",
        menuItemUuid: args.itemUuid,
        sectionUuid: args.sectionUuid,
        subsectionUuid: args.subsectionUuid,
        storeUuid: args.storeUuid,
  };

  console.log('Making API request with body:', JSON.stringify(body, null, 2));

  const js = async ({ body: b }: { body: any }) => {
    console.log('Executing fetch in page context...');
    const r = await fetch("/_p/api/getMenuItemV1", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "x" },
      body: JSON.stringify(b),
    });
    console.log(`API response status: ${r.status}`);
    const result = await r.json();
    console.log('API response received, size:', JSON.stringify(result).length);
    return result;
  };

  const result = await page.evaluate(js as any, { body });
  console.log('fetchItemDetailV1 completed successfully');
  return result;
}

// Recursively search any JSON-like structure for a string storeUuid
export function findStoreUuidDeep(input: any): string | null {
  try {
    const stack: any[] = [input];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur) continue;
      if (typeof cur === "string") continue;
      if (Array.isArray(cur)) {
        for (const v of cur) stack.push(v);
      } else if (typeof cur === "object") {
        for (const [k, v] of Object.entries(cur)) {
          if (k === "storeUuid" && typeof v === "string") {
            return v as string;
          }
          stack.push(v);
        }
      }
    }
  } catch {}
  return null;
}


