import { createClient } from "@supabase/supabase-js";
import { bearer, isClipToken } from "../_lib/auth";
import { captureScreenshot } from "../_lib/capture";
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

function extFor(type: string): string {
  const m: Record<string, string> = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
    "image/gif": "gif", "image/svg+xml": "svg", "image/avif": "avif",
  };
  return m[type] ?? "jpg";
}

/** Minimal JPEG/PNG dimension sniffing (no native deps). */
function imageDims(buf: Uint8Array<ArrayBuffer>, type: string): { w: number | null; h: number | null } {
  const b = buf;
  try {
    if (type === "image/png" && b.length > 24) {
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      return { w: dv.getUint32(16), h: dv.getUint32(20) };
    }
    if (type === "image/jpeg") {
      let i = 2;
      while (i < b.length - 9) {
        if (b[i] !== 0xff) break;
        const marker = b[i + 1];
        const len = (b[i + 2] << 8) | b[i + 3];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { w: (b[i + 7] << 8) | b[i + 8], h: (b[i + 5] << 8) | b[i + 6] };
        }
        i += 2 + len;
      }
    }
  } catch {}
  return { w: null, h: null };
}

async function sha1hex(buf: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
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
      const { data: inbox } = await db.from("spaces").select("id").eq("kind", "inbox").limit(1).single();
      spaceId = inbox?.id ?? null;
    }
    if (!spaceId) throw new ClientError("No space found");

    let bytes: Uint8Array<ArrayBuffer> | null = null;
    let contentType = "image/jpeg";
    let sourceUrl = body.page_url ?? body.url ?? null;
    let title = body.title ?? null;
    let fonts: string[] = [];
    let tech: string[] = [];

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
    } else if (body.kind === "page" && body.url) {
      await assertPublicUrl(body.url);
      const shot = await captureScreenshot(body.url, false);
      contentType = shot.type;
      bytes = shot.bytes;
      fonts = shot.fonts ?? [];
      tech = shot.tech ?? [];
      sourceUrl = body.url;
      title = title ?? body.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
    } else {
      throw new ClientError("unsupported clip");
    }

    const ext = extFor(contentType);
    const dims = imageDims(bytes, contentType);
    const hash = await sha1hex(bytes);
    const path = `media/${hash}.${ext}`;
    const up = await db.storage.from("media").upload(path, bytes, { upsert: true, contentType });
    if (up.error) throw up.error;

    let domain: string | null = null;
    try { domain = sourceUrl ? new URL(sourceUrl).hostname.replace(/^www\./, "") : null; } catch {}

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
