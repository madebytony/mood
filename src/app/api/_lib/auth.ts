import { createHash, timingSafeEqual } from "crypto";

/** Verify the caller's Supabase access token (no extra deps, no service key). */
export async function isAuthed(req: Request): Promise<boolean> {
  const token = bearer(req);
  if (!token) return false;
  if (isClipToken(token)) return true;
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        authorization: `Bearer ${token}`,
      },
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function bearer(req: Request): string | null {
  return req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
}

/** The personal token used by the browser extension and iOS Shortcut.
 *  Compared in constant time (over fixed-length SHA-256 digests, so neither the result nor the
 *  token length leaks via timing) to deny a byte-by-byte guessing oracle. */
export function isClipToken(token: string | null): boolean {
  const expected = process.env.MOOD_CLIP_TOKEN;
  if (!expected || !token) return false;
  return timingSafeEqual(sha256(token), sha256(expected));
}

/** Verify a cron request's Bearer token against CRON_SECRET (timing-safe). */
export function isCronSecret(token: string | null): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected || !token) return false;
  return timingSafeEqual(sha256(token), sha256(expected));
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}
