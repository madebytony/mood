const API = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.MOOD_AI_MODEL || "claude-haiku-4-5-20251001";
const SMART_MODEL = process.env.MOOD_AI_SMART_MODEL || "claude-sonnet-4-6";

export function hasKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function claude(body: Record<string, any>, timeoutMs = 45000): Promise<any> {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`anthropic ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function textOf(msg: any): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (msg?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}

/** Pull the first JSON object/array out of a model reply. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseJson(text: string): any {
  const m = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (!m) throw new Error("no json in reply");
  return JSON.parse(m[1]);
}

export { MODEL, SMART_MODEL };
