import { createClient } from "@supabase/supabase-js";
import { bearer, isClipToken } from "../_lib/auth";
import { captureScreenshot } from "../_lib/capture";

export const maxDuration = 120;

function admin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

let cachedUserId: string | null = null;
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
function imageDims(buf: ArrayBuffer, type: string): { w: number | null; h: number | null } {
  const b = new Uint8Array(buf);
  try {
    if (type === "image/png" && b.length > 24) {
      const dv = new DataView(buf);
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

async function sha1hex(buf: ArrayBuffer): Promise<string> {
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
    if (!spaceId) throw new Error("No space found");

    let bytes: ArrayBuffer | null = null;
    let contentType = "image/jpeg";
    let sourceUrl = body.page_url ?? body.url ?? null;
    let title = body.title ?? null;
    let fonts: string[] = [];
    let tech: string[] = [];

    if (body.kind === "image" && body.image?.startsWith("data:")) {
      const m = /^data:([^;]+);base64,(.*)$/.exec(body.image);
      if (!m) throw new Error("bad data url");
      contentType = m[1];
      bytes = Buffer.from(m[2], "base64").buffer as ArrayBuffer;
    } else if (body.kind === "image" && body.url) {
      const res = await fetch(body.url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`image fetch ${res.status}`);
      contentType = res.headers.get("content-type") ?? "image/jpeg";
      bytes = await res.arrayBuffer();
      sourceUrl = body.page_url ?? body.url;
    } else if (body.kind === "page" && body.url) {
      const shot = await captureScreenshot(body.url, false);
      contentType = shot.type;
      bytes = shot.bytes;
      fonts = shot.fonts ?? [];
      tech = shot.tech ?? [];
      sourceUrl = body.url;
      title = title ?? body.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
    } else {
      throw new Error("unsupported clip");
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
    return Response.json({ error: (e as Error).message }, { status: 502, headers: cors });
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
  const { data } = await db.from("spaces").select("id,name,kind").order("sort");
  return Response.json({ spaces: data ?? [] }, { headers: cors });
}
