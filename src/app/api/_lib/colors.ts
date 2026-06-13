import sharp from "sharp";

/**
 * Server-side palette extraction — a faithful port of the client's extractColors/nameOf
 * (src/lib/media.ts) so corpus rows and library items share one colour vocabulary:
 * up to 3 dominant hue buckets (>=8% coverage) + a dark/light tone token.
 *
 * Also exports CIELAB conversion + extractLabPalette for the Phase 2 colour engine.
 */

// ---------- CIELAB colour space ----------

/** sRGB [0-255] → linear (no gamma). */
function linearize(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/** Linear sRGB → XYZ (D65 illuminant). */
function rgbToXyz(r: number, g: number, b: number): [number, number, number] {
  const rl = linearize(r), gl = linearize(g), bl = linearize(b);
  const x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375;
  const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750;
  const z = rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041;
  return [x, y, z];
}

function f(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

/** sRGB [0-255] → CIELAB [L*, a*, b*]. D65 / 2° observer. */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const [x, y, z] = rgbToXyz(r, g, b);
  // D65 reference white
  const fx = f(x / 0.95047), fy = f(y / 1.00000), fz = f(z / 1.08883);
  const L = 116 * fy - 16;
  const a = 500 * (fx - fy);
  const bb = 200 * (fy - fz);
  return [Math.round(L * 10) / 10, Math.round(a * 10) / 10, Math.round(bb * 10) / 10];
}

/** CIE76 delta-E between two LAB colours. */
export function deltaE(lab1: [number, number, number], lab2: [number, number, number]): number {
  return Math.sqrt(
    Math.pow(lab1[0] - lab2[0], 2) +
    Math.pow(lab1[1] - lab2[1], 2) +
    Math.pow(lab1[2] - lab2[2], 2)
  );
}

/**
 * Extract dominant CIELAB colours from an image buffer.
 * Returns 3–5 LAB triples for the most common pixel clusters (>= 5% coverage).
 * Used to populate palette_lab for delta-E colour-verified discovery.
 */
export async function extractLabPalette(buf: Buffer): Promise<Array<[number, number, number]>> {
  try {
    const { data } = await sharp(buf, { limitInputPixels: 80_000_000 })
      .resize(32, 32, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Build a map of quantised RGB → count (quantise to 16-step buckets to cluster nearby shades)
    const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
    const px = data.length / 3;
    for (let i = 0; i < data.length; i += 3) {
      const r = Math.round(data[i] / 16) * 16;
      const g = Math.round(data[i + 1] / 16) * 16;
      const b = Math.round(data[i + 2] / 16) * 16;
      const key = `${r},${g},${b}`;
      const prev = buckets.get(key);
      if (prev) {
        prev.count++;
        // accumulate for weighted-mean centroid
        prev.r += data[i]; prev.g += data[i + 1]; prev.b += data[i + 2];
      } else {
        buckets.set(key, { count: 1, r: data[i], g: data[i + 1], b: data[i + 2] });
      }
    }

    return [...buckets.values()]
      .filter((b) => b.count / px >= 0.05) // >= 5% coverage
      .sort((a, z) => z.count - a.count)
      .slice(0, 5)
      .map((b) => rgbToLab(
        Math.round(b.r / b.count),
        Math.round(b.g / b.count),
        Math.round(b.b / b.count),
      ));
  } catch {
    return [];
  }
}

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
