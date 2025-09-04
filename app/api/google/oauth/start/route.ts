import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getOAuthClient, applySetStateCookie } from "@/app/lib/googleOAuth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const oauth2 = getOAuthClient(origin);
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/spreadsheets",
    ],
    state,
    include_granted_scopes: true,
  });
  const res = NextResponse.redirect(url);
  applySetStateCookie(res, state);
  return res;
}


