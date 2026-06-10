import { isAuthed } from "../_lib/auth";
import { claude, hasKey, parseJson, textOf, SMART_MODEL } from "../_lib/anthropic";

export const maxDuration = 60;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface Suggestion {
  url: string;
  title: string | null;
  image: string | null;
  domain: string;
  source: string;
  blurb?: string | null;
}

/* ---------------- gallery aggregation ---------------- */

const GALLERIES: { name: string; url: string }[] = [
  { name: "siteinspire", url: "https://www.siteinspire.com" },
  { name: "httpster", url: "https://httpster.net" },
  { name: "minimal.gallery", url: "https://minimal.gallery" },
  { name: "godly", url: "https://godly.website" },
  { name: "land-book", url: "https://land-book.com" },
  { name: "dark.design", url: "https://www.dark.design" },
];

// Hand-picked fallback so Discover is never empty (refreshed by live sources when reachable)
const SEEDS: Suggestion[] = [
  { url: "https://www.awwwards.com/websites/sites_of_the_day/", title: "Awwwards — Sites of the Day", image: null, domain: "awwwards.com", source: "seed" },
  { url: "https://www.siteinspire.com", title: "Siteinspire — curated web design", image: null, domain: "siteinspire.com", source: "seed" },
  { url: "https://godly.website", title: "Godly — astronomically good web design", image: null, domain: "godly.website", source: "seed" },
  { url: "https://httpster.net", title: "Httpster — totally rocking websites", image: null, domain: "httpster.net", source: "seed" },
  { url: "https://minimal.gallery", title: "Minimal Gallery — beautifully simple sites", image: null, domain: "minimal.gallery", source: "seed" },
  { url: "https://www.curated.design", title: "Curated.design — web inspiration", image: null, domain: "curated.design", source: "seed" },
  { url: "https://www.dark.design", title: "Dark.design — dark-mode inspiration", image: null, domain: "dark.design", source: "seed" },
  { url: "https://land-book.com", title: "Land-book — landing page gallery", image: null, domain: "land-book.com", source: "seed" },
  { url: "https://maxibestof.one", title: "Maxibestof — typography-led sites", image: null, domain: "maxibestof.one", source: "seed" },
  { url: "https://www.footer.design", title: "Footer.design — delightful details", image: null, domain: "footer.design", source: "seed" },
];

const SOCIAL_RE =
  /instagram\.|facebook\.|twitter\.|(^|\.)x\.com|linkedin\.|youtube\.|pinterest\.|tiktok\.|dribbble\.|behance\./i;
const NAV_PATH_RE = /^\/(about|tags?|category|categories|login|sign|privacy|terms|jobs|submit|advertise|contact)\b/i;
const GALLERY_HOSTS = new Set([
  "siteinspire.com", "www.siteinspire.com", "httpster.net", "minimal.gallery",
  "godly.website", "land-book.com", "www.land-book.com", "dark.design", "www.dark.design",
  "awwwards.com", "www.awwwards.com", "curated.design", "www.curated.design",
  "maxibestof.one", "footer.design", "www.footer.design",
]);

function hostOnly(u: string): string {
  try { return new URL(u).hostname; } catch { return ""; }
}

let cache: { at: number; items: Suggestion[] } | null = null;

function absol(href: string, base: string): string | null {
  try { return new URL(href, base).href; } catch { return null; }
}

/** Tolerant generic extractor: anchors that wrap or sit near an <img>. */
function extract(html: string, base: string, source: string): Suggestion[] {
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,800}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 40) {
    const href = absol(m[1], base);
    if (!href) continue;
    const inner = m[2];
    const img = /<img\b[^>]*(?:src|data-src)=["']([^"']+)["']/i.exec(inner);
    if (!img) continue;
    const image = absol(img[1], base);
    const alt = /alt=["']([^"']{3,120})["']/i.exec(inner)?.[1] ?? null;
    let domain: string;
    let path: string;
    try {
      const u = new URL(href);
      domain = u.hostname.replace(/^www\./, "");
      path = u.pathname;
    } catch { continue; }
    if (SOCIAL_RE.test(domain) || NAV_PATH_RE.test(path)) continue;
    const key = href.split("?")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: href, title: alt, image, domain, source });
  }
  return out;
}

async function aggregate(): Promise<Suggestion[]> {
  if (cache && Date.now() - cache.at < 1000 * 60 * 60 * 6) return cache.items;
  const results = await Promise.allSettled(
    GALLERIES.map(async (g) => {
      const res = await fetch(g.url, {
        headers: { "user-agent": UA, accept: "text/html" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(String(res.status));
      return extract((await res.text()).slice(0, 600_000), g.url, g.name);
    })
  );
  const items = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const merged = items.length ? items : SEEDS;
  cache = { at: Date.now(), items: merged };
  return merged;
}

/* ---------------- web search via Claude (query-specific) ---------------- */

async function webSearch(query: string): Promise<Suggestion[]> {
  try {
    const msg = await claude({
      model: SMART_MODEL,
      max_tokens: 2000,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      messages: [
        {
          role: "user",
          content: `Find current, genuinely exceptional websites matching this design brief: "${query}". Look for award-calibre, design-led work (typography, art direction, motion, originality) — galleries, studios, portfolios, product sites. After searching, reply with JSON only: [{"url": "...", "title": "...", "blurb": "<why it's exceptional, one short sentence>"}] with up to 12 results. Only include live, specific site URLs (not articles about them).`,
        },
      ],
    });
    const arr = parseJson(textOf(msg));
    if (!Array.isArray(arr)) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return arr.flatMap((r: any) => {
      try {
        const u = new URL(r.url);
        return [{ url: r.url, title: r.title ?? null, image: null, domain: u.hostname.replace(/^www\./, ""), source: "web", blurb: r.blurb ?? null }];
      } catch { return []; }
    });
  } catch {
    return [];
  }
}

/* ---------------- taste-led ranking ---------------- */

async function rank(cands: Suggestion[], taste: string[], query: string | null): Promise<Suggestion[]> {
  if (!hasKey() || cands.length <= 12) return cands;
  try {
    const list = cands.slice(0, 120).map((c, i) => `${i} | ${c.domain} | ${c.title ?? ""} | via ${c.source}`).join("\n");
    const msg = await claude({
      max_tokens: 600,
      messages: [
        {
          role: "user",
          content: `You curate design inspiration for a senior designer. Their taste profile (from what they save): ${taste.length ? taste.join(", ") : "high-end, typography-led, modern"}.${query ? ` Current brief: "${query}".` : ""}\n\nCandidates (index | domain | title | source):\n${list}\n\nPick up to 30 candidates that look like leading-class, moodboard-worthy design work${query ? " matching the brief" : ""}. Cut anything generic. Reply JSON only: {"picks": [indexes, best first]}`,
        },
      ],
    });
    const out = parseJson(textOf(msg));
    if (Array.isArray(out.picks) && out.picks.length) {
      return out.picks.map((i: number) => cands[i]).filter(Boolean);
    }
    return cands;
  } catch {
    return cands;
  }
}

/* ---- enrichment: resolve gallery detail pages to the real site + guarantee imagery ---- */

async function enrich(items: Suggestion[]): Promise<Suggestion[]> {
  const work = items.slice(0, 22).filter((i) => !i.image || GALLERY_HOSTS.has(hostOnly(i.url)));
  const dropped = new Set<string>();
  await Promise.allSettled(
    work.map(async (i) => {
      const res = await fetch(i.url, {
        headers: { "user-agent": UA, accept: "text/html" },
        redirect: "follow",
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) {
        if (GALLERY_HOSTS.has(hostOnly(i.url))) dropped.add(i.url);
        return;
      }
      const html = (await res.text()).slice(0, 300_000);
      const base = res.url || i.url;
      const og = (p: string) =>
        (new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']+)["']`, "i").exec(html) ??
          new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${p}["']`, "i").exec(html))?.[1] ?? null;
      const ogImg = og("og:image") ?? og("og:image:url") ?? og("twitter:image");
      if (ogImg && !i.image) {
        try { i.image = new URL(ogImg, base).href; } catch {}
      }
      if (!i.title) {
        const t = og("og:title") ?? /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1];
        if (t) i.title = t.trim().slice(0, 120);
      }
      // Gallery detail page? Find the real outbound site link.
      if (GALLERY_HOSTS.has(hostOnly(i.url))) {
        const galleryHost = hostOnly(i.url).replace(/^www\./, "");
        const re = /<a\b[^>]*href=["'](https?:\/\/[^"'\s]+)["']/gi;
        let m: RegExpExecArray | null;
        let found: string | null = null;
        while ((m = re.exec(html))) {
          const h = hostOnly(m[1]);
          if (!h) continue;
          const bare = h.replace(/^www\./, "");
          if (bare === galleryHost || bare.endsWith("." + galleryHost)) continue;
          if (SOCIAL_RE.test(h) || GALLERY_HOSTS.has(h) || GALLERY_HOSTS.has(bare)) continue;
          if (/google\.|apple\.|cdn\.|cloudfront|unsplash|typekit|fonts\.|webflow\.io$|framer\.com$/i.test(h)) continue;
          found = m[1];
          break;
        }
        if (found) {
          i.url = found;
          i.domain = hostOnly(found).replace(/^www\./, "");
        } else {
          dropped.add(i.url);
        }
      }
    })
  );
  return items.filter((i) => !dropped.has(i.url));
}

/* ---------------- route ---------------- */

export async function GET(req: Request) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  const query = sp.get("q");
  const taste = (sp.get("taste") ?? "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 30);
  const exclude = new Set((sp.get("exclude") ?? "").split(",").map((d) => d.trim()).filter(Boolean));

  let cands = await aggregate();
  if (query && hasKey()) {
    const ws = await webSearch(query);
    cands = [...ws, ...cands];
  } else if (!query && hasKey()) {
    // keep the endless feed fresh once gallery candidates are exhausted
    const remaining = cands.filter((c) => !exclude.has(c.domain) && !exclude.has(c.url));
    if (remaining.length < 15 && taste.length) {
      const ws = await webSearch(`${taste.slice(0, 6).join(" ")} website design inspiration`);
      cands = [...ws, ...cands];
    }
  }
  // dedupe by domain+path, drop excluded/seen domains
  const seen = new Set<string>();
  cands = cands.filter((c) => {
    if (exclude.has(c.domain) || exclude.has(c.url)) return false;
    const k = c.url.split("?")[0];
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  cands = await rank(cands, taste, query);
  const top = await enrich(cands.slice(0, 40));
  const seenDomains = new Set<string>();
  const finalItems = top.filter((s) => {
    if (seenDomains.has(s.domain)) return false;
    seenDomains.add(s.domain);
    return true;
  });
  return Response.json({ items: finalItems });
}
