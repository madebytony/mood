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
  // 1. Prefer Authorization header (API calls, fetch with headers)
  const hdr = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (hdr) return hdr;
  // 2. Fall back to Supabase session cookie (same-origin <img> tags, etc.)
  const cookies = req.headers.get("cookie") ?? "";
  const sbMatch = /sb-[^=]+-auth-token(?:\.0)?=([^;]+)/.exec(cookies);
  if (!sbMatch) return null;
  try {
    // Supabase stores the token as a JSON-encoded base64 string in the cookie
    const decoded = decodeURIComponent(sbMatch[1]);
    const parsed = JSON.parse(decoded);
    // Could be the full [access_token, refresh_token] array or just the token
    return Array.isArray(parsed) ? parsed[0] : typeof parsed === "string" ? parsed : null;
  } catch {
    // Not JSON — try the raw value
    return decodeURIComponent(sbMatch[1]);
  }
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
