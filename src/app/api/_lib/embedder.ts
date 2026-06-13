/**
 * Provider-agnostic embedding interface — Phase 0.
 *
 * Primary:  Cloudflare Workers AI CLIP ViT-B/32 (free tier, 512-dim, no rate limit).
 * Fallback: Voyage multimodal-3.5 (1024-dim, 3 RPM on free tier) — kept for
 *           backward compat on the existing items.embedding column.
 *
 * Env vars required for Cloudflare:
 *   CF_ACCOUNT_ID   — Cloudflare account ID
 *   CF_API_TOKEN    — API token with "Workers AI" permission
 */
import sharp from "sharp";
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

// ---------- Cloudflare Workers AI CLIP ViT-B/32 ----------

const CF_URL = (id: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${id}/ai/run/@cf/openai/clip-vit-base-patch32`;

export function hasCfKey(): boolean {
  return !!(process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN);
}

async function cfCall(body: Record<string, unknown>): Promise<number[]> {
  const res = await fetch(CF_URL(process.env.CF_ACCOUNT_ID!), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`cf-clip ${res.status}: ${msg.slice(0, 200)}`);
  }
  const out = await res.json();
  // { result: { shape: [1,512], data: [[...]] }, success: true }
  const data = out?.result?.data;
  const vec = Array.isArray(data?.[0]) ? data[0] : Array.isArray(data) ? data : null;
  if (!vec) throw new Error("cf-clip: unexpected response shape");
  return vec as number[];
}

/**
 * Resize and convert any image to the 224×224 RGB pixel array CLIP expects.
 * Returns a flat uint8 array of length 224*224*3 = 150,528.
 */
async function toClipPixels(imageBase64: string): Promise<number[]> {
  const buf = Buffer.from(imageBase64, "base64");
  const raw = await sharp(buf)
    .resize(224, 224, { fit: "cover", position: "centre" })
    .removeAlpha()
    .raw()
    .toBuffer();
  return Array.from(new Uint8Array(raw));
}

export class CloudflareEmbedder implements Embedder {
  readonly dims = 512;

  async embedText(text: string): Promise<number[]> {
    return cfCall({ text: text.slice(0, 1000) });
  }

  async embedImage(imageBase64: string, _mimeType: string): Promise<number[]> {
    const pixels = await toClipPixels(imageBase64);
    return cfCall({ image: pixels });
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

// ---------- factory ----------

let _embedder: Embedder | null = null;

/**
 * Returns the best available embedder: Cloudflare CLIP when CF env vars are set,
 * else Voyage. Result is cached for the process lifetime.
 */
export function getEmbedder(): Embedder {
  if (!_embedder) {
    _embedder = hasCfKey() ? new CloudflareEmbedder() : new VoyageEmbedder();
  }
  return _embedder;
}
