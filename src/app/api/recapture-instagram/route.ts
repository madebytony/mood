import { createClient } from "@supabase/supabase-js";
import { bearer, isClipToken } from "../_lib/auth";
import { captureInstagram } from "../_lib/capture";
import { extFor, imageDims, sha1hex } from "../_lib/image";
import { gemini, geminiDisabled, geminiText, hasGeminiKey } from "../_lib/gemini";

export const maxDuration = 300;

const CAPTION_VERSION = 2;

function admin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function enrichItem(db: any, itemId: string, storagePath: string, title: string | null) {
  if (!hasGeminiKey() || geminiDisabled()) return;
  try {
    const { data: urlData } = await db.storage.from("media").createSignedUrl(storagePath, 120);
    if (!urlData?.signedUrl) return;
    const img = await fetch(urlData.signedUrl, { signal: AbortSignal.timeout(15000) });
    if (!img.ok) return;
    const type = img.headers.get("content-type") ?? "image/webp";
    const b64 = Buffer.from(await img.arrayBuffer()).toString("base64");
    const prompt = `You are analysing a design reference for a designer's moodboard${title ? ` titled "${title}"` : ""}. Describe what you SEE in precise design vocabulary — this text powers visual-similarity matching and search, so favour how it looks over what it is for.\n\nReply with JSON only:\n{"caption": "<2-3 sentences covering, in this order: layout structure, typography treatment, colour theme, then overall mood and subject>",\n"tags": ["<10-14 lowercase tags drawn ONLY from what is visible>"]}`;
    const res = await gemini({
      contents: [{ role: "user", parts: [
        { inlineData: { mimeType: type, data: b64 } },
        { text: prompt },
      ]}],
      generationConfig: { maxOutputTokens: 800, responseMimeType: "application/json" },
    });
    const out = JSON.parse(geminiText(res));
    const caption = out.caption ?? null;
    const tags = Array.isArray(out.tags) ? out.tags.slice(0, 14) : [];
    if (!caption && !tags.length) return;
    await db.from("items").update({ ai_caption: caption, tags, caption_v: CAPTION_VERSION }).eq("id", itemId);
  } catch { /* best-effort */ }
}

interface IgItem {
  id: string;
  source_url: string;
  source_domain: string | null;
  title: string | null;
  space_id: string;
  user_id: string;
  storage_path: string | null;
  thumb_path: string | null;
  stack_id: string | null;
}

/**
 * GET  /api/recapture-instagram — dry-run: list Instagram items that would be re-processed.
 * POST /api/recapture-instagram — re-capture: extract real images, replace screenshots,
 *      create carousel slides as separate items in a stack.
 */
export async function GET(req: Request) {
  if (!isClipToken(bearer(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const db = admin();
  if (!db) return Response.json({ error: "service key missing" }, { status: 503 });

  const { data, error } = await db
    .from("items")
    .select("id,source_url,source_domain,title,space_id,type,storage_path")
    .like("source_url", "%instagram.com/%")
    .order("created_at", { ascending: false });
  if (error) return Response.json({ error: error.message }, { status: 502 });

  const items = (data ?? []) as { id: string; source_url: string; title: string | null; type: string; storage_path: string | null }[];
  return Response.json({
    count: items.length,
    items: items.map((i) => ({ id: i.id, url: i.source_url, title: i.title, type: i.type })),
  });
}

export async function POST(req: Request) {
  if (!isClipToken(bearer(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const db = admin();
  if (!db) return Response.json({ error: "service key missing" }, { status: 503 });

  let body: { ids?: string[]; limit?: number } = {};
  try { body = await req.json(); } catch {}
  const limit = Math.min(body.limit ?? 20, 50);

  let q = db
    .from("items")
    .select("id,source_url,source_domain,title,space_id,user_id,storage_path,thumb_path,stack_id")
    .like("source_url", "%instagram.com/%")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (body.ids?.length) q = q.in("id", body.ids);
  const { data, error } = await q;
  if (error) return Response.json({ error: error.message }, { status: 502 });

  const items = (data ?? []) as IgItem[];
  const started = Date.now();
  const results: { id: string; url: string; ok: boolean; slides: number; note: string }[] = [];

  for (const it of items) {
    // Leave headroom for the function timeout
    if (Date.now() - started > (maxDuration - 60) * 1000) {
      results.push({ id: it.id, url: it.source_url, ok: false, slides: 0, note: "skipped: time budget" });
      continue;
    }

    const igMatch = it.source_url.match(/instagram\.com\/(?:p|reel)\/([A-Za-z0-9_-]+)/i);
    if (!igMatch) {
      results.push({ id: it.id, url: it.source_url, ok: false, slides: 0, note: "not a post URL" });
      continue;
    }

    try {
      const images = await captureInstagram(igMatch[1]);
      if (!images || !images.length) {
        results.push({ id: it.id, url: it.source_url, ok: false, slides: 0, note: "extraction failed" });
        continue;
      }

      // Replace the original item's image with the first slide
      const first = images[0];
      const firstHash = await sha1hex(first.bytes);
      const firstExt = extFor(first.type);
      const firstPath = `media/${firstHash}.${firstExt}`;
      const firstDims = imageDims(first.bytes, first.type);
      await db.storage.from("media").upload(firstPath, first.bytes, { upsert: true, contentType: first.type });

      // Update original item: swap screenshot for real image, clear stale caption
      await db.from("items").update({
        type: "image",
        storage_path: firstPath,
        thumb_path: firstPath,
        width: firstDims.w,
        height: firstDims.h,
        ai_caption: null,
        caption_v: null,
        embedding: null,
      }).eq("id", it.id);

      // Re-caption the updated item
      await enrichItem(db, it.id, firstPath, it.title);

      // For carousels: create additional items for slides 2+, stacked with the original
      const extraIds: string[] = [];
      for (let idx = 1; idx < images.length; idx++) {
        const img = images[idx];
        const hash = await sha1hex(img.bytes);
        const ext = extFor(img.type);
        const path = `media/${hash}.${ext}`;
        const dims = imageDims(img.bytes, img.type);
        await db.storage.from("media").upload(path, img.bytes, { upsert: true, contentType: img.type });

        const slideTitle = `${it.title ?? it.source_domain ?? "Instagram"} (${idx + 1}/${images.length})`;
        const { data: slide, error: slideErr } = await db
          .from("items")
          .insert({
            space_id: it.space_id,
            user_id: it.user_id,
            type: "image",
            storage_path: path,
            thumb_path: path,
            title: slideTitle,
            source_url: it.source_url,
            source_domain: it.source_domain,
            tags: [],
            width: dims.w,
            height: dims.h,
          })
          .select()
          .single();
        if (slideErr) continue;
        extraIds.push(slide.id);
        await enrichItem(db, slide.id, path, slideTitle);
      }

      // Auto-stack carousel slides if we created extras and the original isn't already stacked
      if (extraIds.length && !it.stack_id) {
        const { data: stack } = await db
          .from("stacks")
          .insert({ user_id: it.user_id, space_id: it.space_id, name: it.title ?? it.source_domain ?? "Instagram carousel" })
          .select()
          .single();
        if (stack) {
          await db.from("items").update({ stack_id: stack.id }).in("id", [it.id, ...extraIds]);
        }
      } else if (extraIds.length && it.stack_id) {
        // Add new slides to the existing stack
        await db.from("items").update({ stack_id: it.stack_id }).in("id", extraIds);
      }

      // Update the original title to include slide numbering if carousel
      if (images.length > 1) {
        await db.from("items").update({ title: `${it.title ?? it.source_domain ?? "Instagram"} (1/${images.length})` }).eq("id", it.id);
      }

      results.push({ id: it.id, url: it.source_url, ok: true, slides: images.length, note: images.length > 1 ? "carousel" : "single" });
    } catch (e) {
      results.push({ id: it.id, url: it.source_url, ok: false, slides: 0, note: (e as Error).message });
    }
  }

  return Response.json({
    processed: results.length,
    succeeded: results.filter((r) => r.ok).length,
    totalSlides: results.reduce((n, r) => n + r.slides, 0),
    results,
  });
}
