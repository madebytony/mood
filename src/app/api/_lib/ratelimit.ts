/**
 * Best-effort in-memory fixed-window rate limiter — no external deps, no infra.
 *
 * Scope caveat: state lives per serverless instance, so under Fluid Compute concurrency the
 * effective limit is (per-instance limit × live instances). That's fine for this single-owner app:
 * the goal is to cap runaway abuse of the expensive endpoints (Puppeteer captures, image egress) if
 * the clip token leaks, not to enforce a precise global quota. For that, swap in @upstash/ratelimit.
 */

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export interface RateResult {
  ok: boolean;
  /** Seconds until the window resets (for a Retry-After header). */
  retryAfter: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateResult {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    // opportunistic sweep so the map can't grow without bound across many distinct keys
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  if (b.count >= limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  }
  b.count++;
  return { ok: true, retryAfter: 0 };
}

/** Caller identity for keying: the proxied client IP (Vercel sets x-forwarded-for). */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/** Standard 429 response. Pass extra headers (e.g. CORS) to merge. */
export function tooManyRequests(retryAfter: number, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(
    { error: "rate limited" },
    { status: 429, headers: { "retry-after": String(retryAfter), ...extraHeaders } }
  );
}
