/**
 * Provider-agnostic embedding interface — Phase 0.
 *
 * Primary:  Jina AI jina-clip-v2 (free tier, 1024-dim, image + text).
 * Fallback: Voyage multimodal-3.5 (1024-dim, 3 RPM on free tier).
 *
 * Env vars:
 *   JINA_API_KEY  — Jina AI API key (free at jina.ai)
 */
import { voyageEmbed, type VoyageContent } from "./voyage";

// ---------- interface ----------

export interface Embedder {
  /** Embedding dimension (1024 for Jina CLIP v2 / Voyage). */
  readonly dims: number;
  embedText(text: string): Promise<number[]>;
  embedImage(imageBase64: string, mimeType: string): Promise<number[]>;
  /** Image + text fused into one vector. */
  embedHybrid(imageBase64: string, mimeType: string, text: string): Promise<number[]>;
}

// ---------- Jina AI CLIP v2 ----------

const JINA_EMBED_URL = "https://api.jina.ai/v1/embeddings";
const JINA_CLIP_MODEL = "jina-clip-v2";

export function hasJinaKey(): boolean {
  return !!process.env.JINA_API_KEY;
}

/** Returns true if a CLIP embedder is available (Jina). */
export function hasClipKey(): boolean {
  return hasJinaKey();
}

/** @deprecated CF CLIP model removed. Use hasClipKey() instead. */
export function hasCfKey(): boolean {
  return false;
}

/** @deprecated HF CLIP not available via inference providers. Use hasJinaKey() instead. */
export function hasHfKey(): boolean {
  return false;
}

async function jinaEmbed(inputs: Array<{ text: string } | { image: string }>): Promise<number[][]> {
  const res = await fetch(JINA_EMBED_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.JINA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: JINA_CLIP_MODEL, input: inputs }),
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`jina-clip ${res.status}: ${msg.slice(0, 300)}`);
  }
  const out = await res.json();
  const vecs: number[][] = (out.data as Array<{ embedding: number[] }>).map((d) => d.embedding);
  if (!vecs.length || vecs[0].length !== 1024) {
    throw new Error(`jina-clip: unexpected shape — got dim ${vecs[0]?.length ?? "?"}`);
  }
  return vecs;
}

export class JinaEmbedder implements Embedder {
  readonly dims = 1024;

  async embedText(text: string): Promise<number[]> {
    const [vec] = await jinaEmbed([{ text: text.slice(0, 1000) }]);
    return vec;
  }

  async embedImage(imageBase64: string, _mimeType: string): Promise<number[]> {
    const [vec] = await jinaEmbed([{ image: imageBase64 }]);
    return vec;
  }

  /**
   * Weighted average of image + text embeddings (both from Jina CLIP v2).
   * Image dominates (0.7) — the visual aesthetic is the primary signal.
   * Both inputs go in a single API call for efficiency.
   */
  async embedHybrid(imageBase64: string, _mimeType: string, text: string): Promise<number[]> {
    if (!text.trim()) return this.embedImage(imageBase64, _mimeType);
    const [imgVec, txtVec] = await jinaEmbed([
      { image: imageBase64 },
      { text: text.slice(0, 1000) },
    ]);
    const w = 0.7;
    return imgVec.map((v, i) => w * v + (1 - w) * txtVec[i]);
  }
}

// ---------- Voyage wrapper (backward compat for items.embedding) ----------

export class VoyageEmbedder implements Embedder {
  readonly dims = 1024;

  async embedText(text: string): Promise<number[]> {
    return voyageEmbed([{ type: "text", text }], "document");
  }

  async embedImage(imageBase64: string, mimeType: string): Promise<number[]> {
    return voyageEmbed(
      [{ type: "image_base64", image_base64: `data:${mimeType};base64,${imageBase64}` }],
      "document"
    );
  }

  async embedHybrid(imageBase64: string, mimeType: string, text: string): Promise<number[]> {
    const content: VoyageContent[] = [];
    if (text.trim()) content.push({ type: "text", text });
    content.push({ type: "image_base64", image_base64: `data:${mimeType};base64,${imageBase64}` });
    return voyageEmbed(content, "document");
  }
}

// ---------- Kept for import compatibility ----------
export class HuggingFaceEmbedder extends JinaEmbedder {}
export class CloudflareEmbedder extends JinaEmbedder {}

// ---------- factory ----------

let _embedder: Embedder | null = null;

/**
 * Returns the best available embedder: Jina CLIP v2 when JINA_API_KEY is set,
 * else Voyage. Result is cached for the process lifetime.
 */
export function getEmbedder(): Embedder {
  if (!_embedder) {
    _embedder = hasJinaKey() ? new JinaEmbedder() : new VoyageEmbedder();
  }
  return _embedder;
}
