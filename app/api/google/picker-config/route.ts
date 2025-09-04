import { NextResponse } from "next/server";
import { getPickerConfig } from "@/app/lib/googleOAuth";

export const runtime = "nodejs";

export async function GET() {
  try {
    const cfg = getPickerConfig();
    return NextResponse.json(cfg);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'config_error' }, { status: 500 });
  }
}


