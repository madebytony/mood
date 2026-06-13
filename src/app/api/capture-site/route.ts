import { isAuthed } from "../_lib/auth";
import { captureVetted, PoisonedCaptureError } from "../_lib/capture";
import { assertPublicUrl } from "../_lib/ssrf";
import { clientIp, rateLimit, tooManyRequests } from "../_lib/ratelimit";

export const maxDuration = 120; // crash-retry + fallback chain on heavy WebGL sites needs headroom

export async function GET(req: Request) {
  if (!(await isAuthed(req))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const rl = rateLimit(`capture:${clientIp(req)}`, 15, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfter);
  const url = new URL(req.url).searchParams.get("url");
  if (!url || !/^https?:\/\//i.test(url)) {
    return Response.json({ error: "valid url required" }, { status: 400 });
  }
  try {
    await assertPublicUrl(url);
    // capped: this response travels back through Vercel's proxy (~4.5MB limit). captureVetted
    // gates out poisoned shots (flat/blocked/error) so the client never saves a dud card.
    const shot = await captureVetted(url, true);
    return new Response(shot.bytes, {
      headers: {
        "content-type": shot.type,
        "cache-control": "no-store",
        "x-capture-engine": shot.engine,
        "x-page-fonts": encodeURIComponent(JSON.stringify(shot.fonts ?? [])),
        "x-page-tech": encodeURIComponent(JSON.stringify(shot.tech ?? [])),
      },
    });
  } catch (e) {
    if (e instanceof PoisonedCaptureError) {
      return Response.json({ error: `couldn't capture clean content — ${e.message}` }, { status: 422 });
    }
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
