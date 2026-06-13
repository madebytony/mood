/**
 * Corpus + items embedding_v2 backfill.
 *
 * Aggressively drains rows missing embedding_v2 using Cloudflare CLIP (no rate
 * limit). Run this once to drain the 1,345-row backlog that was infeasible with
 * Voyage's 3 RPM free tier.
 *
 * GET  — cron entry (Vercel cron or manual curl with CRON_SECRET)
 * POST { corpus?: number, items?: number } — manual with specific batch sizes
 *
 * Both are idempotent. Safe to call repeatedly — always reads remaining count.
 */
import { createClient } from "@supabase/supabase-js";
import { isAuthed } from "../../_lib/auth";
import { getEmbedder, hasCfKey, CloudflareEmbedder } from "../../_lib/embedder";
import { hasVoyageKey, voyageEmbed, type VoyageContent } from "../../_lib/voyage";
import { extractColorsFromImage, extractLabPalette } from "../../_lib/colors";
import { inferFacetsFromText } from "@/lib/facets";

export const maxDuration = 120;

// Max batch sizes (Cloudflare has no rate limit; Voyage is capped at 3 RPM)
const CF_CORPUS_BATCH = 50;
const CF_ITEMS_BATCH = 30;
const VOYAGE_CORPUS_BATCH = 4;

const UA = "Mozilla/5.0 (compatible; MoodBackfill/1)";
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function admin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY not configured");
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function fetchImageData(url: string): Promise<{ base64: string; mimeType: string; buf: Buffer; voyagePart: VoyageContent } | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const mimeType = (res.headers.get("content-type") ?? "").split(";")[0];
    if (!mimeType.startsWith("image/")) return null;
    const raw = await res.arrayBuffer();
    if (raw.byteLength > MAX_IMAGE_BYTES || raw.byteLength < 2000) return null;
    const buf = Buffer.from(raw);
    const base64 = buf.toString("base64");
    return {
      base64,
      mimeType,
      buf,
      voyagePart: { type: "image_base64", image_base64: `data:${mimeType};base64,${base64}` },
    };
  } catch { return null; }
}

function corpusEmbedText(row: { title: string | null; tags: string[] | null; blurb: string | null }, colors: string[]): string {
  return [
    row.title,
    (row.tags ?? []).join(", "),
    colors.length ? `palette: ${colors.join(", ")}` : null,
    row.blurb,
  ].filter(Boolean).join(". ").slice(0, 1000);
}

function itemEmbedText(row: { ai_caption?: string | null; tags?: string[] | null; fonts?: string[] | null; colors?: string[] | null; title?: string | null }): string {
  return [
    row.ai_caption,
    (row.tags ?? []).join(", "),
    (row.fonts ?? []).join(", "),
    row.colors?.length ? `palette: ${row.colors.join(", ")}` : null,
    row.title,
  ].filter(Boolean).join(". ").slice(0, 1000);
}

/** Embed `batch` corpus rows missing embedding_v2. Returns { embedded, remaining }. */
async function backfillCorpus(batch: number): Promise<{ embedded: number; remaining: number }> {
  const embedder = getEmbedder();
  const useCf = hasCfKey();
  const db = admin();

  const { data } = await db
    .from("web_corpus")
    .select("id,url,title,image,blurb,tags,source")
    .is("embedding_v2", null)
    .order("multi_entry", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(batch);

  let embedded = 0;
  for (const row of data ?? []) {
    const img = row.image ? await fetchImageData(row.image) : null;
    const colors = img ? await extractColorsFromImage(img.buf) : [];
    const palette_lab = img ? await extractLabPalette(img.buf) : [];
    const text = corpusEmbedText(row, colors);
    if (!img && !text) {
      await db.from("web_corpus").delete().eq("id", row.id);
      continue;
    }
    try {
      let embedding_v2: number[];
      if (useCf) {
        embedding_v2 = img && text
          ? await embedder.embedHybrid(img.base64, img.mimeType, text)
          : img
          ? await embedder.embedImage(img.base64, img.mimeType)
          : await embedder.embedText(text);
      } else {
        const content: VoyageContent[] = [];
        if (text) content.push({ type: "text", text });
        if (img) content.push(img.voyagePart);
        embedding_v2 = await voyageEmbed(content, "document");
      }
      const patch: Record<string, unknown> = { embedding_v2, colors };
      if (palette_lab.length) patch.palette_lab = palette_lab;
      await db.from("web_corpus").update(patch).eq("id", row.id);
      embedded++;
    } catch (e) {
      if (/429/.test((e as Error).message)) break; // Voyage rate limited
      // fallback: text-only
      if (text) {
        try {
          const embedding_v2 = await embedder.embedText(text);
          const patch2: Record<string, unknown> = { embedding_v2, colors };
          if (palette_lab.length) patch2.palette_lab = palette_lab;
          await db.from("web_corpus").update(patch2).eq("id", row.id);
          embedded++;
        } catch { /* skip this row */ }
      }
    }
  }

  const { count } = await db
    .from("web_corpus")
    .select("*", { count: "exact", head: true })
    .is("embedding_v2", null);
  return { embedded, remaining: count ?? 0 };
}

/** Embed `batch` library items missing embedding_v2. Returns { embedded, remaining }. */
async function backfillItems(batch: number): Promise<{ embedded: number; remaining: number }> {
  const embedder = getEmbedder();
  const useCf = hasCfKey();
  const db = admin();

  const { data } = await db
    .from("items")
    .select("id,thumb_path,ai_caption,tags,fonts,colors,title")
    .is("embedding_v2", null)
    .not("thumb_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(batch);

  // Signed URLs for private storage
  const thumbPaths = (data ?? []).map((r) => r.thumb_path as string);
  let signedMap = new Map<string, string>();
  if (thumbPaths.length) {
    const { data: signed } = await db.storage.from("media").createSignedUrls(thumbPaths, 60 * 30);
    for (const s of signed ?? []) {
      if (s.signedUrl && s.path) signedMap.set(s.path, s.signedUrl);
    }
  }

  let embedded = 0;
  for (const row of data ?? []) {
    const thumbUrl = signedMap.get(row.thumb_path as string);
    const img = thumbUrl ? await fetchImageData(thumbUrl) : null;
    const text = itemEmbedText(row);
    if (!img && !text) continue;
    try {
      let embedding_v2: number[];
      if (useCf) {
        embedding_v2 = img && text
          ? await embedder.embedHybrid(img.base64, img.mimeType, text)
          : img
          ? await embedder.embedImage(img.base64, img.mimeType)
          : await embedder.embedText(text);
      } else {
        const content: VoyageContent[] = [];
        if (text) content.push({ type: "text", text });
        if (img) content.push(img.voyagePart);
        embedding_v2 = await voyageEmbed(content, "document");
      }
      await db.from("items").update({ embedding_v2 }).eq("id", row.id);
      embedded++;
    } catch (e) {
      if (/429/.test((e as Error).message)) break;
      if (text) {
        try {
          const embedding_v2 = await (embedder instanceof CloudflareEmbedder
            ? embedder.embedText(text)
            : voyageEmbed([{ type: "text", text }], "document"));
          await db.from("items").update({ embedding_v2 }).eq("id", row.id);
          embedded++;
        } catch { /* skip */ }
      }
    }
  }

  const { count } = await db
    .from("items")
    .select("*", { count: "exact", head: true })
    .is("embedding_v2", null);
  return { embedded, remaining: count ?? 0 };
}

/**
 * Fill palette_lab for corpus rows that are already embedded but lack LAB palette data.
 * Downloads the image and runs extractLabPalette — no embedding needed.
 */
async function backfillPaletteLab(batch: number): Promise<{ filled: number; remaining: number }> {
  const db = admin();
  const { data } = await db
    .from("web_corpus")
    .select("id,image")
    .not("embedding_v2", "is", null)
    .is("palette_lab", null)
    .not("image", "is", null)
    .order("created_at", { ascending: true })
    .limit(batch);

  let filled = 0;
  for (const row of data ?? []) {
    const img = row.image ? await fetchImageData(row.image) : null;
    if (!img) continue;
    const palette_lab = await extractLabPalette(img.buf);
    if (!palette_lab.length) continue;
    const { error } = await db.from("web_corpus").update({ palette_lab }).eq("id", row.id);
    if (!error) filled++;
  }

  const { count } = await db
    .from("web_corpus")
    .select("*", { count: "exact", head: true })
    .not("embedding_v2", "is", null)
    .is("palette_lab", null);
  return { filled, remaining: count ?? 0 };
}

/**
 * Fill facets for corpus rows that have tags/blurb but no facets yet.
 * Pure JS inference — no API calls. Runs cheaply on a large batch.
 */
async function backfillFacets(batch: number): Promise<{ filled: number; remaining: number }> {
  const db = admin();
  const { data } = await db
    .from("web_corpus")
    .select("id,tags,blurb")
    .not("embedding_v2", "is", null)
    .is("facets", null)
    .order("created_at", { ascending: true })
    .limit(batch);

  let filled = 0;
  for (const row of data ?? []) {
    const text = [...(row.tags ?? []), row.blurb ?? ""].join(" ");
    const facets = inferFacetsFromText(text);
    if (!Object.keys(facets).length) {
      // Write empty object so the row isn't re-processed
      await db.from("web_corpus").update({ facets: {} }).eq("id", row.id);
    } else {
      const { error } = await db.from("web_corpus").update({ facets }).eq("id", row.id);
      if (!error) filled++;
    }
  }

  const { count } = await db
    .from("web_corpus")
    .select("*", { count: "exact", head: true })
    .not("embedding_v2", "is", null)
    .is("facets", null);
  return { filled, remaining: count ?? 0 };
}

function isAuthorised(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization");
  const cronOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  if (cronOk) return Promise.resolve(true);
  return isAuthed(req);
}

/** GET: Vercel cron or manual trigger — runs maximum batches in one invocation. */
export async function GET(req: Request) {
  if (!(await isAuthorised(req))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!hasCfKey() && !hasVoyageKey()) {
    return Response.json({ error: "no embed key configured" }, { status: 503 });
  }
  try {
    const corpusBatch = hasCfKey() ? CF_CORPUS_BATCH : VOYAGE_CORPUS_BATCH;
    const [corpus, items, paletteLab, facets] = await Promise.all([
      backfillCorpus(corpusBatch),
      backfillItems(hasCfKey() ? CF_ITEMS_BATCH : 4),
      backfillPaletteLab(30),
      backfillFacets(200),
    ]);
    return Response.json({ corpus, items, paletteLab, facets });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}

/** POST { corpus?: number, items?: number, paletteLab?: number, facets?: number }
 *  — manual with custom batch sizes. */
export async function POST(req: Request) {
  if (!(await isAuthorised(req))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!hasCfKey() && !hasVoyageKey()) {
    return Response.json({ error: "no embed key configured" }, { status: 503 });
  }
  const body = await req.json().catch(() => ({}));
  const corpusBatch = Math.min(Math.max(Number(body.corpus ?? (hasCfKey() ? CF_CORPUS_BATCH : VOYAGE_CORPUS_BATCH)), 0), 200);
  const itemsBatch = Math.min(Math.max(Number(body.items ?? 0), 0), 100);
  const paletteBatch = Math.min(Math.max(Number(body.paletteLab ?? 30), 0), 200);
  const facetBatch = Math.min(Math.max(Number(body.facets ?? 200), 0), 500);
  try {
    const out: Record<string, unknown> = {};
    if (corpusBatch > 0) out.corpus = await backfillCorpus(corpusBatch);
    if (itemsBatch > 0) out.items = await backfillItems(itemsBatch);
    if (paletteBatch > 0) out.paletteLab = await backfillPaletteLab(paletteBatch);
    if (facetBatch > 0) out.facets = await backfillFacets(facetBatch);
    return Response.json(out);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
