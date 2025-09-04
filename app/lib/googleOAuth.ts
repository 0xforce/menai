import { NextResponse } from "next/server";
import { google } from "googleapis";
import crypto from "crypto";

const TOKEN_COOKIE_NAME = "g_oauth_token";
const STATE_COOKIE_NAME = "g_oauth_state";

type ReadonlyCookieStore = {
  get(name: string): { name: string; value: string } | undefined;
};

export type StoredToken = {
  refresh_token: string;
  access_token?: string | null;
  expiry_date?: number | null; // ms epoch
};

function getEnv(name: string, required = true): string | undefined {
  const v = process.env[name];
  if (!v && required) throw new Error(`Missing env ${name}`);
  return v;
}

function getCookieSecret(): Buffer {
  const secret = getEnv("OAUTH_COOKIE_SECRET");
  if (!secret) throw new Error("Missing OAUTH_COOKIE_SECRET");
  // accept base64, hex, or raw string; always derive a 32-byte key
  let raw: Buffer;
  try {
    raw = Buffer.from(secret, "base64");
  } catch { raw = Buffer.from(secret); }
  if (raw.length < 24) {
    // derive via SHA-256
    raw = crypto.createHash("sha256").update(secret).digest();
  }
  if (raw.length >= 32) return raw.subarray(0, 32);
  const extended = Buffer.alloc(32);
  raw.copy(extended);
  return extended;
}

function b64url(input: Buffer): string {
  return input.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function fromB64url(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function encryptJsonCookie(obj: any): string {
  const key = getCookieSecret();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), "utf8");
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [b64url(iv), b64url(enc), b64url(tag)].join(".");
}

export function decryptJsonCookie(value?: string | null): any | null {
  if (!value) return null;
  const [ivB64, encB64, tagB64] = value.split(".");
  if (!ivB64 || !encB64 || !tagB64) return null;
  const key = getCookieSecret();
  const iv = fromB64url(ivB64);
  const enc = fromB64url(encB64);
  const tag = fromB64url(tagB64);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  try {
    return JSON.parse(dec.toString("utf8"));
  } catch {
    return null;
  }
}

export function getOAuthClient(origin: string) {
  const clientId = getEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = getEnv("GOOGLE_OAUTH_CLIENT_SECRET");
  const redirectUri = `${origin}/api/google/oauth/callback`;
  return new google.auth.OAuth2({ clientId, clientSecret, redirectUri });
}

const defaultCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: true,
  path: "/",
};

export function applySetStateCookie(res: NextResponse, state: string) {
  res.cookies.set(STATE_COOKIE_NAME, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 10 * 60, // 10 minutes
  });
}

export function readStateCookie(cookieStore: ReadonlyCookieStore): string | null {
  return cookieStore.get(STATE_COOKIE_NAME)?.value || null;
}

export function applyClearStateCookie(res: NextResponse) {
  res.cookies.set(STATE_COOKIE_NAME, "", { ...defaultCookieOptions, maxAge: 0 });
}

export function encryptTokenForCookie(token: StoredToken): string {
  const payload: StoredToken = {
    refresh_token: token.refresh_token,
    access_token: token.access_token || null,
    expiry_date: token.expiry_date || null,
  };
  return encryptJsonCookie(payload);
}

export function applySetStoredTokenCookie(res: NextResponse, token: StoredToken) {
  const enc = encryptTokenForCookie(token);
  res.cookies.set(TOKEN_COOKIE_NAME, enc, { ...defaultCookieOptions, maxAge: 60 * 60 * 24 * 365 });
}

export function getStoredTokenFromCookie(cookieStore: ReadonlyCookieStore): StoredToken | null {
  const v = cookieStore.get(TOKEN_COOKIE_NAME)?.value || null;
  const obj = decryptJsonCookie(v);
  if (!obj || typeof obj !== "object") return null;
  if (!obj.refresh_token) return null;
  return obj as StoredToken;
}

export function applyClearStoredTokenCookie(res: NextResponse) {
  res.cookies.set(TOKEN_COOKIE_NAME, "", { ...defaultCookieOptions, maxAge: 0 });
}

export async function ensureAccessToken(oauth2: ReturnType<typeof getOAuthClient>): Promise<{ accessToken: string; updatedCredentials?: StoredToken }> {
  // If token valid for >60s, reuse
  const exp = oauth2.credentials.expiry_date || 0;
  const now = Date.now();
  if (oauth2.credentials.access_token && exp - now > 60_000) {
    return { accessToken: oauth2.credentials.access_token };
  }
  const tk = await oauth2.getAccessToken();
  const accessToken = typeof tk === "string" ? tk : tk?.token || oauth2.credentials.access_token;
  const updated: StoredToken = {
    refresh_token: oauth2.credentials.refresh_token!,
    access_token: accessToken || null,
    expiry_date: oauth2.credentials.expiry_date || null,
  };
  return { accessToken: accessToken || "", updatedCredentials: updated };
}

export function getPickerConfig() {
  const clientId = getEnv("GOOGLE_OAUTH_CLIENT_ID");
  const developerKey = getEnv("GOOGLE_API_KEY");
  const appId = process.env.GOOGLE_PICKER_APP_ID || process.env.GOOGLE_CLOUD_PROJECT_NUMBER || undefined;
  return { clientId, developerKey, appId };
}


