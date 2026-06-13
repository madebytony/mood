import { createClient } from "@supabase/supabase-js";
import { bearer, isClipToken } from "../_lib/auth";
import { extFor, imageDims, sha1hex } from "../_lib/image";
import { assertPublicUrl, safeFetch } from "../_lib/ssrf";
import { clientIp, rateLimit, tooManyRequests } from "../_lib/ratelimit";

export const maxDuration = 120;

/** Caller-fault errors (bad body / unsupported input) → 400; everything else is a 502. */
class ClientError extends Error {}

function admin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

let cachedUserId: string | null = null;
// Single-user app by design: there is exactly one account, so "the owner" is the only user.
// If this ever becomes multi-user, bind the clip token to a specific user_id (e.g. signed token
// claims) and resolve the owner from that instead of taking the first listed user.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ownerId(db: any): Promise<string> {
  if (cachedUserId) return cachedUserId;
  const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (error || !data?.users?.length) throw new Error("No user found");
  cachedUserId = data.users[0].id as string;
  return cachedUserId;
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
    },
  });
}

export async function POST(req: Request) {
  const cors = { "access-control-allow-origin": "*" };
  if (!isClipToken(bearer(req))) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: cors });
  }
  // Each clip can launch a 120s Puppeteer job + storage write — cap so a leaked token can't
  // spin up unbounded headless-Chrome work or fill storage.
  const rl = rateLimit(`clip:${clientIp(req)}`, 30, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfter, cors);
  const db = admin();
  if (!db) {
    return Response.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY not configured on the server" },
      { status: 503, headers: cors }
    );
  }
  let body: {
    kind?: "image" | "page" | "url";
    url?: string;
    page_url?: string;
    image?: string; // data URL
    title?: string;
    space_id?: string;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "json body required" }, { status: 400, headers: cors });
  }

  try {
    const uid = await ownerId(db);
    let spaceId = body.space_id ?? null;
    if (!spaceId) {
      // Default to Bookmarks if it exists, otherwise Inbox
      const { data: bm } = await db.from("spaces").select("id").eq("kind", "bookmarks").limit(1).single();
      if (bm) { spaceId = bm.id; }
      else {
        const { data: inbox } = await db.from("spaces").select("id").eq("kind", "inbox").limit(1).single();
        spaceId = inbox?.id ?? null;
      }
    }
    if (!spaceId) throw new ClientError("No space found");

    let bytes: Uint8Array<ArrayBuffer> | null = null;
    let contentType = "image/jpeg";
    let sourceUrl = body.page_url ?? body.url ?? null;
    let title = body.title ?? null;
    let fonts: string[] = [];
    let tech: string[] = [];
    // A page capture that can't produce a clean shot degrades to a bookmark rather than dropping.
    let degradeToLink = false;

    if (body.kind === "image" && body.image?.startsWith("data:")) {
      const m = /^data:([^;]+);base64,(.*)$/.exec(body.image);
      if (!m) throw new ClientError("bad data url");
      contentType = m[1];
      // copy into a fresh, exact-size buffer — base64 Buffers can be pool-backed views
      bytes = new Uint8Array(Buffer.from(m[2], "base64"));
    } else if (body.kind === "image" && body.url) {
      const res = await safeFetch(body.url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`image fetch ${res.status}`);
      contentType = res.headers.get("content-type") ?? "image/jpeg";
      bytes = new Uint8Array(await res.arrayBuffer());
      sourceUrl = body.page_url ?? body.url;
    } else if ((body.kind === "page" || body.kind === "url") && body.url) {
      await assertPublicUrl(body.url);
      sourceUrl = body.url;
      title = title ?? body.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];

      // Instagram/Threads: use the public oEmbed API to get the post image.
      // These platforms block og:image from server-side fetches and screenshots,
      // but the oEmbed endpoint returns thumbnail_url without auth for public posts.
      const isInstagram = /^https?:\/\/(www\.)?(instagram\.com|threads\.net)\//i.test(body.url);
      if (isInstagram) {
        try {
          const oembedUrl = `https://api.instagram.com/oembed/?url=${encodeURIComponent(body.url)}`;
          const oRes = await fetch(oembedUrl, { signal: AbortSignal.timeout(10000) });
          if (oRes.ok) {
            const oembed = await oRes.json();
            if (oembed.title) title = String(oembed.title).slice(0, 200);
            else if (oembed.author_name) title = oembed.author_name;
            const thumbUrl = oembed.thumbnail_url;
            if (thumbUrl) {
              const imgRes = await fetch(thumbUrl, { signal: AbortSignal.timeout(15000) });
              if (imgRes.ok) {
                contentType = imgRes.headers.get("content-type") ?? "image/jpeg";
                if (contentType.startsWith("image/")) {
                  bytes = new Uint8Array(await imgRes.arrayBuffer());
                }
              }
            }
          }
        } catch { /* fall through to link */ }
        if (!bytes) degradeToLink = true;
      } else if (body.kind === "url") {
        // kind:"url" is an explicit bookmark; kind:"page" tries a screenshot first.
        degradeToLink = true;
      } else {
        try {
          // Dynamic import keeps the capture pipeline's heavy deps (sharp/puppeteer) out of the
          // image-clip path, so a load failure there can never 500 an image save.
          const { captureVetted } = await import("../_lib/capture");
          const shot = await captureVetted(body.url, false);
          contentType = shot.type;
          bytes = shot.bytes;
          fonts = shot.fonts ?? [];
          tech = shot.tech ?? [];
        } catch {
          // Fire-and-forget capture must never silently drop: no clean screenshot
          // (poison/blocked/error, or the pipeline failed) → save the page as a bookmark.
          degradeToLink = true;
        }
      }
    } else {
      throw new ClientError("unsupported clip");
    }

    let domain: string | null = null;
    try { domain = sourceUrl ? new URL(sourceUrl).hostname.replace(/^www\./, "") : null; } catch {}

    // Bookmark fallback (or explicit kind:"url"): a link card, no screenshot — never a dropped item.
    if (degradeToLink || !bytes) {
      const { data: item, error } = await db
        .from("items")
        .insert({
          space_id: spaceId,
          user_id: uid,
          type: "link",
          title: title ?? domain,
          source_url: sourceUrl,
          source_domain: domain,
          tags: [],
        })
        .select()
        .single();
      if (error) throw error;
      return Response.json({ ok: true, id: item.id, saved: "link" }, { headers: cors });
    }

    const ext = extFor(contentType);
    const dims = imageDims(bytes, contentType);
    const hash = await sha1hex(bytes);
    const path = `media/${hash}.${ext}`;
    const up = await db.storage.from("media").upload(path, bytes, { upsert: true, contentType });
    if (up.error) throw up.error;

    const { data: item, error } = await db
      .from("items")
      .insert({
        space_id: spaceId,
        user_id: uid,
        type: body.kind === "page" ? "site" : "image",
        storage_path: path,
        thumb_path: path, // full image doubles as thumb for clipped items
        title,
        source_url: sourceUrl,
        source_domain: domain,
        tags: [],
        fonts,
        tech,
        width: dims.w,
        height: dims.h,
      })
      .select()
      .single();
    if (error) throw error;
    return Response.json({ ok: true, id: item.id }, { headers: cors });
  } catch (e) {
    const err = e as Error;
    // Caller-fault and SSRF-blocked URLs are 400s; upstream/DB failures are 502 with a generic
    // message so Supabase/Postgres internals never leak to the extension.
    if (err instanceof ClientError) {
      return Response.json({ error: err.message }, { status: 400, headers: cors });
    }
    if (err.message?.startsWith("blocked")) {
      return Response.json({ error: "url not allowed" }, { status: 400, headers: cors });
    }
    console.error("clip POST failed:", err);
    return Response.json({ error: "clip failed" }, { status: 502, headers: cors });
  }
}

/** GET /api/clip -> list spaces (for the iOS Shortcut's "Choose from List"). */
export async function GET(req: Request) {
  const cors = { "access-control-allow-origin": "*" };
  if (!isClipToken(bearer(req))) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: cors });
  }
  const db = admin();
  if (!db) return Response.json({ error: "service key missing" }, { status: 503, headers: cors });
  const { data: spaces } = await db.from("spaces").select("id,name,kind").order("sort");
  // Unstacked-item tally per space (matches the app's sidebar counts) so the picker can show sizes.
  const { data: rows } = await db.from("items").select("space_id").is("stack_id", null).limit(10000);
  const counts: Record<string, number> = {};
  for (const r of (rows ?? []) as { space_id: string | null }[]) {
    if (r.space_id) counts[r.space_id] = (counts[r.space_id] ?? 0) + 1;
  }
  const withCounts = ((spaces ?? []) as { id: string }[]).map((s) => ({ ...s, count: counts[s.id] ?? 0 }));
  return Response.json({ spaces: withCounts }, { headers: cors });
}
