import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { applyClearStateCookie, applySetStoredTokenCookie, getOAuthClient, getStoredTokenFromCookie, readStateCookie } from "@/app/lib/googleOAuth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieStore = await cookies();
  const expectedState = readStateCookie(cookieStore);
  if (!code || !state || !expectedState || state !== expectedState) {
    return NextResponse.json({ error: "invalid_oauth_state" }, { status: 400 });
  }
  try {
    const oauth2 = getOAuthClient(url.origin);
    const { tokens } = await oauth2.getToken(code);
    const existing = getStoredTokenFromCookie(cookieStore);
    oauth2.setCredentials(tokens);
    const refreshToken = tokens.refresh_token || existing?.refresh_token;
    if (!refreshToken) {
      return NextResponse.json({ error: "no_refresh_token", hint: "Add prompt=consent in start URL or revoke app access then try again" }, { status: 400 });
    }
    const res = NextResponse.redirect(url.origin + "/?google=connected");
    applySetStoredTokenCookie(res, {
      refresh_token: refreshToken,
      access_token: tokens.access_token || existing?.access_token || null,
      expiry_date: tokens.expiry_date || existing?.expiry_date || null,
    });
    applyClearStateCookie(res);
    return res;
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "oauth_error" }, { status: 500 });
  }
}


