import { isAuthed } from "../../_lib/auth";
import { hasVoyageKey, voyageEmbed, type VoyageContent } from "../../_lib/voyage";
import { safeFetch } from "../../_lib/ssrf";

export const maxDuration = 30;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * POST { imageUrl?, text?, input_type? } -> { embedding: number[] }
 * Image + text together produce one hybrid vector (style caption anchors taste).
 */
export async function POST(req: Request) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!hasVoyageKey()) return Response.json({ error: "no voyage key" }, { status: 503 });
  const { imageUrl, text, input_type } = await req.json().catch(() => ({}));
  if (!imageUrl && !text) {
    return Response.json({ error: "imageUrl or text required" }, { status: 400 });
  }
  try {
    const content: VoyageContent[] = [];
    if (typeof text === "string" && text.trim()) {
      content.push({ type: "text", text: text.trim().slice(0, 2000) });
    }
    if (typeof imageUrl === "string" && /^https?:\/\//i.test(imageUrl)) {
      const img = await safeFetch(imageUrl, { signal: AbortSignal.timeout(15000) });
      if (!img.ok) throw new Error(`image fetch ${img.status}`);
      const buf = await img.arrayBuffer();
      if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error("image too large to embed");
      const type = img.headers.get("content-type") ?? "image/webp";
      content.push({
        type: "image_base64",
        image_base64: `data:${type};base64,${Buffer.from(buf).toString("base64")}`,
      });
    }
    const embedding = await voyageEmbed(content, input_type === "query" ? "query" : "document");
    return Response.json({ embedding });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
