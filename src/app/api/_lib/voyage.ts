/**
 * Voyage multimodal embeddings — image + style-caption hybrid vectors.
 * CLIP-family models favour subject over style; interleaving the AI style
 * caption with the pixels pins the aesthetic into the vector.
 */
// Voyage keys work on api.voyageai.com; MongoDB Atlas-issued model keys on ai.mongodb.com.
// We try both and remember which one accepts this key.
const ENDPOINTS = [
  "https://api.voyageai.com/v1/multimodalembeddings",
  "https://ai.mongodb.com/v1/multimodalembeddings",
];
const MODEL = process.env.MOOD_EMBED_MODEL || "voyage-multimodal-3.5";

let workingEndpoint: string | null = process.env.MOOD_EMBED_API || null;

export function hasVoyageKey(): boolean {
  return !!process.env.VOYAGE_API_KEY;
}

export type VoyageContent =
  | { type: "text"; text: string }
  | { type: "image_base64"; image_base64: string };

async function call(api: string, body: string): Promise<Response> {
  return fetch(api, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      "content-type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(30000),
  });
}

export async function voyageEmbed(
  content: VoyageContent[],
  inputType: "document" | "query"
): Promise<number[]> {
  const body = JSON.stringify({ model: MODEL, input_type: inputType, inputs: [{ content }] });
  const tries = workingEndpoint ? [workingEndpoint] : ENDPOINTS;
  let lastErr = "";
  for (const api of tries) {
    const res = await call(api, body);
    if (res.ok) {
      workingEndpoint = api;
      const out = await res.json();
      const emb = out?.data?.[0]?.embedding;
      if (!Array.isArray(emb)) throw new Error("voyage: no embedding in response");
      if (emb.length !== 1024) throw new Error(`voyage: unexpected dimension ${emb.length} (expected 1024)`);
      return emb;
    }
    lastErr = `${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
    // wrong-key-type errors mean "try the other host"; anything else is terminal
    if (res.status !== 401 && res.status !== 403) break;
  }
  throw new Error(`voyage ${lastErr}`);
}
