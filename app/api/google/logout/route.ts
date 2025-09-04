import { NextResponse } from "next/server";
import { applyClearStoredTokenCookie } from "@/app/lib/googleOAuth";

export const runtime = "nodejs";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  applyClearStoredTokenCookie(res);
  return res;
}


