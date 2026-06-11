import { isAuthed } from "../_lib/auth";
import { safeFetch } from "../_lib/ssrf";
import { clientIp, rateLimit, tooManyRequests } from "../_lib/ratelimit";

export const maxDuration = 30;

/** Try a cheap HEAD first, then a GET (many valid sites 405/403 HEAD but serve GET). A 2x/3xx on
 *  either counts as alive. Network/DNS errors and a final 4xx/5xx count as dead. One retry each to
 *  ride out a transient blip before we ever flag a link. */
async function reachable(url: string): Promise<boolean> {
  const attempt = async (method: "HEAD" | "GET") => {
    const res = await safeFetch(url, {
      method,
      redirect: "manual", // safeFetch re-validates each hop itself
      signal: AbortSignal.timeout(12000),
      headers: { "user-agent": "Mozilla/5.0 (compatible; MoodLinkCheck/1)" },
    });
    return res.status < 400;
  };
  for (const method of ["HEAD", "GET"] as const) {
    for (let tries = 0; tries < 2; tries++) {
      try {
        if (await attempt(method)) return true;
        break; // a definite 4xx/5xx — no point retrying this method, fall through to GET
      } catch {
        // transient (timeout/reset) — retry once, then move on
      }
    }
  }
  return false;
}

export async function GET(req: Request) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const rl = rateLimit(`checklink:${clientIp(req)}`, 120, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfter);
  const url = new URL(req.url).searchParams.get("url");
  if (!url) return Response.json({ error: "url required" }, { status: 400 });
  try {
    const dead = !(await reachable(url));
    return Response.json({ dead });
  } catch (e) {
    // a blocked/invalid URL is a bad request, not a dead link — don't flag it
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
