import { isAuthed } from "../../_lib/auth";
import { gemini, geminiDisabled, geminiText, hasGeminiKey } from "../../_lib/gemini";

export const maxDuration = 30;

/**
 * POST { items: [{caption, tags, colors, title}], name? } -> { brief }
 * Distils one board's saved references into a named aesthetic — a reusable style brief
 * that steers web discovery ("Explore this board's style") and reads as a project artifact.
 */
export async function POST(req: Request) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!hasGeminiKey() || geminiDisabled()) return Response.json({ error: "no api key" }, { status: 503 });
  const { items, name } = await req.json().catch(() => ({}));
  if (!Array.isArray(items) || !items.length) {
    return Response.json({ error: "items required" }, { status: 400 });
  }
  try {
    const lines = items
      .slice(0, 30)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((i: any) =>
        [
          typeof i.caption === "string" ? i.caption.slice(0, 300) : null,
          Array.isArray(i.tags) && i.tags.length ? i.tags.slice(0, 14).join(", ") : null,
          Array.isArray(i.colors) && i.colors.length ? `palette: ${i.colors.join(", ")}` : null,
        ]
          .filter(Boolean)
          .join(" — ")
      )
      .filter(Boolean)
      .join("\n");
    if (!lines) return Response.json({ error: "no described items" }, { status: 400 });

    const res = await gemini({
      contents: [{
        role: "user",
        parts: [{ text: `Below are AI descriptions of every reference a designer saved to one project moodboard${name ? ` called "${name}"` : ""} — one line per item. Distil the board's COLLECTIVE aesthetic into a single search brief.

Items:
${lines}

Weight traits that recur across many items; ignore one-off outliers. Reply with JSON only:
{"brief": "<max 35 words: colour palette character and dominant hues, typography style, layout tendencies, overall mood — written as comma-separated descriptive phrases a web search for visually similar sites could match. No site names, no subject matter>"}` }],
      }],
      generationConfig: { maxOutputTokens: 300, responseMimeType: "application/json" },
    });
    const out = JSON.parse(geminiText(res));
    const brief = typeof out.brief === "string" ? out.brief.trim().slice(0, 300) : null;
    if (!brief) return Response.json({ error: "no brief" }, { status: 502 });
    return Response.json({ brief });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
