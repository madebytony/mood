import { isAuthed } from "../../_lib/auth";
import { hasVoyageKey, voyageEmbed, type VoyageContent } from "../../_lib/voyage";
import { getEmbedder, hasCfKey } from "../../_lib/embedder";
import { safeFetch } from "../../_lib/ssrf";

export const maxDuration = 30;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * POST { imageUrl?, text?, input_type? }
 *   -> { embedding: number[], embedding_v2?: number[] }
 *
 * embedding    — 1024-dim Voyage vector (items.embedding, backward compat)
 * embedding_v2 — 512-dim CF CLIP vector (items.embedding_v2, new v2 path)
 *
 * When only CF is configured (no Voyage key), embedding_v2 is returned in the
 * `embedding` field too so existing callers keep working on a 503-free path.
 * The client (embedItem in db.ts) writes both columns when both are present.
 */
export async function POST(req: Request) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!hasVoyageKey() && !hasCfKey()) {
    return Response.json({ error: "no embed key" }, { status: 503 });
  }
  const { imageUrl, text, input_type } = await req.json().catch(() => ({}));
  if (!imageUrl && !text) {
    return Response.json({ error: "imageUrl or text required" }, { status: 400 });
  }

  // Fetch image once; share the buffer across both embedders.
  let imgBuf: Buffer | null = null;
  let imgMime = "image/webp";
  if (typeof imageUrl === "string" && /^https?:\/\//i.test(imageUrl)) {
    try {
      const img = await safeFetch(imageUrl, { signal: AbortSignal.timeout(15000) });
      if (img.ok) {
        const ab = await img.arrayBuffer();
        if (ab.byteLength <= MAX_IMAGE_BYTES) {
          imgBuf = Buffer.from(ab);
          imgMime = img.headers.get("content-type") ?? "image/webp";
        }
      }
    } catch { /* image unavailable — embed text only */ }
  }

  const cleanText = typeof text === "string" ? text.trim().slice(0, 2000) : "";

  try {
    // --- Voyage (1024-dim) ---
    let embedding: number[] | null = null;
    if (hasVoyageKey()) {
      const content: VoyageContent[] = [];
      if (cleanText) content.push({ type: "text", text: cleanText });
      if (imgBuf) {
        content.push({
          type: "image_base64",
          image_base64: `data:${imgMime};base64,${imgBuf.toString("base64")}`,
        });
      }
      if (content.length) {
        embedding = await voyageEmbed(content, input_type === "query" ? "query" : "document");
      }
    }

    // --- CF CLIP (512-dim) ---
    let embedding_v2: number[] | null = null;
    if (hasCfKey()) {
      const embedder = getEmbedder();
      const b64 = imgBuf?.toString("base64") ?? null;
      if (b64 && cleanText) {
        embedding_v2 = await embedder.embedHybrid(b64, imgMime, cleanText);
      } else if (b64) {
        embedding_v2 = await embedder.embedImage(b64, imgMime);
      } else if (cleanText) {
        embedding_v2 = await embedder.embedText(cleanText);
      }
    }

    // When Voyage is absent, promote v2 to the primary embedding field so
    // existing callers (corpusSimilar text-query path) get a usable vector.
    const primary = embedding ?? embedding_v2;
    if (!primary) throw new Error("no embedder produced a result");

    return Response.json({
      embedding: primary,
      ...(embedding_v2 && embedding_v2 !== primary ? { embedding_v2 } : {}),
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
