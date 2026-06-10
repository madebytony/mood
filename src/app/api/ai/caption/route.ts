import { isAuthed } from "../../_lib/auth";
import { claude, hasKey, parseJson, textOf } from "../../_lib/anthropic";

export const maxDuration = 30;

export async function POST(req: Request) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!hasKey()) return Response.json({ error: "no api key" }, { status: 503 });
  const { imageUrl, title } = await req.json();
  if (!imageUrl) return Response.json({ error: "imageUrl required" }, { status: 400 });
  try {
    const img = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
    const type = img.headers.get("content-type") ?? "image/webp";
    const b64 = Buffer.from(await img.arrayBuffer()).toString("base64");
    const msg = await claude({
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: type, data: b64 } },
            {
              type: "text",
              text: `This is a design reference saved to a moodboard${title ? ` titled "${title}"` : ""}. Reply with JSON only: {"caption": "<one vivid sentence describing the design style, subject and mood — written for later searchability>", "tags": ["<3-6 lowercase tags: style, medium, palette, mood>"]}`,
            },
          ],
        },
      ],
    });
    const out = parseJson(textOf(msg));
    return Response.json({ caption: out.caption ?? null, tags: Array.isArray(out.tags) ? out.tags.slice(0, 6) : [] });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
