import { createClient } from "@supabase/supabase-js";
import { isAuthed, bearer } from "../_lib/auth";

function admin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY not configured");
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function getUserId(req: Request): Promise<string | null> {
  const token = bearer(req);
  if (!token) return null;
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        authorization: `Bearer ${token}`,
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const { id } = await res.json();
    return id ?? null;
  } catch {
    return null;
  }
}

/** GET /api/directory — list all studios with hero image + heart status */
export async function GET(req: Request) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });

  const userId = await getUserId(req);
  const db = admin();

  // Studios list
  const { data: studios, error: studiosErr } = await db
    .from("watched_studios")
    .select("id, url, domain, name, kind, tier, gallery_appearances")
    .order("kind")
    .order("name");
  if (studiosErr) return Response.json({ error: studiosErr.message }, { status: 500 });

  const domains = (studios ?? []).map((s) => s.domain as string);

  // Hero images from corpus (one per domain, from the directSites() harvester)
  const { data: images } = await db
    .from("web_corpus")
    .select("domain, image, blurb")
    .in("source", ["foundry-direct", "agency-direct"])
    .in("domain", domains);

  const imageByDomain = new Map<string, { image: string | null; blurb: string | null }>();
  for (const row of images ?? []) {
    imageByDomain.set(row.domain as string, {
      image: row.image as string | null,
      blurb: row.blurb as string | null,
    });
  }

  // Current user's hearts
  const heartSet = new Set<string>();
  if (userId) {
    const { data: hearts } = await db
      .from("studio_hearts")
      .select("domain")
      .eq("user_id", userId);
    for (const h of hearts ?? []) heartSet.add(h.domain as string);
  }

  const result = (studios ?? []).map((s) => ({
    ...s,
    image: imageByDomain.get(s.domain as string)?.image ?? null,
    blurb: imageByDomain.get(s.domain as string)?.blurb ?? null,
    hearted: heartSet.has(s.domain as string),
  }));

  return Response.json(result);
}

/** POST /api/directory — toggle heart: { domain, hearted: boolean } */
export async function POST(req: Request) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });

  const userId = await getUserId(req);
  if (!userId) return Response.json({ error: "could not resolve user" }, { status: 401 });

  const { domain, hearted } = await req.json().catch(() => ({}));
  if (!domain) return Response.json({ error: "domain required" }, { status: 400 });

  const db = admin();

  if (hearted) {
    await db.from("studio_hearts").upsert({ user_id: userId, domain }, { onConflict: "user_id,domain" });
  } else {
    await db.from("studio_hearts").delete().eq("user_id", userId).eq("domain", domain);
  }

  return Response.json({ ok: true });
}
