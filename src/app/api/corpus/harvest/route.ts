import { isAuthed } from "../../_lib/auth";
import { harvest, embedPending, recolorPending, hygiene } from "../../_lib/corpus";

export const maxDuration = 120;

/**
 * POST { harvest?: boolean, embed?: number } -> { found, added, embedded, remaining, rateLimited }
 * Grows the web_corpus index: harvest pulls fresh candidates from the gallery adapters;
 * embed processes up to N pending rows through Voyage. Call repeatedly (cron / pre-warm
 * script / app idle) — both halves are idempotent and rate-limit aware.
 */
/** GET: Vercel cron entry point (nightly index growth). Authorised by CRON_SECRET —
 *  Vercel sends `Authorization: Bearer <CRON_SECRET>` when the env var is set — or by
 *  the normal app auth for manual triggering. */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const cronOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronOk && !(await isAuthed(req))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const h = await harvest();
    const hyg = await hygiene(12);
    const e = await embedPending(40);
    return Response.json({ ...h, hygiene: hyg, ...e });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}

export async function POST(req: Request) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  try {
    const out: Record<string, number | boolean> = {};
    if (body.harvest !== false) {
      const h = await harvest();
      out.found = h.found;
      out.added = h.added;
    }
    const batch = Math.min(Math.max(Number(body.embed ?? 6), 0), 20);
    if (batch > 0) {
      const e = await embedPending(batch);
      out.embedded = e.embedded;
      out.remaining = e.remaining;
      out.rateLimited = e.rateLimited;
    }
    const recolor = Math.min(Math.max(Number(body.recolor ?? 0), 0), 20);
    if (recolor > 0) {
      const r = await recolorPending(recolor);
      out.recolored = r.recolored;
      out.recolorRemaining = r.remaining;
      out.rateLimited = out.rateLimited || r.rateLimited;
    }
    const clean = Math.min(Math.max(Number(body.hygiene ?? 0), 0), 20);
    if (clean > 0) {
      const hyg = await hygiene(clean);
      out.checked = hyg.checked;
      out.dead = hyg.dead;
      out.repaired = hyg.repaired;
      out.uncheckedRemaining = hyg.remaining;
    }
    return Response.json(out);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
