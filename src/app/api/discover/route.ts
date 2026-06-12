import { isAuthed } from "../_lib/auth";
import { gemini, geminiDisabled, geminiText, hasGeminiKey, parseJson } from "../_lib/gemini";
import { ingestCandidates } from "../_lib/corpus";

export const maxDuration = 120;

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

/** Fetch a reference image and return it as a Gemini inlineData part (or null on failure). */
async function fetchImagePart(url: string): Promise<{ inlineData: { mimeType: string; data: string } } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    if (!mimeType.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > 4_000_000) return null; // keep the request light
    return { inlineData: { mimeType, data: buf.toString("base64") } };
  } catch { return null; }
}

/** Vision pass: read the actual reference image and return a tight, search-ready description of its
 *  VISUAL aesthetic (palette/mood/type/layout), deliberately excluding photographic subject. Kept as
 *  its own plain call (no google_search tool) — combining image input with grounded search is flaky
 *  and trips the Gemini circuit-breaker; this two-step is reliable and still grounds on the pixels. */
async function describeAesthetic(image: { inlineData: { mimeType: string; data: string } }): Promise<string | null> {
  try {
    const res = await gemini({
      contents: [{
        role: "user",
        parts: [
          image,
          { text: `Describe ONLY the visual design aesthetic of this website screenshot, so I can find other sites that LOOK like it. Cover: dominant colour palette (specific hues + warmth/saturation/lightness, e.g. "warm muted ochre, olive, cream"), overall mood, typography style, layout/composition, texture/imagery treatment. Max 30 words, comma-separated phrases. Do NOT mention the literal photographic subject (people, places, objects, what the site is about).` },
        ],
      }],
      generationConfig: { maxOutputTokens: 120 },
    });
    const t = geminiText(res).replace(/\s+/g, " ").trim();
    return t || null;
  } catch { return null; }
}

/* ---------------- visual re-rank: judge candidates against the reference pixels ---------------- */

const MSHOT = (u: string) => `https://s.wordpress.com/mshots/v1/${encodeURIComponent(u)}?w=480`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch a candidate's preview (its own gallery/Are.na screenshot, else an mShots capture) as an
 *  inline image. mShots serves a tiny placeholder while a fresh capture renders — poll briefly. */
async function candidateImage(c: Suggestion): Promise<{ mimeType: string; data: string } | null> {
  const isShot = !c.image;
  const src = c.image ?? MSHOT(c.url);
  for (let i = 0; i < (isShot ? 3 : 1); i++) {
    if (i) await sleep(2200);
    try {
      const r = await fetch(src, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(9000) });
      if (!r.ok) continue;
      const mimeType = (r.headers.get("content-type") ?? "").split(";")[0];
      if (!mimeType.startsWith("image/")) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.byteLength > 600_000) return null; // keep the judge request bounded
      if (isShot && buf.byteLength < 8_000) continue; // mShots "generating" placeholder
      if (buf.byteLength < 2_000) return null; // tracking pixel / broken image
      return { mimeType, data: buf.toString("base64") };
    } catch { /* retry */ }
  }
  return null;
}

interface JudgedCandidate { c: Suggestion; score: number; why: string | null }

/** Judge one batch of candidates (image each) against the reference. */
async function judgeBatch(
  refImage: { inlineData: { mimeType: string; data: string } },
  batch: { c: Suggestion; img: { mimeType: string; data: string } }[],
): Promise<JudgedCandidate[]> {
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: "REFERENCE design (the look to match):" },
    refImage,
  ];
  batch.forEach((x, i) => { parts.push({ text: `CANDIDATE ${i}:` }); parts.push({ inlineData: x.img }); });
  parts.push({ text: `You are judging VISUAL design similarity for a designer's moodboard. For each CANDIDATE, score 0-10 for how closely its DESIGN matches the REFERENCE: colour palette (warmth, saturation, lightness), mood/atmosphere, typography style, layout/composition. IGNORE subject matter entirely — judge only how it looks.\n\nPALETTE IS A GATE, not a bonus: if the candidate's overall palette contradicts the reference (light/white site vs dark reference, vivid multicolour vs monochrome), score it 3 or below NO MATTER how similar the layout or typography — a clean layout in the wrong palette is a different aesthetic. Be harsh: 8-10 near-identical aesthetic, 5-7 same palette AND same family, 0-4 different. Reply JSON only: [{"i":<candidate index>,"score":<0-10>,"why":"<reason, max 8 words>"}]` });
  const res = await gemini({
    contents: [{ role: "user", parts }],
    generationConfig: { maxOutputTokens: 1500, responseMimeType: "application/json" },
  });
  const scores = JSON.parse(geminiText(res)) as { i: number; score: number; why?: string }[];
  if (!Array.isArray(scores)) return [];
  return scores
    .filter((s) => Number.isInteger(s.i) && batch[s.i])
    .map((s) => ({ c: batch[s.i].c, score: typeof s.score === "number" ? s.score : 0, why: s.why ?? null }));
}

/** The step that makes "similar" genuinely visual: screenshot every candidate and have the vision
 *  model score it against the reference image — only confirmed look-matches survive. Judges in
 *  batches, widening into the pool until enough matches are found. Returns null when judging
 *  isn't possible so the caller can fall back to the text-ranked path. */
async function visualRank(
  refImage: { inlineData: { mimeType: string; data: string } },
  pool: Suggestion[],
  exclude: Set<string>,
): Promise<Suggestion[] | null> {
  // Dedupe by domain, drop excluded; corpus-retrieved (index/*) and aesthetic-searched web
  // results get priority slots, the broad gallery/Are.na pool is shuffled in for breadth
  // ("Find more" stays fresh).
  const seen = new Set<string>();
  const web: Suggestion[] = [], rest: Suggestion[] = [];
  for (const c of pool) {
    if (exclude.has(c.domain) || exclude.has(c.url) || seen.has(c.domain)) continue;
    seen.add(c.domain);
    (c.source === "web" || c.source.startsWith("index/") ? web : rest).push(c);
  }
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  const picked = [...web.slice(0, 14), ...rest].slice(0, 36);
  if (!picked.length) return null;

  const fetched = await Promise.all(picked.map(async (c) => ({ c, img: await candidateImage(c) })));
  const withImg = fetched.filter((x): x is { c: Suggestion; img: { mimeType: string; data: string } } => !!x.img);
  if (withImg.length < 3) return null;

  // Judge in batches of 18; stop early once enough genuine matches have survived.
  const judged: JudgedCandidate[] = [];
  try {
    for (let i = 0; i < withImg.length && i < 36; i += 18) {
      judged.push(...await judgeBatch(refImage, withImg.slice(i, i + 18)));
      if (judged.filter((j) => j.score >= 5).length >= 6) break;
    }
  } catch { /* fall through with whatever was judged */ }
  if (!judged.length) return null;
  judged.sort((a, b) => b.score - a.score);

  let kept = judged.filter((j) => j.score >= 5);
  // thin pool — admit near-misses, but never below 4: with the palette gate, ≤3 means
  // wrong palette, and a wrong-palette "match" is exactly what users complain about
  if (kept.length < 4) kept = judged.filter((j) => j.score >= 4).slice(0, 6);
  if (!kept.length) return null; // nothing genuinely close — let the text path try instead
  return kept.map((j) => ({
    ...j.c,
    // pin the preview to the exact image that was judged, so what you see is what matched
    image: j.c.image ?? MSHOT(j.c.url),
    blurb: j.why ? `${j.why} — ${j.score}/10 visual match` : j.c.blurb ?? null,
  }));
}

/** `subjectMatters` distinguishes a TYPED project brief (a named sector is intentional —
 *  "a window company" means window companies are wanted) from an image-derived aesthetic
 *  search (the subject is incidental; only the look matters). */
async function webSearch(query: string, subjectMatters = false): Promise<Suggestion[]> {
  try {
    const intro = subjectMatters
      ? `A designer is gathering web-design inspiration for a real project brief: "${query}".\n\nIf the brief names an industry or product (e.g. "a window company"), include a few genuinely well-designed sites FROM that sector or close neighbours — the kind of brand being designed for — and fill the rest with sites from ANY sector whose design nails the brief's aesthetic (palette, mood, typography, layout). Exceptional design comes first: sector relevance never excuses a mediocre site.`
      : `A designer is hunting for visual web-design inspiration. Their brief describes an AESTHETIC, not a product category: "${query}".\n\nWeight the COLOUR PALETTE and overall MOOD most heavily. If the brief mentions photographic subject/content (a person, place, object, scene), treat that as INCIDENTAL — match the look, palette and feel, never the literal subject. (e.g. a warm yellow moody site of a man writing → return other warm, moody, yellow-toned sites, not sites about writers or poetry.)`;
    const res = await gemini({
      tools: [{ google_search: {} }],
      contents: [{ role: "user", parts: [{ text: `${intro}\n\nSearch Google to find current, genuinely exceptional websites whose DESIGN matches — award-calibre, design-led work (typography, art direction, motion, originality): studios, portfolios, fashion, editorial, cultural sites${subjectMatters ? ", and sector-relevant brands when the brief names one" : ""}. Design showcases (siteinspire, awwwards, godly, minimal.gallery) are useful for FINDING the work, but return the featured site itself — NEVER a gallery, award, directory or curation page URL as a result.\n\n${subjectMatters ? "Never include developer tools, code libraries, docs, UI kits, or SaaS picked for function rather than design." : "CRITICAL: do NOT return products/tools that merely BELONG to a category the notes mention. They want sites that LOOK the part, not companies in that sector. Never include developer tools, code libraries, docs, UI kits, or SaaS picked for function."}\n\nSkip the over-exposed mega-brand references every designer already knows (Apple, Stripe, Airbnb, Canva, Duolingo, Mailchimp, Notion, Spotify) — favour fresher, less-seen work.\n\nReply with JSON only (no markdown): [{"url": "...", "title": "...", "blurb": "<why the design is exceptional, one short sentence>"}] with up to 12 results. Only live, specific site URLs.` }] }],
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

/** Second sourcing angle: design galleries tag their entries with aesthetic labels ("warm",
 *  "beige", "serif", "editorial"), making them the one place an aesthetic is searchable TEXT.
 *  Mine gallery detail pages matching the look, then resolve each to the featured site itself
 *  via enrich() — which also picks up the gallery's screenshot for the visual judge. */
async function galleryMine(aesthetic: string): Promise<Suggestion[]> {
  try {
    const res = await gemini({
      tools: [{ google_search: {} }],
      contents: [{
        role: "user",
        parts: [{ text: `Search Google for pages on web-design galleries (siteinspire.com, minimal.gallery, godly.website, land-book.com, httpster.net, curated.design, awwwards.com) that feature websites matching this aesthetic: "${aesthetic}".\n\nUse queries like "siteinspire warm beige editorial serif" — gallery tag and detail pages describe the featured site's look in words. Return the gallery DETAIL-PAGE URLs you find (one per featured site, not tag-listing pages or the gallery home).\n\nReply with JSON only (no markdown): [{"url": "...", "title": "<featured site's name if visible>"}] with up to 10 results.` }],
      }],
      generationConfig: { maxOutputTokens: 1500 },
    });
    const arr = parseJson(geminiText(res));
    if (!Array.isArray(arr)) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = arr.flatMap((r: any) => {
      try {
        const u = new URL(r.url);
        const host = u.hostname;
        if (!GALLERY_HOSTS.has(host) && !GALLERY_HOSTS.has(host.replace(/^www\./, ""))) return [];
        if (u.pathname === "/" || NAV_PATH_RE.test(u.pathname)) return [];
        return [{ url: r.url, title: r.title ?? null, image: null, domain: host.replace(/^www\./, ""), source: "web", blurb: null } as Suggestion];
      } catch { return []; }
    });
    if (!raw.length) return [];
    // Resolve detail pages to the real featured site (+ inherit the gallery's og:image screenshot)
    const resolved = await enrich(raw);
    return resolved.filter((s) => !GALLERY_HOSTS.has(hostOnly(s.url)));
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

interface RunOpts {
  query: string | null;
  mode: string | null;
  img: string | null;
  taste: string[];
  exclude: Set<string>;
  /** Pre-retrieved corpus candidates (client-side vector hits) — they join the judge pool
   *  so every suggestion shown is GRADED against the reference, never raw cosine. */
  candidates: Suggestion[];
}

export async function GET(req: Request) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  return run({
    query: sp.get("q"),
    mode: sp.get("mode"),
    img: sp.get("img"),
    taste: (sp.get("taste") ?? "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 30),
    exclude: new Set((sp.get("exclude") ?? "").split(",").map((d) => d.trim()).filter(Boolean)),
    candidates: [],
  });
}

/** POST variant: same engine, JSON body — used when the client has corpus candidates to
 *  contribute (too many/too long for a query string). */
export async function POST(req: Request) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const rawCands = Array.isArray(body.candidates) ? body.candidates.slice(0, 30) : [];
  return run({
    query: typeof body.q === "string" && body.q ? body.q : null,
    mode: typeof body.mode === "string" ? body.mode : null,
    img: typeof body.img === "string" && body.img ? body.img : null,
    taste: Array.isArray(body.taste) ? body.taste.map(String).slice(0, 30) : [],
    exclude: new Set(Array.isArray(body.exclude) ? body.exclude.map(String) : []),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    candidates: rawCands.flatMap((c: any) => {
      if (typeof c?.url !== "string" || typeof c?.domain !== "string") return [];
      return [{
        url: c.url,
        domain: c.domain,
        title: typeof c.title === "string" ? c.title : null,
        image: typeof c.image === "string" ? c.image : null,
        source: typeof c.source === "string" ? c.source : "index",
        blurb: typeof c.blurb === "string" ? c.blurb : null,
      } satisfies Suggestion];
    }),
  });
}

async function run({ query, mode, img, taste, exclude, candidates }: RunOpts): Promise<Response> {
  try {

  let cands: Suggestion[];
  let visuallyRanked = false;
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
    // "More like this": when we can fetch the reference image, run the fully VISUAL pipeline —
    // (1) vision pass reads the image's aesthetic to steer the web search, (2) a wide candidate
    // pool is gathered (aesthetic web search + gallery/Are.na pools), (3) every candidate's own
    // screenshot is judged against the reference pixels, and only confirmed look-matches survive.
    const refImage = img ? await fetchImagePart(img) : null;
    const aesthetic = refImage ? await describeAesthetic(refImage) : null;
    const searchQuery = aesthetic ? `${aesthetic} · ${query}`.slice(0, 400) : query;
    if (refImage) {
      const [web, mined, arn, agg] = await Promise.all([
        webSearch(searchQuery),
        galleryMine(aesthetic ?? query).catch(() => [] as Suggestion[]),
        arena().catch(() => [] as Suggestion[]),
        aggregate().catch(() => [] as Suggestion[]),
      ]);
      // Corpus candidates lead the pool: they're already taste-near by vector, so the judge
      // spends its scores on plausible matches first.
      const ranked = await visualRank(refImage, [...candidates, ...mined, ...web, ...agg, ...arn], exclude);
      if (ranked && ranked.length) { cands = ranked; visuallyRanked = true; }
      else cands = [...candidates, ...mined, ...web]; // judging unavailable — fall back to the text-ranked path
    } else {
      // No reference image -> the query is a typed brief; a named sector is intentional.
      cands = [...candidates, ...await webSearch(searchQuery, !img)];
    }
  } else {
    // Discover endless feed: general inspiration — curated Are.na channels + gallery pool
    const [agg, arn] = await Promise.all([aggregate(), arena()]);
    cands = [...arn, ...agg];
  }
  // Empty browse feed -> seed with known-good directories so Discover is never blank.
  // Empty SEARCH -> return nothing: offering curation directories as "similar" results is
  // exactly the noise the user is searching to avoid.
  if (!cands.length) {
    if (query) return Response.json({ items: [] });
    cands = SEEDS;
  }

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
  // Visually-ranked results are already ordered by judged similarity — text rank would undo that.
  if (!visuallyRanked) {
    cands = await (mode === "type" ? rankType(cands, taste, query) : rank(cands, taste, query));
  }
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
  // Every search permanently improves the index: store fresh web finds (enriched with
  // og:image + title) in web_corpus so future queries retrieve them instantly. Best-effort.
  try {
    await ingestCandidates(
      finalItems
        .filter((s) => s.source === "web")
        .map((s) => ({ url: s.url, domain: s.domain, title: s.title, image: s.image, blurb: s.blurb ?? null, tags: [], source: "websearch" }))
    );
  } catch { /* index growth must never break the response */ }
  return Response.json({ items: finalItems });
  } catch (e) {
    // never 500 the feed — the SEEDS fallback exists so Discover is always non-empty.
    // Remote source fetches can fail transiently; avoid noisy console stack traces for those.
    const msg = e instanceof Error ? e.message : String(e);
    if (!/failed to fetch|fetch failed|network/i.test(msg)) {
      console.error("discover failed:", e);
    }
    return Response.json({ items: query ? [] : SEEDS });
  }
}
