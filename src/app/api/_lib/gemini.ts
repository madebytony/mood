const API = "https://generativelanguage.googleapis.com/v1beta/models";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

export function hasGeminiKey(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

let billingDisabled = false;
export function geminiDisabled(): boolean { return billingDisabled; }

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
  if (billingDisabled) throw new Error("gemini disabled: billing");
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
    if (res.status === 402) billingDisabled = true;
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
