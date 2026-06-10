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

/** The personal token used by the browser extension and iOS Shortcut. */
export function isClipToken(token: string | null): boolean {
  const expected = process.env.MOOD_CLIP_TOKEN;
  return !!expected && !!token && token === expected;
}
