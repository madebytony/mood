import { isAuthed } from "../../_lib/auth";
import { gemini, geminiDisabled, geminiText, hasGeminiKey } from "../../_lib/gemini";

export const maxDuration = 30;

export async function POST(req: Request) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!hasGeminiKey() || geminiDisabled()) return Response.json({ error: "no api key" }, { status: 503 });
  const { query, items } = await req.json();
  if (!query || !Array.isArray(items)) return Response.json({ error: "query + items required" }, { status: 400 });
  try {
    const summaries = items.slice(0, 250).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (i: any) => `${i.id} | ${i.title ?? ""} | ${(i.tags ?? []).join(",")} | ${(i.fonts ?? []).join(",")} | ${i.caption ?? ""} | ${i.domain ?? ""}`
    ).join("\n");
    const res = await gemini({
      contents: [{
        role: "user",
        parts: [{ text: `A designer is searching their moodboard library for: "${query}"\n\nItems (id | title | tags | fonts | caption | source):\n${summaries}\n\nReply with JSON only: {"ids": ["<ids of matching items, best first, max 40 — only genuinely relevant ones>"]}` }],
      }],
      generationConfig: { maxOutputTokens: 800, responseMimeType: "application/json" },
    });
    const out = JSON.parse(geminiText(res));
    return Response.json({ ids: Array.isArray(out.ids) ? out.ids : [] });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
