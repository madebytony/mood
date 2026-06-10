/**
 * Client-side media pipeline:
 * decode -> resize (max 2400px) -> WebP (JPEG fallback) -> sha1 -> upload full + ~480px thumb.
 * Also extracts a small named-colour palette for colour search.
 */
import { supabase } from "./supabase";

const MAX_FULL = 2400;
const MAX_THUMB = 480;
export const THUMB_W = 480;
export const THUMB_MAX_H = 1040; // tall pages: sharp top-crop instead of a squashed strip

export interface ProcessedImage {
  fullBlob: Blob;
  thumbBlob: Blob;
  width: number;
  height: number;
  ext: string;
  hash: string;
  colors: string[];
}

async function decode(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(blob);
  } catch {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = reject;
      img.src = url;
    });
  }
}

function dims(src: ImageBitmap | HTMLImageElement) {
  const w = "naturalWidth" in src ? src.naturalWidth : src.width;
  const h = "naturalHeight" in src ? src.naturalHeight : src.height;
  return { w, h };
}

function drawScaled(src: ImageBitmap | HTMLImageElement, maxDim: number): HTMLCanvasElement {
  const { w, h } = dims(src);
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Thumbnail scaled by WIDTH (sharp in masonry columns); very tall images crop to the top. */
function drawThumb(src: ImageBitmap | HTMLImageElement): HTMLCanvasElement {
  const { w, h } = dims(src);
  const scale = Math.min(1, THUMB_W / w);
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const cropH = Math.min(th, THUMB_MAX_H);
  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = cropH;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, cropH / scale, 0, 0, tw, cropH);
  return canvas;
}

function encode(canvas: HTMLCanvasElement, quality: number): Promise<{ blob: Blob; ext: string }> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (webp) => {
        if (webp && webp.type === "image/webp") {
          resolve({ blob: webp, ext: "webp" });
          return;
        }
        canvas.toBlob(
          (jpg) => (jpg ? resolve({ blob: jpg, ext: "jpg" }) : reject(new Error("encode failed"))),
          "image/jpeg",
          0.85
        );
      },
      "image/webp",
      quality
    );
  });
}

async function sha1(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/* ---------- colour intelligence ---------- */

export const COLOR_HEX: Record<string, string> = {
  black: "#111114", white: "#f2f2f2", gray: "#8a8a93", red: "#e5484d",
  orange: "#f76b15", yellow: "#ffe629", green: "#46a758", teal: "#12a594",
  blue: "#0090ff", purple: "#8e4ec6", pink: "#e93d82", brown: "#ad7f58",
  dark: "#17171c", light: "#26262d",
};

/** First real colour from an item's palette, for paint-while-loading placeholders. */
export function dominantHex(colors: string[] | null | undefined): string {
  for (const c of colors ?? []) {
    if (c !== "dark" && c !== "light" && COLOR_HEX[c]) return COLOR_HEX[c];
  }
  return (colors ?? []).includes("light") ? COLOR_HEX.light : COLOR_HEX.dark;
}

export const COLOR_NAMES = [
  "black", "white", "gray", "red", "orange", "yellow",
  "green", "teal", "blue", "purple", "pink", "brown",
] as const;

function nameOf(r: number, g: number, b: number): string {
  const mx = Math.max(r, g, b) / 255;
  const mn = Math.min(r, g, b) / 255;
  const l = (mx + mn) / 2;
  const d = mx - mn;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s < 0.12) return l < 0.16 ? "black" : l > 0.85 ? "white" : "gray";
  let h = 0;
  const rr = r / 255, gg = g / 255, bb = b / 255;
  if (mx === rr) h = ((gg - bb) / d) % 6;
  else if (mx === gg) h = (bb - rr) / d + 2;
  else h = (rr - gg) / d + 4;
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

export function extractColors(canvas: HTMLCanvasElement): string[] {
  const small = document.createElement("canvas");
  small.width = 24;
  small.height = 24;
  const ctx = small.getContext("2d")!;
  ctx.drawImage(canvas, 0, 0, 24, 24);
  const { data } = ctx.getImageData(0, 0, 24, 24);
  const counts = new Map<string, number>();
  let lum = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 64) continue;
    const name = nameOf(data[i], data[i + 1], data[i + 2]);
    counts.set(name, (counts.get(name) ?? 0) + 1);
    lum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  const total = data.length / 4;
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .filter(([, n]) => n / total >= 0.08)
    .slice(0, 3)
    .map(([name]) => name);
  const tone = lum / total < 110 ? "dark" : "light";
  return [...new Set([...top, tone])];
}

/* ---------- pipeline ---------- */

export async function processImage(blob: Blob): Promise<ProcessedImage> {
  const src = await decode(blob);
  const { w, h } = dims(src);
  void MAX_THUMB;
  const thumbCanvas = drawThumb(src);
  const colors = extractColors(thumbCanvas);

  if (blob.type === "image/gif" || blob.type === "image/svg+xml") {
    const { blob: thumbBlob } = await encode(thumbCanvas, 0.75);
    const hash = await sha1(blob);
    return {
      fullBlob: blob,
      thumbBlob,
      width: w,
      height: h,
      ext: blob.type === "image/gif" ? "gif" : "svg",
      hash,
      colors,
    };
  }

  const fullCanvas = drawScaled(src, MAX_FULL);
  const { blob: fullBlob, ext } = await encode(fullCanvas, 0.8);
  const { blob: thumbBlob } = await encode(thumbCanvas, 0.75);
  const hash = await sha1(fullBlob);
  return {
    fullBlob,
    thumbBlob,
    width: fullCanvas.width,
    height: fullCanvas.height,
    ext,
    hash,
    colors,
  };
}

export interface UploadedMedia {
  storage_path: string;
  thumb_path: string;
  width: number;
  height: number;
}

export async function uploadProcessed(p: ProcessedImage): Promise<UploadedMedia> {
  const storage_path = `media/${p.hash}.${p.ext}`;
  const thumb_path = `thumbs/${p.hash}.${p.ext === "gif" || p.ext === "svg" ? "webp" : p.ext}`;
  const bucket = supabase.storage.from("media");

  const [a, b] = await Promise.all([
    bucket.upload(storage_path, p.fullBlob, { upsert: true, contentType: p.fullBlob.type }),
    bucket.upload(thumb_path, p.thumbBlob, { upsert: true, contentType: p.thumbBlob.type }),
  ]);
  if (a.error) throw a.error;
  if (b.error) throw b.error;

  return { storage_path, thumb_path, width: p.width, height: p.height };
}
