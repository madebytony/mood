const API = "https://generativelanguage.googleapis.com/v1beta/models";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

export function hasGeminiKey(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

// Time-boxed circuit breaker: a 402/429/503/529 backs Gemini off for a few minutes rather than
// for the whole instance lifetime, so a transient quota/overload blip doesn't disable AI until the
// serverless instance recycles. Re-probes automatically once the window passes.
let disabledUntil = 0;
const COOLDOWN_MS = 5 * 60_000;
export function geminiDisabled(): boolean { return Date.now() < disabledUntil; }

type TextPart = { text: string };
type ImagePart = { inlineData: { mimeType: string; data: string } };
type Part = TextPart | ImagePart;

interface GeminiBody {
  contents: Array<{ role: "user" | "model"; parts: Part[] }>;
  tools?: Array<{ google_search: Record<string, never> }>;
  generationConfig?: { maxOutputTokens?: number; responseMimeType?: string; thinkingConfig?: { thinkingBudget: number } };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function gemini(body: GeminiBody, timeoutMs = 45000): Promise<any> {
  if (geminiDisabled()) throw new Error("gemini disabled: cooling down");
  const url = `${API}/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  // Disable thinking by default — none of our routes benefit from extended reasoning,
  // and thinking tokens slow responses and cost extra on 2.5+ models.
  const merged: GeminiBody = {
    ...body,
    generationConfig: { thinkingConfig: { thinkingBudget: 0 }, ...body.generationConfig },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(merged),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    // 402 billing, 429 rate limit, 503/529 overload — all transient enough to warrant a backoff.
    if ([402, 429, 503, 529].includes(res.status)) disabledUntil = Date.now() + COOLDOWN_MS;
    throw new Error(`gemini ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function geminiText(response: any): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (response?.candidates?.[0]?.content?.parts ?? []).filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join("\n");
}

/** Pull the first JSON object/array out of a model reply. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseJson(text: string): any {
  const m = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (!m) throw new Error("no json in reply");
  return JSON.parse(m[1]);
}

export { MODEL };
