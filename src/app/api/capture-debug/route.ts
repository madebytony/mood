import fs from "fs";
import { isAuthed } from "../_lib/auth";
import { chromiumShot } from "../_lib/capture";
import { assertPublicUrl } from "../_lib/ssrf";
import { clientIp, rateLimit, tooManyRequests } from "../_lib/ratelimit";

function ls(dir: string): string[] | null {
  try {
    return fs.readdirSync(dir).slice(0, 50);
  } catch {
    return null;
  }
}

export const maxDuration = 60;

/** Diagnostic: tries the real Chromium engine only (no fallback) and reports the exact error. */
export async function GET(req: Request) {
  if (!(await isAuthed(req))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const rl = rateLimit(`capture-debug:${clientIp(req)}`, 15, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfter);
  const url = new URL(req.url).searchParams.get("url") ?? "https://example.com";
  const t0 = Date.now();
  try {
    await assertPublicUrl(url);
    const shot = await chromiumShot(url);
    return Response.json({ ok: true, engine: shot.engine, bytes: shot.bytes.byteLength, ms: Date.now() - t0 });
  } catch (e) {
    const err = e as Error;
    // Stack traces, env vars and filesystem listings are useful locally but must never ship to a
    // caller in production (they map the runtime for an attacker), so gate them behind dev.
    if (process.env.NODE_ENV === "production") {
      return Response.json({ ok: false, error: "capture failed", ms: Date.now() - t0 }, { status: 500 });
    }
    return Response.json({
      ok: false,
      error: err.message,
      stack: (err.stack ?? "").split("\n").slice(0, 8),
      ms: Date.now() - t0,
      diag: {
        LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ?? null,
        AWS_EXECUTION_ENV: process.env.AWS_EXECUTION_ENV ?? null,
        AWS_LAMBDA_FUNCTION_NAME: process.env.AWS_LAMBDA_FUNCTION_NAME ?? null,
        tmp: ls("/tmp"),
        tmpLib: ls("/tmp/lib"),
        al2023: ls("/tmp/al2023/lib"),
      },
    });
  }
}
