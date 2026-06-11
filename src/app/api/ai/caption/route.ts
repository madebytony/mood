import { isAuthed } from "../../_lib/auth";
import { gemini, geminiDisabled, geminiText, hasGeminiKey, parseJson } from "../../_lib/gemini";
import { safeFetch } from "../../_lib/ssrf";

export const maxDuration = 30;

export async function POST(req: Request) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!hasGeminiKey() || geminiDisabled()) return Response.json({ error: "no api key" }, { status: 503 });
  const { imageUrl, title, kind } = await req.json();
  if (!imageUrl) return Response.json({ error: "imageUrl required" }, { status: 400 });
  try {
    const img = await safeFetch(imageUrl, { signal: AbortSignal.timeout(15000) });
    if (!img.ok) throw new Error(`image fetch ${img.status}`);
    const type = img.headers.get("content-type") ?? "image/webp";
    const b64 = Buffer.from(await img.arrayBuffer()).toString("base64");

    const prompt = kind === "type"
      ? `This is a type specimen, font sample, or typographic design saved to a moodboard${title ? ` titled "${title}"` : ""}. Reply with JSON only: {"caption": "<one vivid sentence describing the typeface's character — classification, personality, formal qualities, and ideal use cases — written for later searchability>", "tags": ["<3-8 lowercase tags drawn from: classification (serif/sans-serif/display/script/monospace), style (geometric/humanist/grotesque/transitional/experimental/variable), use-case (editorial/brand/digital/poster/body-text), mood (elegant/expressive/technical/neutral/bold)>"], "fonts": ["<font or foundry names visible or identifiable in the image — empty array if uncertain>"]}`
      : `This is a design reference saved to a moodboard${title ? ` titled "${title}"` : ""}. Reply with JSON only: {"caption": "<one vivid sentence describing the design style, subject and mood — written for later searchability>", "tags": ["<3-6 lowercase tags: style, medium, palette, mood>"]}`;

    const res = await gemini({
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType: type, data: b64 } },
          { text: prompt },
        ],
      }],
      generationConfig: { maxOutputTokens: 400, responseMimeType: "application/json" },
    });
    const out = JSON.parse(geminiText(res));
    return Response.json({
      caption: out.caption ?? null,
      tags: Array.isArray(out.tags) ? out.tags.slice(0, 8) : [],
      fonts: kind === "type" && Array.isArray(out.fonts) ? out.fonts.slice(0, 6) : undefined,
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
