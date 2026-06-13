/**
 * Provider-agnostic embedding interface — Phase 0.
 *
 * Primary:  HuggingFace Inference API CLIP ViT-B/32 (free tier, 512-dim, ~1k req/day).
 * Fallback: Voyage multimodal-3.5 (1024-dim, 3 RPM on free tier) — kept for
 *           backward compat on the existing items.embedding column.
 *
 * NOTE: Cloudflare Workers AI (@cf/openai/clip-vit-base-patch32) was removed from
 * CF's public catalog. HuggingFace hosts the same model with a compatible API.
 *
 * Env vars:
 *   HF_API_TOKEN    — HuggingFace API token (read access is sufficient)
 */
import { voyageEmbed, type VoyageContent } from "./voyage";

// ---------- interface ----------

export interface Embedder {
  /** Embedding dimension (512 for CLIP, 1024 for Voyage). */
  readonly dims: number;
  embedText(text: string): Promise<number[]>;
  embedImage(imageBase64: string, mimeType: string): Promise<number[]>;
  /** Image + text fused into one vector. */
  embedHybrid(imageBase64: string, mimeType: string, text: string): Promise<number[]>;
}

// ---------- HuggingFace Inference API CLIP ViT-B/32 ----------

const HF_CLIP_URL =
  "https://api-inference.huggingface.co/models/openai/clip-vit-base-patch32";

export function hasHfKey(): boolean {
  return !!process.env.HF_API_TOKEN;
}

/** Returns true if a free 512-dim CLIP embedder is available (HF). */
export function hasClipKey(): boolean {
  return hasHfKey();
}

/** @deprecated CF CLIP model removed from catalog. Use hasClipKey() instead. */
export function hasCfKey(): boolean {
  return false;
}

async function hfTextCall(text: string): Promise<number[]> {
  const res = await fetch(HF_CLIP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.HF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inputs: text.slice(0, 1000) }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`hf-clip-text ${res.status}: ${msg.slice(0, 200)}`);
  }
  const out = await res.json();
  // HF feature-extraction returns [[...512 floats...]]
  const vec = Array.isArray(out?.[0]) ? out[0] : Array.isArray(out) ? out : null;
  if (!vec || vec.length !== 512) throw new Error("hf-clip-text: unexpected response shape");
  return vec as number[];
}

async function hfImageCall(imageBase64: string): Promise<number[]> {
  const buf = Buffer.from(imageBase64, "base64");
  const res = await fetch(HF_CLIP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.HF_API_TOKEN}`,
      "Content-Type": "application/octet-stream",
    },
    body: buf,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`hf-clip-image ${res.status}: ${msg.slice(0, 200)}`);
  }
  const out = await res.json();
  const vec = Array.isArray(out?.[0]) ? out[0] : Array.isArray(out) ? out : null;
  if (!vec || vec.length !== 512) throw new Error("hf-clip-image: unexpected response shape");
  return vec as number[];
}

export class HuggingFaceEmbedder implements Embedder {
  readonly dims = 512;

  async embedText(text: string): Promise<number[]> {
    return hfTextCall(text);
  }

  async embedImage(imageBase64: string, _mimeType: string): Promise<number[]> {
    return hfImageCall(imageBase64);
  }

  /**
   * Weighted average of image + text embeddings.
   * Image dominates (0.7) — the visual aesthetic is the primary signal;
   * text (title/tags) provides secondary semantic context.
   */
  async embedHybrid(imageBase64: string, mimeType: string, text: string): Promise<number[]> {
    const [imgVec, txtVec] = await Promise.all([
      this.embedImage(imageBase64, mimeType),
      text.trim() ? this.embedText(text) : Promise.resolve(null as number[] | null),
    ]);
    if (!txtVec) return imgVec;
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

// ---------- Kept for import compatibility in backfill route ----------
export class CloudflareEmbedder extends HuggingFaceEmbedder {}

// ---------- factory ----------

let _embedder: Embedder | null = null;

/**
 * Returns the best available embedder: HuggingFace CLIP when HF_API_TOKEN is set,
 * else Voyage. Result is cached for the process lifetime.
 */
export function getEmbedder(): Embedder {
  if (!_embedder) {
    _embedder = hasHfKey() ? new HuggingFaceEmbedder() : new VoyageEmbedder();
  }
  return _embedder;
}
