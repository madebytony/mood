export function extFor(type: string): string {
  const m: Record<string, string> = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
    "image/gif": "gif", "image/svg+xml": "svg", "image/avif": "avif",
  };
  return m[type] ?? "jpg";
}

/** Minimal JPEG/PNG dimension sniffing (no native deps). */
export function imageDims(buf: Uint8Array<ArrayBuffer>, type: string): { w: number | null; h: number | null } {
  const b = buf;
  try {
    if (type === "image/png" && b.length > 24) {
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      return { w: dv.getUint32(16), h: dv.getUint32(20) };
    }
    if (type === "image/jpeg") {
      let i = 2;
      while (i < b.length - 9) {
        if (b[i] !== 0xff) break;
        const marker = b[i + 1];
        const len = (b[i + 2] << 8) | b[i + 3];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { w: (b[i + 7] << 8) | b[i + 8], h: (b[i + 5] << 8) | b[i + 6] };
        }
        i += 2 + len;
      }
    }
  } catch {}
  return { w: null, h: null };
}

export async function sha1hex(buf: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
