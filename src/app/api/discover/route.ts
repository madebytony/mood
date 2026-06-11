import { isAuthed } from "../_lib/auth";
import { gemini, geminiDisabled, geminiText, hasGeminiKey, parseJson } from "../_lib/gemini";

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

/* ---------------- type foundry discovery ---------------- */

const TYPE_SEEDS: Suggestion[] = [
  { url: "https://sharptype.co", title: "Sharp Type", image: null, domain: "sharptype.co", source: "seed" },
  { url: "https://pangrampangram.com", title: "Pangram Pangram Foundry", image: null, domain: "pangrampangram.com", source: "seed" },
  { url: "https://grili.ch", title: "Grilli Type", image: null, domain: "grili.ch", source: "seed" },
  { url: "https://alt.tf", title: "alt.tf", image: null, domain: "alt.tf", source: "seed" },
  { url: "https://blazetype.eu", title: "Blaze Type", image: null, domain: "blazetype.eu", source: "seed" },
  { url: "https://www.futurefonts.xyz", title: "Future Fonts", image: null, domain: "futurefonts.xyz", source: "seed" },
  { url: "https://gradienttype.com", title: "Gradient Type", image: null, domain: "gradienttype.com", source: "seed" },
  { url: "https://ohnotype.co", title: "OhNo Type Co", image: null, domain: "ohnotype.co", source: "seed" },
  { url: "https://commercialtype.com", title: "Commercial Type", image: null, domain: "commercialtype.com", source: "seed" },
  { url: "https://optimo.ch", title: "Optimo", image: null, domain: "optimo.ch", source: "seed" },
  { url: "https://www.typotheque.com", title: "Typotheque", image: null, domain: "typotheque.com", source: "seed" },
  { url: "https://abcdinamo.com", title: "ABC Dinamo", image: null, domain: "abcdinamo.com", source: "seed" },
  { url: "https://newglyph.com", title: "Newglyph", image: null, domain: "newglyph.com", source: "seed" },
  { url: "https://typetype.org", title: "TypeType", image: null, domain: "typetype.org", source: "seed" },
  { url: "https://www.fontsmith.com", title: "Fontsmith", image: null, domain: "fontsmith.com", source: "seed" },
];

const TYPE_ARENA_CHANNELS = [
  "type-design-type-foundries",
  "typography-specimens",
  "type-specimens-2",
  "typography-5l3qblxwv5i",
  "type-in-use",
];

async function typeArena(): Promise<Suggestion[]> {
  const pool = [...TYPE_ARENA_CHANNELS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const results = await Promise.allSettled(pool.slice(0, 3).map(arenaChannel));
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

async function typeWebSearch(query: string | null, taste: string[]): Promise<Suggestion[]> {
  const brief = query ?? (taste.length ? taste.join(", ") : "independent type foundries, typographic design");
  try {
    const res = await gemini({
      tools: [{ google_search: {} }],
      contents: [{
        role: "user",
        parts: [{ text: `A designer is hunting for typographic inspiration. Their brief: "${brief}".\n\nSearch Google to find independent type foundries, font releases, or typographic design work matching that brief — boutique foundries, new font releases, type specimens, fonts-in-use examples. Return the foundry or specimen page itself, NOT a font listing aggregator (e.g. never return fonts.google.com, myfonts.com, fontshop.com, typekit, monotype, linotype).\n\nReply with JSON only (no markdown): [{"url": "...", "title": "...", "blurb": "<why this is typographically interesting, one short sentence>"}] with up to 12 results.` }],
      }],
      generationConfig: { maxOutputTokens: 2000 },
    });
    const arr = parseJson(geminiText(res));
    if (!Array.isArray(arr)) return [];
    const FONT_AGGREGATORS = /myfonts\.|fonts\.google\.|fontshop\.|typekit\.|monotype\.|linotype\.|fontspring\.|dafont\.|1001fonts\.|urbanfonts\.|fontsquirrel\./i;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return arr.flatMap((r: any) => {
      try {
        const u = new URL(r.url);
        const domain = u.hostname.replace(/^www\./, "");
        if (FONT_AGGREGATORS.test(domain) || SOCIAL_RE.test(domain) || DEV_RE.test(domain)) return [];
        return [{ url: r.url, title: r.title ?? null, image: null, domain, source: "web", blurb: r.blurb ?? null }];
      } catch { return []; }
    });
  } catch {
    return [];
  }
}

async function rankType(cands: Suggestion[], taste: string[], query: string | null): Promise<Suggestion[]> {
  if (!hasGeminiKey() || geminiDisabled() || cands.length <= 12) return cands;
  try {
    const list = cands.slice(0, 60).map((c, i) => `${i} | ${c.domain} | ${c.title ?? ""} | via ${c.source}`).join("\n");
    const res = await gemini({
      contents: [{
        role: "user",
        parts: [{ text: `You curate typographic inspiration for a senior designer. Their taste profile: ${taste.length ? taste.join(", ") : "boutique type foundries, expressive display type, editorial typography"}.${query ? ` Their current brief: "${query}" — match the brief first.` : ""}\n\nCandidates (index | domain | title | source):\n${list}\n\nPick up to 25 that are genuinely typographically interesting — independent foundries, quality font releases, type specimens, or fonts-in-use showcases. Cut font aggregators, mega-corporations (Monotype, Linotype, Adobe Fonts), free font dumps, and anything not primarily about type. Reply with JSON only: {"picks": [indexes, best first]}` }],
      }],
      generationConfig: { maxOutputTokens: 600, responseMimeType: "application/json" },
    });
    const out = JSON.parse(geminiText(res));
    if (Array.isArray(out.picks) && out.picks.length) {
      return out.picks.map((i: number) => cands[i]).filter(Boolean);
    }
    return cands;
  } catch {
    return cands;
  }
}

/* ---------------- gallery aggregation ---------------- */

const GALLERIES: { name: string; url: string }[] = [
  { name: "siteinspire", url: "https://www.siteinspire.com" },
  { name: "httpster", url: "https://httpster.net" },
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
// developer infrastructure — never moodboard material, however nice the og:image
const DEV_RE =
  /github\.|gitlab\.|bitbucket\.|npmjs\.|pypi\.|crates\.io|codepen\.io|codesandbox\.|stackblitz\.|stackoverflow\.|dev\.to|css-tricks\.|smashingmagazine\.|developer\.mozilla|w3schools\.|w3\.org|wikipedia\.|medium\.com|substack\.|news\.ycombinator|producthunt\./i;
// curation/award/directory sites — we want the work they feature, never the directory itself
const CURATION_RE =
  /awwwards\.|siteinspire\.|httpster\.|minimal\.gallery|godly\.website|land-book\.|curated\.design|dark\.design|maxibestof\.|footer\.design|cssdesignawards\.|csswinner\.|thefwa\.|onepagelove\.|lapa\.ninja|landingfolio\.|saaspages\.|saaslandingpage\.|pageflows\.|mobbin\.|refero\.design|savee\.it|cosmos\.so|klikkentheke\.|bestwebsite\.gallery|webdesigninspiration|admiretheweb\.|siiimple\.|cssnectar\.|uijar\.|collectui\.|navbar\.gallery|footer\.gallery|seesaw\.website|deadsimplesites\.|brutalistwebsites\.|hoverstat\.es/i;
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


const CACHE_TTL = 1000 * 60 * 60 * 6;
let cache: { at: number; items: Suggestion[] } | null = null;

function absol(href: string, base: string): string | null {
  try { return new URL(href, base).href; } catch { return null; }
}

/* ---------------- are.na: designer-curated channels (free, keyless) ---------------- */

const arenaCache = new Map<string, { at: number; items: Suggestion[] }>();

// Are.na's channel-SEARCH endpoint is unreliable (frequent 504s) and taste tags don't match
// channel names anyway, so we pull directly from a hand-picked pool of rich, designer-curated
// channels — the /contents endpoint IS reliable. Each call samples a random few so "Find more"
// surfaces different work; taste still drives the downstream rank().
const ARENA_CHANNELS = [
  "interesting-web-design-and-ux",
  "www-portfolio-studio",
  "portfolio-studio",
  "websites-portfolio-nesycqz_xdu",
  "portfolio-websites-1488038381",
  "portfolio-3q_6cl1-064",
];

/** Site links from one Are.na channel, cached 6h. */
async function arenaChannel(slug: string): Promise<Suggestion[]> {
  const hit = arenaCache.get(slug);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.items;
  const out: Suggestion[] = [];
  try {
    const r = await fetch(
      `https://api.are.na/v2/channels/${encodeURIComponent(slug)}/contents?per=25&sort=position&direction=desc`,
      { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return out;
    const { contents } = await r.json();
    for (const b of contents ?? []) {
      if (b?.class !== "Link" || !b?.source?.url) continue;
      let domain: string;
      try { domain = new URL(b.source.url).hostname.replace(/^www\./, ""); } catch { continue; }
      if (SOCIAL_RE.test(domain) || DEV_RE.test(domain) || CURATION_RE.test(domain) || GALLERY_HOSTS.has(domain)) continue;
      out.push({
        url: b.source.url,
        title: b.title || b.generated_title || null,
        image: b.image?.display?.url ?? b.image?.thumb?.url ?? null,
        domain,
        source: `are.na/${slug}`,
      });
    }
  } catch {
    /* one channel failing shouldn't sink the rest */
  }
  if (out.length) arenaCache.set(slug, { at: Date.now(), items: out });
  return out;
}

async function arena(): Promise<Suggestion[]> {
  // shuffle the channel pool and sample a few — a fresh mix on every refresh
  const pool = [...ARENA_CHANNELS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const results = await Promise.allSettled(pool.slice(0, 4).map(arenaChannel));
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

/* ---------------- minimal.gallery via RSS (structured, no scraping) ---------------- */

async function minimalRss(): Promise<Suggestion[]> {
  const res = await fetch("https://minimal.gallery/feed/", {
    headers: { "user-agent": UA, accept: "application/rss+xml,text/xml,*/*" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(String(res.status));
  const xml = await res.text();
  const out: Suggestion[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const x = m[1];
    const title = /<title>([^<]+)<\/title>/.exec(x)?.[1]?.trim() ?? null;
    if (title && /sponsor/i.test(title)) continue; // paid placements aren't curation
    const detail = /<link>([^<]+)<\/link>/.exec(x)?.[1]?.trim() ?? null;
    const img = /src="([^"]+\/wp-content\/uploads\/[^"]+)"/.exec(x)?.[1] ?? null;
    // screenshot filenames encode the real site: .../bureautonalli.com_.jpg
    const file = img?.split("/").pop() ?? "";
    const dm = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+?)_?(?:-\d+x\d+)?\.(?:jpe?g|png|webp)$/i.exec(file);
    const url = dm ? `https://${dm[1]}` : detail;
    if (!url) continue;
    let domain: string;
    try { domain = new URL(url).hostname.replace(/^www\./, ""); } catch { continue; }
    out.push({ url, title, image: img, domain, source: "minimal.gallery" });
  }
  return out;
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
    if (SOCIAL_RE.test(domain) || DEV_RE.test(domain) || NAV_PATH_RE.test(path)) continue;
    const key = href.split("?")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: href, title: alt, image, domain, source });
  }
  return out;
}

async function aggregate(): Promise<Suggestion[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache.items;
  const results = await Promise.allSettled([
    minimalRss(),
    ...GALLERIES.map(async (g) => {
      const res = await fetch(g.url, {
        headers: { "user-agent": UA, accept: "text/html" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(String(res.status));
      return extract((await res.text()).slice(0, 600_000), g.url, g.name);
    }),
  ]);
  const items = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (items.length) {
    cache = { at: Date.now(), items };
    return items;
  }
  // every gallery failed (likely transient/blocked) — retry in ~5 min; other sources still feed the pool
  cache = { at: Date.now() - CACHE_TTL + 5 * 60_000, items: [] };
  return [];
}

/* ---------------- web search via Gemini + Google Search grounding ---------------- */

async function webSearch(query: string): Promise<Suggestion[]> {
  try {
    const res = await gemini({
      tools: [{ google_search: {} }],
      contents: [{
        role: "user",
        parts: [{ text: `A designer is hunting for visual web-design inspiration. Their brief describes an AESTHETIC, not a product category: "${query}".\n\nSearch Google to find current, genuinely exceptional websites whose DESIGN matches that aesthetic — award-calibre, design-led work (typography, art direction, motion, originality): studios, portfolios, fashion, editorial, cultural sites. Design showcases (siteinspire, awwwards, godly, minimal.gallery) are useful for FINDING the work, but return the featured site itself — NEVER a gallery, award, directory or curation page URL as a result.\n\nCRITICAL: do NOT return products/tools that merely BELONG to the category the brief mentions. If the brief says "analytics dashboard", they want sites that LOOK that way, not analytics companies. Never include developer tools, code libraries, docs, UI kits, or SaaS picked for function.\n\nReply with JSON only (no markdown): [{"url": "...", "title": "...", "blurb": "<why the design is exceptional, one short sentence>"}] with up to 12 results. Only live, specific site URLs.` }],
      }],
      generationConfig: { maxOutputTokens: 2000 },
    });
    const arr = parseJson(geminiText(res));
    if (!Array.isArray(arr)) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return arr.flatMap((r: any) => {
      try {
        const u = new URL(r.url);
        const domain = u.hostname.replace(/^www\./, "");
        if (SOCIAL_RE.test(domain) || DEV_RE.test(domain) || CURATION_RE.test(domain)) return [];
        return [{ url: r.url, title: r.title ?? null, image: null, domain, source: "web", blurb: r.blurb ?? null }];
      } catch { return []; }
    });
  } catch {
    return [];
  }
}

/* ---------------- taste-led ranking ---------------- */

async function rank(cands: Suggestion[], taste: string[], query: string | null): Promise<Suggestion[]> {
  if (!hasGeminiKey() || geminiDisabled() || cands.length <= 12) return cands;
  try {
    const list = cands.slice(0, 60).map((c, i) => `${i} | ${c.domain} | ${c.title ?? ""} | via ${c.source}`).join("\n");
    const res = await gemini({
      contents: [{
        role: "user",
        parts: [{ text: `You curate design inspiration for a senior designer. Their taste profile (from what they save): ${taste.length ? taste.join(", ") : "high-end, typography-led, modern"}.${query ? ` Their current brief OVERRIDES the taste profile: "${query}" — match the brief's specific subject, palette and mood first; prefer "web"-source candidates when they fit the brief.` : ""}\n\nCandidates (index | domain | title | source):\n${list}\n\nPick up to 30 candidates that look like leading-class, moodboard-worthy design work${query ? " matching the brief" : ""}. Cut anything generic — and ALWAYS cut developer tools, code libraries, frameworks, documentation, UI kits, design-gallery/award directories, and SaaS products chosen for what they do rather than how they look. Only actual designed sites. Reply with JSON only: {"picks": [indexes, best first]}` }],
      }],
      generationConfig: { maxOutputTokens: 600, responseMimeType: "application/json" },
    });
    const out = JSON.parse(geminiText(res));
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
  const work = items.slice(0, 15).filter((i) => !i.image || GALLERY_HOSTS.has(hostOnly(i.url)));
  const dropped = new Set<string>();
  await Promise.allSettled(
    work.map(async (i) => {
      const res = await fetch(i.url, {
        headers: { "user-agent": UA, accept: "text/html" },
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
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
          if (SOCIAL_RE.test(h) || DEV_RE.test(h) || GALLERY_HOSTS.has(h) || GALLERY_HOSTS.has(bare)) continue;
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
  try {
  const sp = new URL(req.url).searchParams;
  const query = sp.get("q");
  const mode = sp.get("mode"); // "type" for typography discovery
  const taste = (sp.get("taste") ?? "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 30);
  const exclude = new Set((sp.get("exclude") ?? "").split(",").map((d) => d.trim()).filter(Boolean));

  let cands: Suggestion[];
  if (mode === "type") {
    // Typography discovery: foundry seeds + Are.na type channels + optional query search
    const [arn, searched] = await Promise.all([
      typeArena(),
      (query || taste.length) && hasGeminiKey() && !geminiDisabled()
        ? typeWebSearch(query, taste)
        : Promise.resolve([] as Suggestion[]),
    ]);
    cands = [...searched, ...arn, ...TYPE_SEEDS];
  } else if (query && hasGeminiKey() && !geminiDisabled()) {
    // "More like this": drive purely off the reference image's taste (caption/tags/colours)
    // via web search. The generic Are.na pool is Discover's inspo, not a match for one image.
    cands = await webSearch(query);
  } else {
    // Discover endless feed: general inspiration — curated Are.na channels + gallery pool
    const [agg, arn] = await Promise.all([aggregate(), arena()]);
    cands = [...arn, ...agg];
  }
  if (!cands.length) cands = SEEDS;

  // dedupe by domain+path, drop excluded/seen domains
  const norm = (u: string) => u.replace(/\/+$/, "");
  const seen = new Set<string>();
  cands = cands.filter((c) => {
    if (exclude.has(c.domain) || exclude.has(c.url) || exclude.has(norm(c.url))) return false;
    const k = norm(c.url.split("?")[0]);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  cands = await (mode === "type" ? rankType(cands, taste, query) : rank(cands, taste, query));
  // clone: enrich mutates suggestions in place and must never touch cached objects
  const top = await enrich(cands.slice(0, 20).map((c) => ({ ...c })));
  // re-apply exclusions AFTER enrichment — gallery URLs resolve to the real site here,
  // which is the URL the client's dislikes/saves were recorded against
  const seenDomains = new Set<string>();
  const finalItems = top.filter((s) => {
    if (exclude.has(s.domain) || exclude.has(s.url) || exclude.has(norm(s.url))) return false;
    // anything still pointing at a directory after enrichment is the directory itself — cut it.
    // web-search results are already pre-filtered by CURATION_RE inside webSearch(); don't
    // double-filter them here or legitimate agency sites with overlapping name patterns get dropped.
    if (s.source !== "seed" && s.source !== "web" && (CURATION_RE.test(s.domain) || DEV_RE.test(s.domain))) return false;
    if (seenDomains.has(s.domain)) return false;
    seenDomains.add(s.domain);
    return true;
  });
  return Response.json({ items: finalItems });
  } catch (e) {
    // never 500 the feed — the SEEDS fallback exists so Discover is always non-empty
    console.error("discover failed:", e);
    return Response.json({ items: SEEDS });
  }
}
