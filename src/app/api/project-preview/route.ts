import { isAuthed } from "../_lib/auth";
import { safeFetch } from "../_lib/ssrf";
import { clientIp, rateLimit, tooManyRequests } from "../_lib/ratelimit";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/* ── helpers (copied from meta/route.ts) ── */

function pick(html: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) return decodeEntities(m[1].trim());
  }
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function metaTag(prop: string): RegExp[] {
  return [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, "i"),
  ];
}

/* ── image extraction ── */

const JUNK_PATH_RE =
  /favicon|icon[-_]|logo[-_]?|badge|sprite|pixel|tracking|spacer|spinner|loading[-_]|placeholder|avatar|emoji|share[-_]|social[-_]|button|arrow|close[-_]|search[-_]|menu[-_]|hamburger|caret|chevron|check|widget|counter|rating|\.gif$/i;

const JUNK_DOMAIN_RE =
  /google-analytics|googletagmanager|facebook\.com\/tr|doubleclick|analytics\.|pixel\.|beacon\.|gravatar\.com|wp-content\/plugins|platform\.twitter|connect\.facebook/i;

const IMG_TAG_RE = /<img\b([^>]{5,})>/gi;
const SRCSET_RE = /srcset=["']([^"']+)["']/i;
const WIDTH_RE = /width=["']?(\d+)/i;
const HEIGHT_RE = /height=["']?(\d+)/i;
const BG_RE = /background(?:-image)?:\s*url\(["']?([^"')\s]+)["']?\)/gi;

/** From a srcset string, return the URL of the largest candidate. */
function bestFromSrcset(srcset: string): string | null {
  const candidates = srcset.split(",").map((s) => {
    const parts = s.trim().split(/\s+/);
    const url = parts[0];
    const desc = parts[1] ?? "";
    const w = /(\d+)w/.exec(desc)?.[1];
    const x = /([\d.]+)x/.exec(desc)?.[1];
    return { url, weight: w ? Number(w) : x ? Number(x) * 1000 : 0 };
  });
  candidates.sort((a, b) => b.weight - a.weight);
  return candidates[0]?.url ?? null;
}

/** Try multiple source attributes for lazy-loaded images. */
function extractSrc(attrs: string): string | null {
  for (const re of [
    /data-src=["']([^"']+)["']/i,
    /data-lazy-src=["']([^"']+)["']/i,
    /data-original=["']([^"']+)["']/i,
    /src=["']([^"']+)["']/i,
  ]) {
    const m = re.exec(attrs);
    if (m?.[1]) return m[1];
  }
  return null;
}

function isMeaningful(url: string, attrs: string): boolean {
  if (/^data:/i.test(url)) return false;
  if (/^javascript:/i.test(url)) return false;
  if (/\.svg(\?|$)/i.test(url)) return false;
  if (/\.ico(\?|$)/i.test(url)) return false;
  if (JUNK_PATH_RE.test(url)) return false;
  if (JUNK_DOMAIN_RE.test(url)) return false;
  const w = WIDTH_RE.exec(attrs)?.[1];
  const h = HEIGHT_RE.exec(attrs)?.[1];
  if (w && Number(w) < 100) return false;
  if (h && Number(h) < 100) return false;
  if (/class=["'][^"']*\b(icon|logo|avatar|badge|social)\b/i.test(attrs)) return false;
  return true;
}

function resolve(raw: string, base: URL): string | null {
  try {
    return new URL(raw.trim(), base).href;
  } catch {
    return null;
  }
}

function extractImages(html: string, base: URL): string[] {
  const seen = new Set<string>();
  const images: string[] = [];

  function add(url: string | null) {
    if (!url) return;
    const norm = url.replace(/\/+$/, "");
    if (seen.has(norm)) return;
    seen.add(norm);
    images.push(url);
  }

  // 1. OG / Twitter image first
  let og =
    pick(html, metaTag("og:image")) ??
    pick(html, metaTag("og:image:url")) ??
    pick(html, metaTag("twitter:image"));
  if (og) add(resolve(og, base));

  // 2. <img> tags
  IMG_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMG_TAG_RE.exec(html)) !== null) {
    const attrs = m[1];
    // Try srcset first for highest-res candidate
    const srcsetMatch = SRCSET_RE.exec(attrs);
    let src = srcsetMatch ? bestFromSrcset(srcsetMatch[1]) : null;
    if (!src) src = extractSrc(attrs);
    if (!src) continue;
    const resolved = resolve(src, base);
    if (resolved && isMeaningful(resolved, attrs)) add(resolved);
  }

  // 3. background-image: url(...) in inline styles
  BG_RE.lastIndex = 0;
  while ((m = BG_RE.exec(html)) !== null) {
    const resolved = resolve(m[1], base);
    if (resolved && isMeaningful(resolved, "")) add(resolved);
  }

  return images.slice(0, 20);
}

/* ── route handler ── */

export async function GET(req: Request) {
  if (!(await isAuthed(req))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const rl = rateLimit(`preview:${clientIp(req)}`, 30, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  const url = new URL(req.url).searchParams.get("url");
  if (!url || !/^https?:\/\//i.test(url)) {
    return Response.json({ error: "valid url required" }, { status: 400 });
  }

  try {
    const res = await safeFetch(url, {
      headers: { "user-agent": UA, accept: "text/html,*/*" },
      signal: AbortSignal.timeout(12000),
    });
    const html = (await res.text()).slice(0, 600_000);
    const base = new URL(res.url || url);

    const title =
      pick(html, metaTag("og:title")) ??
      pick(html, [/<title[^>]*>([^<]+)<\/title>/i]);

    const images = extractImages(html, base);

    return Response.json({ title, url: base.href, images });
  } catch (e) {
    if ((e as Error).message?.startsWith("blocked")) {
      return Response.json({ error: "url not allowed" }, { status: 400 });
    }
    return Response.json({ title: null, url, images: [] }, { status: 200 });
  }
}
