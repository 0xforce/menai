import { UUID_RX } from "./constants";

type LatLng = { latitude: number | null; longitude: number | null };

export function parseLatLngFromUrl(url: string): LatLng {
  console.log(`parseLatLngFromUrl: parsing URL: ${url}`);
  try {
    const u = new URL(url);
    const latRaw = u.searchParams.get("latitude");
    const lngRaw = u.searchParams.get("longitude");
    console.log(`parseLatLngFromUrl: found query params - lat: ${latRaw}, lng: ${lngRaw}`);
    
    if (latRaw && lngRaw) {
      const latitude = Number(latRaw);
      const longitude = Number(lngRaw);
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        console.log(`parseLatLngFromUrl: returning coordinates from query params: ${latitude}, ${longitude}`);
        return { latitude, longitude };
      }
    }
    
    const pl = u.searchParams.get("pl");
    console.log(`parseLatLngFromUrl: found 'pl' param: ${pl}`);
    if (pl) {
      try {
        const decoded = decodeURIComponent(pl);
        console.log(`parseLatLngFromUrl: decoded 'pl' param: ${decoded}`);
        if (decoded.trim().startsWith("{")) {
          const obj = JSON.parse(decoded);
          const latitude = typeof obj.latitude === "number" ? obj.latitude : null;
          const longitude = typeof obj.longitude === "number" ? obj.longitude : null;
          if (latitude != null && longitude != null) {
            console.log(`parseLatLngFromUrl: returning coordinates from 'pl' param: ${latitude}, ${longitude}`);
            return { latitude, longitude };
          }
        }
      } catch (error) {
        console.log(`parseLatLngFromUrl: error parsing 'pl' param: ${error}`);
      }
    }
  } catch (error) {
    console.log(`parseLatLngFromUrl: error parsing URL: ${error}`);
  }
  console.log(`parseLatLngFromUrl: no coordinates found, returning nulls`);
  return { latitude: null, longitude: null };
}

export function extractUuidsFromHref(
  href: string | null | undefined,
  dataTestId?: string | null
): { sectionUuid: string | null; subsectionUuid: string | null; itemUuid: string | null; storeUuid: string | null } {
  const raw = href ?? "";
  // drop origin + query + hash
  const path = raw.replace(/^https?:\/\/[^/]+/i, "").split("?")[0].split("#")[0];

  // find ALL UUIDs in the path
  const matches = [...path.matchAll(UUID_RX)].map((m) => m[0]);

  if (matches.length >= 3) {
    const [sectionUuid, subsectionUuid, itemUuid] = matches.slice(-3);
    return { sectionUuid, subsectionUuid, itemUuid, storeUuid: null };
  }

  // Fallback: try to parse from modctx query parameter (percent-encoded JSON)
  try {
    const query = raw.split("?")[1] || "";
    if (query) {
      const params = new URLSearchParams(query);
      const modctx = params.get("modctx");
      if (modctx) {
        // modctx can be double-encoded
        let decoded = decodeURIComponent(modctx);
        if (/^%7B/i.test(decoded) || /%7B/i.test(decoded)) {
          decoded = decodeURIComponent(decoded);
        }
        const obj = JSON.parse(decoded);
        const sectionUuid = obj?.sectionUuid ?? null;
        const subsectionUuid = obj?.subsectionUuid ?? null;
        const itemUuid = obj?.itemUuid ?? obj?.menuItemUuid ?? null;
        const storeUuid = obj?.storeUuid ?? null;
        if (itemUuid || storeUuid) {
          return { sectionUuid, subsectionUuid, itemUuid, storeUuid };
        }
      }
    }
  } catch {}

  // Fallback: the anchor's data-testid is like "store-item-<itemUuid>"
  if (dataTestId && /store-item-/i.test(dataTestId)) {
    const one = dataTestId.match(UUID_RX)?.[0] || null;
    if (one) return { sectionUuid: null, subsectionUuid: null, itemUuid: one, storeUuid: null };
  }

  return { sectionUuid: null, subsectionUuid: null, itemUuid: null, storeUuid: null };
}


