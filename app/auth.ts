import { cookies } from "next/headers";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Single-owner password gate. Everything is stored under OWNER_ID.
export type AppUser = { userId: string };

export const SESSION_COOKIE = "cc_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

function password(): string | null {
  return process.env.APP_PASSWORD || null;
}

// Derived from the password, so changing APP_PASSWORD signs out every session.
export function sessionToken(): string | null {
  const secret = password();
  if (!secret) return null;
  return createHmac("sha256", secret).update("collection-cull-session-v1").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function passwordMatches(input: string): boolean {
  const secret = password();
  return !!secret && safeEqual(input, secret);
}

export async function getUser(): Promise<AppUser | null> {
  const expected = sessionToken();
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!expected || !cookie || !safeEqual(cookie, expected)) return null;
  return { userId: process.env.OWNER_ID || "owner" };
}
