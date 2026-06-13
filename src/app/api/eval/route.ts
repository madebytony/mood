/**
 * Eval harness: record quality labels for discovery results.
 *
 * POST { url, verdict: "good"|"bad"|"unsure", brief?, lane?, model? }
 *   → stores to discovery_events (kind="eval", value=1/0/0.5)
 *
 * GET ?from=<ISO>&to=<ISO>&lane=<mode>
 *   → aggregate: { total, good, bad, unsure, precision }
 *
 * These labels form the offline A/B dataset: compare precision across lanes/models
 * to measure whether ranking changes actually improved quality.
 */
import { createClient } from "@supabase/supabase-js";
import { isAuthed, bearer } from "../_lib/auth";

export const maxDuration = 15;

function db(req: Request) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY not configured");
  void req; // used for auth check upstream
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function POST(req: Request) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));

  const url = typeof body.url === "string" ? body.url : null;
  const verdict = body.verdict === "good" ? 1.0 : body.verdict === "bad" ? 0.0 : 0.5;
  const lane = typeof body.lane === "string" ? body.lane : null;
  const model = typeof body.model === "string" ? body.model : null;
  // Store the brief as a ref_key prefix (first 120 chars, URL-encoded)
  const refKey = typeof body.brief === "string"
    ? `eval:${body.brief.slice(0, 120)}`
    : `eval:browse`;

  if (!url) return Response.json({ error: "url required" }, { status: 400 });

  try {
    const token = bearer(req);
    const { data: auth } = await createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${token}` } } },
    ).auth.getUser();
    if (!auth.user) return Response.json({ error: "unauthorized" }, { status: 401 });

    const client = db(req);
    const { error } = await client.from("discovery_events").insert({
      user_id: auth.user.id,
      url,
      kind: "eval" as const,
      value: verdict,
      lane,
      model,
      ref_key: refKey,
    });
    if (error) throw error;
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}

export async function GET(req: Request) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  const from = sp.get("from") ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const to = sp.get("to") ?? new Date().toISOString();
  const lane = sp.get("lane");

  try {
    const client = db(req);
    let q = client
      .from("discovery_events")
      .select("value,lane,model,ref_key")
      .eq("kind", "eval")
      .gte("created_at", from)
      .lte("created_at", to);
    if (lane) q = q.eq("lane", lane);

    const { data, error } = await q.limit(5000);
    if (error) throw error;

    const rows = (data ?? []) as { value: number; lane: string | null; model: string | null }[];
    const total = rows.length;
    const good = rows.filter((r) => r.value === 1.0).length;
    const bad = rows.filter((r) => r.value === 0.0).length;
    const unsure = rows.filter((r) => r.value === 0.5).length;
    const precision = total > 0 ? Math.round((good / (good + bad)) * 100) : null;

    // Break down by lane + model for A/B comparison
    const breakdown: Record<string, { total: number; good: number; bad: number; precision: number | null }> = {};
    for (const r of rows) {
      const key = `${r.lane ?? "?"} / ${r.model ?? "?"}`;
      const b = breakdown[key] ?? { total: 0, good: 0, bad: 0, precision: null };
      b.total++;
      if (r.value === 1.0) b.good++;
      if (r.value === 0.0) b.bad++;
      breakdown[key] = b;
    }
    for (const b of Object.values(breakdown)) {
      b.precision = b.total > 0 ? Math.round((b.good / (b.good + b.bad || 1)) * 100) : null;
    }

    return Response.json({ total, good, bad, unsure, precision, breakdown });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
