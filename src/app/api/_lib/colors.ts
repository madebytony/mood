import sharp from "sharp";

/**
 * Server-side palette extraction — a faithful port of the client's extractColors/nameOf
 * (src/lib/media.ts) so corpus rows and library items share one colour vocabulary:
 * up to 3 dominant hue buckets (>=8% coverage) + a dark/light tone token.
 */

function nameOf(r: number, g: number, b: number): string {
  const mx = Math.max(r, g, b) / 255;
  const mn = Math.min(r, g, b) / 255;
  const l = (mx + mn) / 2;
  const d = mx - mn;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s < 0.12) return l < 0.16 ? "black" : l > 0.85 ? "white" : "gray";
  let h = 0;
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const dd = mx - mn;
  if (mx === rr) h = ((gg - bb) / dd) % 6;
  else if (mx === gg) h = (bb - rr) / dd + 2;
  else h = (rr - gg) / dd + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 345) return "red";
  if (h < 42) return l < 0.35 ? "brown" : "orange";
  if (h < 70) return "yellow";
  if (h < 160) return "green";
  if (h < 200) return "teal";
  if (h < 250) return "blue";
  if (h < 290) return "purple";
  return "pink";
}

/** Dominant named colours of an image buffer. [] on any failure — palette is enrichment,
 *  never a hard dependency. */
export async function extractColorsFromImage(buf: Buffer): Promise<string[]> {
  try {
    const { data } = await sharp(buf, { limitInputPixels: 80_000_000 })
      .resize(24, 24, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const counts = new Map<string, number>();
    let lum = 0;
    const px = data.length / 3;
    for (let i = 0; i < data.length; i += 3) {
      const name = nameOf(data[i], data[i + 1], data[i + 2]);
      counts.set(name, (counts.get(name) ?? 0) + 1);
      lum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .filter(([, n]) => n / px >= 0.08)
      .slice(0, 3)
      .map(([name]) => name);
    const tone = lum / px < 110 ? "dark" : "light";
    return [...new Set([...top, tone])];
  } catch {
    return [];
  }
}

export const toneOf = (colors: string[]): "dark" | "light" | null =>
  colors.includes("dark") ? "dark" : colors.includes("light") ? "light" : null;

export const huesOf = (colors: string[]): string[] => colors.filter((c) => c !== "dark" && c !== "light");

/** Jaccard overlap of hue buckets — 0 when either side is empty. */
export function hueOverlap(a: string[], b: string[]): number {
  const ha = new Set(huesOf(a)), hb = new Set(huesOf(b));
  if (!ha.size || !hb.size) return 0;
  let inter = 0;
  for (const h of ha) if (hb.has(h)) inter++;
  return inter / (ha.size + hb.size - inter);
}
