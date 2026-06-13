import { createClient } from "@supabase/supabase-js";
import { isAuthed } from "../../_lib/auth";

function admin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY not configured");
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** GET /api/directory/[domain] — studio detail: metadata + recent work/articles */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ domain: string }> }
) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { domain } = await params;
  const db = admin();

  const [{ data: studio }, { data: work }] = await Promise.all([
    db.from("watched_studios").select("*").eq("domain", domain).single(),
    db
      .from("web_corpus")
      .select("url, title, image, blurb, tags, last_seen_at")
      .eq("source", `studio/${domain}`)
      .order("last_seen_at", { ascending: false })
      .limit(24),
  ]);

  if (!studio) return Response.json({ error: "not found" }, { status: 404 });

  return Response.json({ studio, work: work ?? [] });
}
