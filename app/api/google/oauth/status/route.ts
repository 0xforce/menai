import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getOAuthClient, getStoredTokenFromCookie, ensureAccessToken, applySetStoredTokenCookie } from "@/app/lib/googleOAuth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const cookieStore = await cookies();
  const stored = getStoredTokenFromCookie(cookieStore);
  if (!stored?.refresh_token) {
    return NextResponse.json({ connected: false });
  }
  try {
    const origin = new URL(req.url).origin;
    const oauth2 = getOAuthClient(origin);
    oauth2.setCredentials({ refresh_token: stored.refresh_token, access_token: stored.access_token || undefined, expiry_date: stored.expiry_date || undefined });
    const refreshed = await ensureAccessToken(oauth2);
    const res = NextResponse.json({ connected: true });
    if (refreshed.updatedCredentials) applySetStoredTokenCookie(res, refreshed.updatedCredentials);
    return res;
  } catch {
    return NextResponse.json({ connected: false });
  }
}


