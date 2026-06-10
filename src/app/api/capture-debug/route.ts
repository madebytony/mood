import { isAuthed } from "../_lib/auth";
import { chromiumShot } from "../_lib/capture";

export const maxDuration = 60;

/** Diagnostic: tries the real Chromium engine only (no fallback) and reports the exact error. */
export async function GET(req: Request) {
  if (!(await isAuthed(req))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url).searchParams.get("url") ?? "https://example.com";
  const t0 = Date.now();
  try {
    const shot = await chromiumShot(url);
    return Response.json({ ok: true, engine: shot.engine, bytes: shot.bytes.byteLength, ms: Date.now() - t0 });
  } catch (e) {
    const err = e as Error;
    return Response.json({
      ok: false,
      error: err.message,
      stack: (err.stack ?? "").split("\n").slice(0, 8),
      ms: Date.now() - t0,
    });
  }
}
