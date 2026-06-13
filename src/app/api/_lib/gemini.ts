const API = "https://generativelanguage.googleapis.com/v1beta/models";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

export function hasGeminiKey(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

// Time-boxed circuit breaker. Billing/rate limits (402/429) back off for minutes; transient
// overloads (503/529) only briefly, since those clear in seconds (and we retry them inline first).
let disabledUntil = 0;
const COOLDOWN_MS = 5 * 60_000;
const OVERLOAD_COOLDOWN_MS = 45_000;
export function geminiDisabled(): boolean { return Date.now() < disabledUntil; }

const RETRYABLE = new Set([429, 503, 529]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const url = `${API}/${MODEL}:generateContent`;
  // Disable thinking by default — none of our routes benefit from extended reasoning,
  // and thinking tokens slow responses and cost extra on 2.5+ models.
  const merged: GeminiBody = {
    ...body,
    generationConfig: { thinkingConfig: { thinkingBudget: 0 }, ...body.generationConfig },
  };
  // Gemini's google_search grounding 503s in brief spikes that clear within a second or two, so
  // retry transient statuses inline (short backoff) before giving up — this is what was dropping
  // "similar"/Discover to the seed/Are.na fallback. Only trip the circuit breaker once retries fail.
  let lastErr = new Error("gemini: no attempt");
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250)); // ~0.6s, ~1.1s
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! },
      body: JSON.stringify(merged),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return res.json();
    const err = await res.text().catch(() => "");
    lastErr = new Error(`gemini ${res.status}: ${err.slice(0, 200)}`);
    if (res.status === 402) { disabledUntil = Date.now() + COOLDOWN_MS; throw lastErr; } // billing — back off long
    if (res.status === 429) { disabledUntil = Date.now() + COOLDOWN_MS; throw lastErr; } // rate limit — back off long
    if (!RETRYABLE.has(res.status)) throw lastErr; // 400/401/403 etc — not worth retrying
    // 503/529 overload — fall through to retry
  }
  disabledUntil = Date.now() + OVERLOAD_COOLDOWN_MS; // sustained overload — brief breather only
  throw lastErr;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function geminiText(response: any): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (response?.candidates?.[0]?.content?.parts ?? []).filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join("\n");
}

/** Pull the first JSON object/array out of a model reply.
 *  If the result is an object with a single array value (e.g. {"picks": [...]}), unwrap it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseJson(text: string): any {
  const m = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (!m) throw new Error("no json in reply");
  const parsed = JSON.parse(m[1]);
  // Unwrap common wrapper objects: {"results": [...]} or {"picks": [...]}
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const vals = Object.values(parsed);
    if (vals.length === 1 && Array.isArray(vals[0])) return vals[0];
  }
  return parsed;
}

export { MODEL };
