// app/api/export-to-sheets/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { google } from "googleapis";
import { getOAuthClient, getStoredTokenFromCookie, ensureAccessToken } from "@/app/lib/googleOAuth";
import type { StoredToken } from "@/app/lib/googleOAuth";

export const runtime = "nodejs";

// ========= ENV =========
// 1) Share your template file so user tokens can read it (e.g., anyone-with-link view or share to users).
// 2) Put this in your environment:
const TEMPLATE_SPREADSHEET_ID = process.env.TEMPLATE_SPREADSHEET_ID!; // template to copy

function validateEnv(): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!TEMPLATE_SPREADSHEET_ID) missing.push("TEMPLATE_SPREADSHEET_ID");
  return { ok: missing.length === 0, missing };
}

// ========= AUTH =========
async function userSheetsClients(req: Request) {
  const cookieStore = await cookies();
  const stored = getStoredTokenFromCookie(cookieStore);
  if (!stored?.refresh_token) {
    throw new Error("not_authenticated");
  }
  const origin = new URL(req.url).origin;
  const oauth2 = getOAuthClient(origin);
  oauth2.setCredentials({ refresh_token: stored.refresh_token, access_token: stored.access_token || undefined, expiry_date: stored.expiry_date });
  const refreshed = await ensureAccessToken(oauth2);
  const drive = google.drive({ version: "v3", auth: oauth2 });
  const sheets = google.sheets({ version: "v4", auth: oauth2 });
  return { drive, sheets, updatedCredentials: refreshed.updatedCredentials as StoredToken | undefined };
}

// ========= HELPERS =========
type Scraped = {
  store: { name: string };
  categories: Array<{
    id: string;
    title: string; // category name
    items: Array<{
      title: string;
      description?: string;
      price?: { amount: number; currency_code?: string };
      detail_raw?: any;
    }>;
  }>;
};

// Normalize & dedupe modifier groups from Uber customizationsList
type ModGroup = {
  title: string;
  required: "Required" | "Optional" | "Optional Force Show";
  min?: number | null;
  max?: number | null;
  options: Array<{ title: string; upcharge?: number | null }>;
};

function buildModifierGroups(scraped: Scraped): Map<string, ModGroup> {
  const groups = new Map<string, ModGroup>();
  const norm = (s: string) => s.trim().toLowerCase();

  for (const cat of scraped.categories || []) {
    for (const it of cat.items || []) {
      const list: any[] = it.detail_raw?.data?.customizationsList || [];
      for (const g of list) {
        if (!g?.title) continue;
        const key = norm(g.title);
        const required = (g.minPermitted ?? 0) > 0 ? "Required" : "Optional";
        const min = Number.isFinite(g.minPermitted) ? g.minPermitted : null;
        const max = Number.isFinite(g.maxPermitted) ? g.maxPermitted : null;

        const options = Array.isArray(g.options) ? g.options.map((o: any) => ({
          title: String(o?.title || "").trim(),
          upcharge: Number.isFinite(o?.price) ? Number(o.price) / 100 : null,
        })).filter((o: any) => o.title) : [];

        if (!groups.has(key)) {
          groups.set(key, { title: g.title.trim(), required, min, max, options });
        } else {
          // merge options (by title)
          const cur = groups.get(key)!;
          const seen = new Set(cur.options.map(o => o.title.toLowerCase()));
          for (const o of options) {
            if (!seen.has(o.title.toLowerCase())) {
              cur.options.push(o);
              seen.add(o.title.toLowerCase());
            }
          }
          // widen min/max if needed
          cur.min = cur.min ?? min;
          cur.max = Math.max(cur.max ?? 0, max ?? 0);
          if (required === "Required") cur.required = "Required";
        }
      }
    }
  }
  return groups;
}

// Find sheet by name → {sheetId, rowCount, columnCount}
async function getSheetMeta(sheets: any, spreadsheetId: string, title: string) {
  const res = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = res.data.sheets?.find((s: any) => s.properties?.title === title)?.properties;
  if (!sheet) throw new Error(`Sheet "${title}" not found in template copy.`);
  return {
    sheetId: sheet.sheetId!,
    rowCount: sheet.gridProperties?.rowCount ?? 1000,
    columnCount: sheet.gridProperties?.columnCount ?? 26,
  };
}

// Find header column indexes by header text (row number is template-specific; we scan first 50 rows)
async function findHeaders(sheets: any, spreadsheetId: string, sheetTitle: string, headerTexts: string[]) {
  const range = `${sheetTitle}!A1:Z50`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows: string[][] = (res.data.values as string[][]) || [];
  let headerRow = -1;
  let map: Record<string, number> = {};

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r].map(v => (v || "").trim());
    const hits = headerTexts.filter(h => row.includes(h));
    if (hits.length >= Math.ceil(headerTexts.length * 0.6)) {
      headerRow = r;
      for (const h of headerTexts) {
        map[h] = row.findIndex(v => v === h);
      }
      break;
    }
  }
  if (headerRow === -1) throw new Error(`Could not find header row on "${sheetTitle}".`);
  return { headerRow, map };
}

// Duplicate a column (copy data-validation and formatting) – used to add more “Asignar grupos…” columns
function copyColumnRequest(sheetId: number, sourceCol: number, destinationCol: number) {
  return {
    copyPaste: {
      source: { sheetId, startRowIndex: 0, endRowIndex: 9999, startColumnIndex: sourceCol, endColumnIndex: sourceCol + 1 },
      destination: { sheetId, startRowIndex: 0, endRowIndex: 9999, startColumnIndex: destinationCol, endColumnIndex: destinationCol + 1 },
      pasteType: "PASTE_NORMAL",
      pasteOrientation: "NORMAL",
    },
  };
}

// A1 helper
function A1(colIdx: number, rowIdx: number) {
  const letters = (() => {
    let n = colIdx + 1, s = "";
    while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  })();
  return `${letters}${rowIdx + 1}`;
}

// --- constants for your "Create Modifier Groups" sheet ---
const MODS_SHEET = "Create Modifier Groups";
const HEADER_ROW = 20;                 // orange header row number (1-based)
const FIRST_DATA_ROW = HEADER_ROW + 1; // first row where data goes (21)
const START_COL = "B";                 // columns B..G in your template
const END_COL   = "G";
const OPTION_ROWS_PER_BLOCK = 15;      // the template gives 15 option rows per group
const BLOCK_SPAN = 16;                 // 1 header + 15 option rows

// ---- helpers for structural changes (Sheets batchUpdate) ----
function insertRowsRequest(sheetId: number, atRow1: number, count: number) {
  return {
    insertDimension: {
      range: {
        sheetId,
        dimension: "ROWS",
        startIndex: atRow1 - 1,             // 0-based inclusive
        endIndex: atRow1 - 1 + count,       // 0-based exclusive
      },
      inheritFromBefore: true,
    },
  };
}

// copy **format only** of the single option row to a range (keeps dropdowns/borders)
function copyOptionRowFormatRequest(
  sheetId: number,
  srcRow1: number,        // 1-based: a row that already has the option-row format
  dstStartRow1: number,   // first destination row (1-based)
  dstEndRow1: number      // last destination row (1-based, inclusive)
) {
  return {
    copyPaste: {
      source: {
        sheetId,
        startRowIndex: srcRow1 - 1,
        endRowIndex: srcRow1,        // single row
        startColumnIndex: 1,         // B (A=0)
        endColumnIndex: 7,           // up to G (exclusive)
      },
      destination: {
        sheetId,
        startRowIndex: dstStartRow1 - 1,
        endRowIndex: dstEndRow1,     // exclusive
        startColumnIndex: 1,         // B
        endColumnIndex: 7,           // G (exclusive)
      },
      pasteType: "PASTE_FORMAT",
      pasteOrientation: "NORMAL",
    },
  };
}

// (optional) copy the FORMAT of a full 16-row block (header + 15 options) to another block start
function copyWholeBlockFormatRequest(sheetId: number, srcHeaderRow1: number, dstHeaderRow1: number) {
  return {
    copyPaste: {
      source: {
        sheetId,
        startRowIndex: srcHeaderRow1 - 1,
        endRowIndex: srcHeaderRow1 - 1 + BLOCK_SPAN,
        startColumnIndex: 1,   // B
        endColumnIndex: 7,     // G (exclusive)
      },
      destination: {
        sheetId,
        startRowIndex: dstHeaderRow1 - 1,
        endRowIndex: dstHeaderRow1 - 1 + BLOCK_SPAN,
        startColumnIndex: 1,
        endColumnIndex: 7,
      },
      pasteType: "PASTE_FORMAT",
      pasteOrientation: "NORMAL",
    },
  };
}

// normalize the "required/optional Force Show" label the sheet expects
function normalizeRequired(
  g: Pick<ModGroup, "required" | "min">
): "Required" | "Optional" | "Optional Force Show" {
  if (typeof g.required === "string") return g.required;
  if (g.required === true || (typeof g.min === "number" && g.min > 0)) return "Required";
  return "Optional Force Show";
}

// ========= MAIN HANDLER =========
export async function POST(req: Request) {
  const started = Date.now();
  const debug: any[] = [];
  const step = (name: string, data?: any) => debug.push({ t: Date.now() - started, name, ...(data ? { data } : {}) });
  try {
    const env = validateEnv();
    if (!env.ok) {
      return NextResponse.json(
        {
          error: `Missing Google env vars: ${env.missing.join(", ")}`,
          howToFix:
            "Add TEMPLATE_SPREADSHEET_ID to .env.local and restart. Ensure the template is shared so the user's account can read it (e.g., anyone-with-link viewer or shared to them).",
          debug,
        },
        { status: 500 }
      );
    }
    const { jobId, scraped, destinationFolderId } = (await req.json()) as { jobId: string; scraped: Scraped; destinationFolderId?: string | null };
    step('input_received', { hasJobId: !!jobId, store: scraped?.store?.name, categories: scraped?.categories?.length });
    if (!scraped?.store?.name) return NextResponse.json({ error: "Missing 'scraped.store.name'." }, { status: 400 });

    let drive, sheets; let updatedCredentials: StoredToken | undefined;
    try {
      ({ drive, sheets, updatedCredentials } = await userSheetsClients(req));
    } catch (e: any) {
      if (String(e?.message) === 'not_authenticated') {
        return NextResponse.json({ error: 'not_authenticated', message: 'Connect your Google account first.' }, { status: 401 });
      }
      throw e;
    }
    step('clients_ready', { drive: true, sheets: true });

    // Inspect destination folder if provided
    if (destinationFolderId) {
      try {
        const folderMeta = await drive.files.get({
          fileId: destinationFolderId,
          fields: 'id, name, driveId, parents, trashed',
          supportsAllDrives: true,
        });
        step('dest_folder_meta', { id: folderMeta.data.id, name: folderMeta.data.name, driveId: folderMeta.data.driveId, parents: folderMeta.data.parents, trashed: folderMeta.data.trashed });
      } catch (e: any) {
        step('dest_folder_meta_error', { message: e?.message, code: e?.code });
      }
    }

    // Inspect template meta quickly
    try {
      const tmplMeta = await drive.files.get({
        fileId: TEMPLATE_SPREADSHEET_ID,
        fields: 'id, name, driveId, parents',
        supportsAllDrives: true,
      });
      step('template_meta', { id: tmplMeta.data.id, name: tmplMeta.data.name, driveId: tmplMeta.data.driveId, parents: tmplMeta.data.parents });
    } catch (e: any) {
      step('template_meta_error', { message: e?.message, code: e?.code });
    }

    // 1) Copy template
    const copyName = `Menu - ${scraped.store.name}`;

    let copied;
    try {
      const parents = destinationFolderId ? [destinationFolderId] : undefined;
      step('copy_request', { parents: parents || [], supportsAllDrives: true });
      copied = await drive.files.copy({
        fileId: TEMPLATE_SPREADSHEET_ID,
        requestBody: {
          name: copyName,
          ...(parents ? { parents } : {}),
        },
        fields: "id, webViewLink",
        supportsAllDrives: true,
      } as any);
      step('copied_ok', { id: copied.data.id, webViewLink: copied.data.webViewLink });
    } catch (e: any) {
      const msg = e?.errors?.[0]?.message || e?.message || String(e);
      const reason = e?.errors?.[0]?.reason;
      const isQuota = /quota/i.test(msg) || reason === 'storageQuotaExceeded';
      if (isQuota) {
        step('copy_error_quota', { message: msg, reason });
        return NextResponse.json({
          error: "drive_quota_exceeded",
          message: msg,
          suggestions: [
            "Free space in the selected Drive folder",
            "Pick a different destination folder",
          ],
          debug,
        }, { status: 507 });
      }
      step('copy_error_other', { message: msg, reason });
      throw e;
    }
    const spreadsheetId = copied.data.id!;
    const spreadsheetUrl = copied.data.webViewLink;
    // Verify file is inside the requested folder; if not, attempt to move it
    if (destinationFolderId) {
      try {
        const meta = await drive.files.get({
          fileId: spreadsheetId,
          fields: 'id, parents, driveId',
          supportsAllDrives: true,
        });
        const parents: string[] = meta.data.parents || [];
        step('copied_meta', { parents, driveId: meta.data.driveId });
        if (!parents.includes(destinationFolderId)) {
          const removeParents = parents.join(',');
          await drive.files.update({
            fileId: spreadsheetId,
            addParents: destinationFolderId,
            removeParents,
            fields: 'id, parents',
            supportsAllDrives: true,
          } as any);
          step('moved_into_folder', { from: parents, to: destinationFolderId });
        }
      } catch {}
    }
    if (!spreadsheetUrl) {
      // fallback: build a generic link if webViewLink not returned
      // (happens if link sharing disabled in some orgs)
      // Consumers can still open in Drive by ID.
    }

    // 2) Sheet meta (adjust names to your template)
    const MENU_SHEET = "Creación de menús";               // change if your tab name differs
    const MODS_SHEET = "Creación de modificadores";       // change if your tab name differs
    const menuMeta = await getSheetMeta(sheets, spreadsheetId, MENU_SHEET);
    const modsMeta = await getSheetMeta(sheets, spreadsheetId, MODS_SHEET);

    // 3) Build modifier groups from your scraped JSON
    const groupsMap = buildModifierGroups(scraped);
    const groups = [...groupsMap.values()];

    // ── If you ever have MORE groups than pre-made blocks, append enough blocks at bottom.
    const existingBlocks = Math.max(0, Math.floor((modsMeta.rowCount - HEADER_ROW + 1) / BLOCK_SPAN));
    const blocksNeeded = groups.length;
    const blocksToAdd = Math.max(0, blocksNeeded - existingBlocks);

    const structuralRequests: any[] = [];

    if (blocksToAdd > 0) {
      // append full blocks at the very end of the sheet
      const appendAtRow = modsMeta.rowCount + 1;
      structuralRequests.push(insertRowsRequest(modsMeta.sheetId, appendAtRow, blocksToAdd * BLOCK_SPAN));

      // copy the format of the first block (rows 20..35) into each new block
      for (let i = 0; i < blocksToAdd; i++) {
        const dstHeaderRow = appendAtRow + i * BLOCK_SPAN;
        structuralRequests.push(copyWholeBlockFormatRequest(modsMeta.sheetId, HEADER_ROW, dstHeaderRow));
      }
    }

    // We’ll compute all group-specific inserts (for >15 options) and the write ranges now.
    type WriteBlock = { range: string; values: any[][] };
    const writes: WriteBlock[] = [];
    
    let writeRowMods = FIRST_DATA_ROW; // where the current group's first option row lives (B..G)

    for (const g of groups) {
      const options = g.options ?? [];
      const needed = Math.max(1, options.length);  // at least one row for the group header

      // If the group needs more than the template's 15 rows, insert extras at the block boundary.
      const extra = Math.max(0, needed - OPTION_ROWS_PER_BLOCK);
      const nextBlockHeaderRow = writeRowMods + OPTION_ROWS_PER_BLOCK; // current boundary

      if (extra > 0) {
        // Insert rows at the boundary so the next block (and all below) slide down
        structuralRequests.push(insertRowsRequest(modsMeta.sheetId, nextBlockHeaderRow, extra));
        // Ensure the inserted rows inherit the "option row" formatting
        structuralRequests.push(
          copyOptionRowFormatRequest(
            modsMeta.sheetId,
            writeRowMods,                          // copy from the first option row in this block
            nextBlockHeaderRow,                 // first inserted row
            nextBlockHeaderRow + extra - 1      // last inserted row
          )
        );
      }

      // Build the values for this group in B..G
      const rows: any[][] = [];
      for (let i = 0; i < needed; i++) {
        const opt = options[i];
        const up = opt?.upcharge;
        const upchargeCell: string | number = (up == null) ? "" : Number(up);
        rows.push([
          i === 0 ? (g.title ?? "") : "",                                               // B: group name (only on the 1st row)
          opt?.title ?? "",                                                             // C: option title
          upchargeCell,                                                                  // D: upcharge numeric; sheet formats as currency
          i === 0 ? normalizeRequired(g) : "",                                          // E: required/optional (only 1st row)
          i === 0 && g.min != null ? String(g.min) : "",                                // F: min
          i === 0 && g.max != null ? String(g.max) : "",                                // G: max
        ]);
      }

      const start = writeRowMods;
      const end = writeRowMods + needed - 1;
      writes.push({
        range: `${MODS_SHEET}!${START_COL}${start}:${END_COL}${end}`,
        values: rows,
      });
      step('mods_write_block', { group: g.title, startRow: start, endRow: end, options: options.length, extraRowsInserted: extra });

      // Advance to the next block's FIRST OPTION row:
      // one full block span (header + 15 option rows) plus any extra rows we inserted
      writeRowMods = writeRowMods + BLOCK_SPAN + extra;
    }

    // 1) Apply all structural operations in-order (adds blocks at bottom, inserts extra rows, copies formats)
    if (structuralRequests.length) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: structuralRequests },
      });
    }

    // 2) Write all group values (B..G) in one go
    if (writes.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: writes.map(w => ({ range: w.range, values: w.values })),
        },
      });
    }

    // 5) Prepare Menu sheet header mapping
    const headers = [
      "List Menu Items Here",
      "Precio básico ($)",
      "Descripción (opcional; esta información es visible para los clientes a través de Pedidos digitales)",
      "Nombre del grupo de menús",
      "Asignar grupos de modificadores (opcional)",
    ];
    const { headerRow, map } = await findHeaders(sheets, spreadsheetId, MENU_SHEET, headers);

    let colItem    = map["List Menu Items Here"]; 
    const colPrice   = map["Precio básico ($)"];
    const colDesc    = map["Descripción (opcional; esta información es visible para los clientes a través de Pedidos digitales)"];
    const colMenuGrp = map["Nombre del grupo de menús"];

    // Fallback if item column wasn't matched exactly
    if (!(typeof colItem === 'number' && colItem >= 0)) {
      try {
        const hdr = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${MENU_SHEET}!A${headerRow + 1}:ZZ${headerRow + 1}` });
        const vals: string[] = (hdr.data.values?.[0] as any[])?.map((x: any) => String(x || '').trim()) || [];
        const idx = vals.findIndex(v => v.toLowerCase().startsWith('list menu items here'));
        if (idx >= 0) colItem = idx;
      } catch {}
    }
    step('menu_header_map', { headerRow, colItem, colPrice, colDesc, colMenuGrp });

    // find all existing “Asignar grupos…” columns (there are 10 in template)
    let assignCols: number[] = [];
    Object.entries(map).forEach(([k, v]) => {
      if (k && typeof k === 'string' && k.toLowerCase().startsWith("asignar grupos de modificadores")) {
        if (typeof v === 'number' && v >= 0) assignCols.push(v);
      }
    });
    // Fallback: scan the header row directly for any columns starting with the phrase
    if (assignCols.length === 0) {
      try {
        const headerRes = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `${MENU_SHEET}!A${headerRow + 1}:ZZ${headerRow + 1}`,
        });
        const rowVals: string[] = (headerRes.data.values?.[0] as any[])?.map((x: any) => String(x || '')) || [];
        for (let i = 0; i < rowVals.length; i++) {
          const cell = rowVals[i].trim().toLowerCase();
          if (cell.startsWith('asignar grupos de modificadores')) assignCols.push(i);
        }
      } catch {}
    }
    assignCols.sort((a, b) => a - b);
    step('assign_cols_found', { assignCols });

    // Compute max groups per item to know if we need to add columns
    const allGroupCounts = scraped.categories.flatMap(c =>
      c.items.map(it => (it.detail_raw?.data?.customizationsList?.length || 0))
    );
    const maxGroupsForAnyItem = Math.max(0, ...allGroupCounts);
    let stillNeed = Math.max(0, maxGroupsForAnyItem - assignCols.length);

    if (stillNeed > 0 && assignCols.length > 0) {
      // duplicate last assignment column to the right (copies data validation)
      const last = assignCols[assignCols.length - 1];
      if (typeof last === 'number' && last >= 0) {
        const requests = [] as any[];
        for (let k = 0; k < stillNeed; k++) {
          requests.push(copyColumnRequest(menuMeta.sheetId, last, last + 1 + k));
        }
        if (requests.length) {
          step('copy_assign_columns', { from: last, count: requests.length });
          await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
        }
      } else {
        step('skip_copy_invalid_last_assign_col', { last });
      }

      // refresh header map after adding columns (optional)
    }

    // 6) Write item rows
    // First data row just after header row
    const rows: string[][] = [];

    for (const cat of scraped.categories) {
      // Skip "Featured items" category
      if (cat.title === "Featured items") continue;
      for (const it of cat.items) {
        const price = it.price?.amount ?? null;
        const itemTitle = (typeof it.title === 'string' && it.title.trim())
          ? it.title.trim()
          : (
              (typeof (it as any)?.detail_raw?.data?.title === 'string' && (it as any).detail_raw.data.title.trim()) ||
              (typeof it.description === 'string' && it.description.trim()) ||
              ''
            );
        const groupsForItem: string[] = (it.detail_raw?.data?.customizationsList || []).map((g: any) => (g?.title || "").trim()).filter(Boolean);

        // Row array shaped to first assignment column, we’ll then place assignments separately if columns are sparse
        const row: string[] = [];
        // pad until item col
        for (let i = 0; i <= Math.max(colMenuGrp, assignCols[0] ?? colMenuGrp); i++) row.push("");
        row[colItem] = itemTitle;
        row[colPrice] = price !== null ? `$${Number(price).toFixed(2)}` : "";
        row[colDesc] = it.description || it.detail_raw?.data?.itemDescription || "";
        row[colMenuGrp] = cat.title || "";

        // put group names across assignment columns we currently know
        for (let i = 0; i < groupsForItem.length; i++) {
          const col = (assignCols[0] ?? colMenuGrp + 1) + i;
          row[col] = groupsForItem[i];
        }

        rows.push(row);
      }
    }

    // write in one go
    const lastColIndex = Math.max(...rows.map(r => r.length)) - 1;
    const endA1 = A1(lastColIndex, (headerRow + 1) + rows.length - 1);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${MENU_SHEET}!A${headerRow + 2}:${endA1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rows },
    });

    const res = NextResponse.json({ spreadsheetId, spreadsheetUrl, debug }, { status: 200 });
    if (updatedCredentials) {
      // Persist refreshed access/expiry if available
      try {
        const { applySetStoredTokenCookie } = await import("@/app/lib/googleOAuth");
        applySetStoredTokenCookie(res, updatedCredentials);
      } catch {}
    }
    return res;
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err), debug }, { status: 500 });
  }
}
