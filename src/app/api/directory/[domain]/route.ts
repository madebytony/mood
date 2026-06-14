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

  const { data: studio } = await db.from("watched_studios").select("*").eq("domain", domain).single();
  if (!studio) return Response.json({ error: "not found" }, { status: 404 });

  // Pull recent work from both the studio's crawled content pages AND
  // its Instagram posts (stored separately as source = 'instagram/<handle>').
  const sources = [`studio/${domain}`];
  if (studio.instagram_handle) sources.push(`instagram/${studio.instagram_handle}`);

  const { data: work } = await db
    .from("web_corpus")
    .select("url, title, image, blurb, tags, last_seen_at, source")
    .in("source", sources)
    .not("image", "is", null)   // only show items with images — text-only entries aren't useful here
    .order("last_seen_at", { ascending: false })
    .limit(24);

  return Response.json({ studio, work: work ?? [] });
}
