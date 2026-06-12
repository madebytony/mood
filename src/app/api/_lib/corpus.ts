import { createClient } from "@supabase/supabase-js";
import { voyageEmbed, type VoyageContent } from "./voyage";
import { extractColorsFromImage } from "./colors";

/**
 * Web-corpus harvesting + embedding: the mini-Pinterest index.
 *
 * Curated galleries have already done the two expensive parts — human curation AND
 * labelling (tags/categories). Adapters pull their structured data; every candidate is
 * stored once in web_corpus and embedded once with Voyage (screenshot + tags + title),
 * after which "similar" is instant pgvector retrieval instead of live-web generation.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Mirrors the discover route's filters (route files can't export helpers).
const SOCIAL_RE =
  /instagram\.|facebook\.|twitter\.|(^|\.)x\.com|linkedin\.|youtube\.|pinterest\.|tiktok\.|dribbble\.|behance\./i;
const DEV_RE =
  /github\.|gitlab\.|bitbucket\.|npmjs\.|pypi\.|crates\.io|codepen\.io|codesandbox\.|stackblitz\.|stackoverflow\.|dev\.to|css-tricks\.|smashingmagazine\.|developer\.mozilla|w3schools\.|w3\.org|wikipedia\.|medium\.com|substack\.|news\.ycombinator|producthunt\./i;
const CURATION_RE =
  /awwwards\.|siteinspire\.|httpster\.|minimal\.gallery|godly\.website|land-book\.|curated\.design|dark\.design|maxibestof\.|footer\.design|cssdesignawards\.|csswinner\.|thefwa\.|onepagelove\.|lapa\.ninja|landingfolio\.|saaspages\.|saaslandingpage\.|pageflows\.|mobbin\.|refero\.design|savee\.it|cosmos\.so|klikkentheke\.|bestwebsite\.gallery|webdesigninspiration|admiretheweb\.|siiimple\.|cssnectar\.|uijar\.|collectui\.|navbar\.gallery|footer\.gallery|seesaw\.website|deadsimplesites\.|brutalistwebsites\.|hoverstat\.es/i;

export interface CorpusCandidate {
  url: string;
  domain: string;
  title: string | null;
  image: string | null;
  blurb?: string | null;
  tags: string[];
  source: string;
}

function admin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY not configured");
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function okDomain(domain: string): boolean {
  return !!domain && !SOCIAL_RE.test(domain) && !DEV_RE.test(domain) && !CURATION_RE.test(domain);
}

function hostOf(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/* ---------------- adapters ---------------- */

/** minimal.gallery via its WordPress REST API: title + category tags + screenshot, with the
 *  real site URL encoded in the screenshot filename (bureautonalli.com_.jpg). */
async function minimalGallery(pages = 10): Promise<CorpusCandidate[]> {
  const out: CorpusCandidate[] = [];
  for (let page = 1; page <= pages; page++) {
    try {
      const res = await fetch(
        `https://minimal.gallery/wp-json/wp/v2/posts?per_page=50&page=${page}&_embed`,
        { headers: { "user-agent": UA }, signal: AbortSignal.timeout(12000) }
      );
      if (!res.ok) break;
      const posts = await res.json();
      if (!Array.isArray(posts) || !posts.length) break;
      for (const p of posts) {
        const media = p?._embedded?.["wp:featuredmedia"]?.[0];
        const img: string | null = media?.source_url ?? null;
        const file = img?.split("/").pop() ?? "";
        const dm = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+?)_?(?:-\d+x\d+)?\.(?:jpe?g|png|webp)$/i.exec(file);
        if (!dm) continue;
        const url = `https://${dm[1]}`;
        const domain = hostOf(url);
        if (!okDomain(domain)) continue;
        const tags = (p?._embedded?.["wp:term"] ?? [])
          .flat()
          .map((t: { name?: string }) => String(t?.name ?? "").toLowerCase())
          .filter((n: string) => n && n !== "uncategorized");
        out.push({
          url,
          domain,
          title: p?.title?.rendered ?? null,
          image: img,
          tags: [...new Set<string>(tags)],
          source: "minimal.gallery",
        });
      }
    } catch { break; }
  }
  return out;
}

/** Are.na designer-curated channels (real API). Tags come from the channel's own name. */
const ARENA_CHANNELS: { slug: string; tags?: string[] }[] = [
  { slug: "interesting-web-design-and-ux" },
  { slug: "www-portfolio-studio" },
  { slug: "portfolio-studio" },
  { slug: "websites-portfolio-nesycqz_xdu" },
  { slug: "portfolio-websites-1488038381" },
  { slug: "portfolio-3q_6cl1-064" },
  { slug: "type-design-type-foundries" },
  { slug: "typography-specimens" },
  { slug: "type-in-use" },
];

/** Channel-search queries that target the corpus's stylistic gaps. The query's aesthetic
 *  word rides along as a tag on every block harvested from a discovered channel. */
const ARENA_QUERIES: { q: string; tag: string }[] = [
  { q: "colorful web design", tag: "colorful" },
  { q: "playful web design", tag: "playful" },
  { q: "brutalist websites", tag: "brutalist" },
  { q: "editorial web design", tag: "editorial" },
  { q: "experimental web design", tag: "experimental" },
  { q: "monochrome web design", tag: "monochrome" },
];

// keep junk and NSFW channels out of a design corpus
const BAD_CHANNEL_RE = /nsfw|porn|onlyfans|x-rated|xxx|sex|gore|leak/i;

/** Discover fresh channels per aesthetic query — the corpus self-diversifies as Are.na grows. */
async function arenaDiscover(): Promise<{ slug: string; tags: string[] }[]> {
  const found: { slug: string; tags: string[] }[] = [];
  await Promise.allSettled(ARENA_QUERIES.map(async ({ q, tag }) => {
    const r = await fetch(
      `https://api.are.na/v2/search/channels?q=${encodeURIComponent(q)}&per=5`,
      { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) return;
    const { channels } = await r.json();
    for (const c of (channels ?? []).slice(0, 5)) {
      if (!c?.slug || (c.length ?? 0) < 15) continue; // tiny channels aren't worth a fetch
      if (BAD_CHANNEL_RE.test(c.slug) || BAD_CHANNEL_RE.test(c.title ?? "")) continue;
      found.push({ slug: c.slug, tags: [tag] });
    }
  }));
  return found;
}

async function arenaChannel(slug: string, extraTags: string[]): Promise<CorpusCandidate[]> {
  const out: CorpusCandidate[] = [];
  try {
    const r = await fetch(
      `https://api.are.na/v2/channels/${encodeURIComponent(slug)}/contents?per=100&sort=position&direction=desc`,
      { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) return out;
    const { contents } = await r.json();
    for (const b of contents ?? []) {
      if (b?.class !== "Link" || !b?.source?.url) continue;
      const domain = hostOf(b.source.url);
      if (!okDomain(domain)) continue;
      out.push({
        url: b.source.url,
        domain,
        title: b.title || b.generated_title || null,
        image: b.image?.display?.url ?? b.image?.thumb?.url ?? null,
        tags: [...new Set([...extraTags, ...slug.replace(/-\w{10,}$|[-\d]+$/g, "").split("-").filter((w) => w.length > 2)])],
        source: `are.na/${slug}`,
      });
    }
  } catch { /* one channel failing shouldn't sink the rest */ }
  return out;
}

async function arena(): Promise<CorpusCandidate[]> {
  const discovered = await arenaDiscover();
  const seen = new Set<string>();
  const channels: { slug: string; tags: string[] }[] = [];
  for (const c of [...ARENA_CHANNELS.map((c) => ({ slug: c.slug, tags: c.tags ?? [] })), ...discovered]) {
    if (seen.has(c.slug)) continue;
    seen.add(c.slug);
    channels.push(c);
  }
  const results = await Promise.allSettled(channels.map((c) => arenaChannel(c.slug, c.tags)));
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

/** brutalistwebsites.com: ~1,600 site + screenshot pairs in plain HTML — the corpus's
 *  brutalist/raw blind spot, solved by one page. Newest entries listed first. */
async function brutalist(cap = 250): Promise<CorpusCandidate[]> {
  const out: CorpusCandidate[] = [];
  try {
    const res = await fetch("https://brutalistwebsites.com", {
      headers: { "user-agent": UA, accept: "text/html" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return out;
    const html = await res.text();
    const re = /<a href="(https?:\/\/[^"]+)"[^>]*>[\s\S]{0,200}?<img[^>]*src="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && out.length < cap) {
      const domain = hostOf(m[1]);
      if (!okDomain(domain) || domain.endsWith("brutalistwebsites.com")) continue;
      let image: string | null = null;
      try { image = new URL(m[2], "https://brutalistwebsites.com").href; } catch {}
      out.push({ url: m[1], domain, title: domain, image, tags: ["brutalist", "raw"], source: "brutalistwebsites" });
    }
  } catch { /* best-effort */ }
  return out;
}

/** httpster month archives (the homepage only shows the latest handful). */
async function httpsterArchives(months = 4): Promise<CorpusCandidate[]> {
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const now = new Date();
  const urls: string[] = [];
  for (let i = 1; i <= months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    urls.push(`https://httpster.net/${d.getFullYear()}/${MONTHS[d.getMonth()]}/`);
  }
  const out: CorpusCandidate[] = [];
  await Promise.allSettled(urls.map(async (u) => {
    const res = await fetch(u, {
      headers: { "user-agent": UA, accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;
    const html = (await res.text()).slice(0, 600_000);
    const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,800}?)<\/a>/gi;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = re.exec(html)) && count < 60) {
      let href: string;
      try { href = new URL(m[1], u).href; } catch { continue; }
      const img = /<img\b[^>]*(?:src|data-src)=["']([^"']+)["']/i.exec(m[2]);
      if (!img) continue;
      const domain = hostOf(href);
      if (!okDomain(domain) || domain.endsWith("httpster.net")) continue;
      let image: string | null = null;
      try { image = new URL(img[1], u).href; } catch {}
      out.push({ url: href, domain, title: null, image, tags: [], source: "httpster" });
      count++;
    }
  }));
  return out;
}

/** Generic gallery-homepage extraction (anchors wrapping an <img>) for galleries without
 *  a structured API. Resolves outbound links; tags are unknown here. */
const HOMEPAGES = [
  { name: "godly", url: "https://godly.website" },
  { name: "land-book", url: "https://land-book.com" },
  { name: "dark.design", url: "https://www.dark.design", tags: ["dark mode"] },
  { name: "httpster", url: "https://httpster.net" },
  { name: "siteinspire", url: "https://www.siteinspire.com" },
];

async function homepages(): Promise<CorpusCandidate[]> {
  const out: CorpusCandidate[] = [];
  await Promise.allSettled(
    HOMEPAGES.map(async (g) => {
      const res = await fetch(g.url, {
        headers: { "user-agent": UA, accept: "text/html" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return;
      const html = (await res.text()).slice(0, 600_000);
      const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,800}?)<\/a>/gi;
      let m: RegExpExecArray | null;
      let count = 0;
      while ((m = re.exec(html)) && count < 40) {
        let href: string;
        try { href = new URL(m[1], g.url).href; } catch { continue; }
        const img = /<img\b[^>]*(?:src|data-src)=["']([^"']+)["']/i.exec(m[2]);
        if (!img) continue;
        const domain = hostOf(href);
        // only OUTBOUND links — a gallery's internal detail pages are not the work itself
        if (!okDomain(domain) || domain === hostOf(g.url)) continue;
        let image: string | null = null;
        try { image = new URL(img[1], g.url).href; } catch {}
        const alt = /alt=["']([^"']{3,120})["']/i.exec(m[2])?.[1] ?? null;
        out.push({ url: href, domain, title: alt, image, tags: g.tags ?? [], source: g.name });
        count++;
      }
    })
  );
  return out;
}

/* ---------------- ingest + embed ---------------- */

/** Run all adapters and upsert candidates. Returns how many rows were new. */
export async function harvest(): Promise<{ found: number; added: number }> {
  const results = await Promise.allSettled([minimalGallery(), arena(), homepages(), brutalist(), httpsterArchives()]);
  const cands = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  // one row per domain — prefer the candidate with tags, then with an image
  const byDomain = new Map<string, CorpusCandidate>();
  for (const c of cands) {
    const prev = byDomain.get(c.domain);
    if (!prev || (!prev.tags.length && c.tags.length) || (!prev.image && c.image)) {
      byDomain.set(c.domain, { ...c, tags: [...new Set([...(prev?.tags ?? []), ...c.tags])] });
    }
  }
  const rows = [...byDomain.values()];
  if (!rows.length) return { found: 0, added: 0 };
  const db = admin();
  const { count: before } = await db.from("web_corpus").select("*", { count: "exact", head: true });
  const { error } = await db.from("web_corpus").upsert(
    rows.map((c) => ({
      url: c.url,
      domain: c.domain,
      title: c.title,
      image: c.image,
      blurb: c.blurb ?? null,
      tags: c.tags,
      source: c.source,
      last_seen_at: new Date().toISOString(),
    })),
    { onConflict: "url", ignoreDuplicates: false }
  );
  if (error) throw error;
  const { count: after } = await db.from("web_corpus").select("*", { count: "exact", head: true });
  return { found: rows.length, added: (after ?? 0) - (before ?? 0) };
}

/** Store one ad-hoc candidate (e.g. a web-search result) so future queries benefit. */
export async function ingestCandidates(cands: CorpusCandidate[]): Promise<void> {
  const rows = cands.filter((c) => okDomain(c.domain));
  if (!rows.length) return;
  const db = admin();
  await db.from("web_corpus").upsert(
    rows.map((c) => ({
      url: c.url, domain: c.domain, title: c.title, image: c.image,
      blurb: c.blurb ?? null, tags: c.tags, source: c.source,
      last_seen_at: new Date().toISOString(),
    })),
    { onConflict: "url", ignoreDuplicates: true }
  );
}

/* ---------------- judge-verdict memory ---------------- */

export interface Verdict {
  domain: string;
  url: string | null;
  score: number;
  axes: Record<string, number> | null;
  why: string | null;
}

/** Domains already ruled OUT (score <= 3, i.e. palette-gated) for this reference —
 *  "Find more" should never pay to re-judge them. */
export async function badVerdictDomains(refKey: string): Promise<string[]> {
  try {
    const db = admin();
    const { data } = await db
      .from("judge_verdicts")
      .select("domain")
      .eq("ref_key", refKey)
      .lte("score", 3)
      .limit(500);
    return (data ?? []).map((r) => r.domain as string);
  } catch { return []; }
}

export async function saveVerdicts(refKey: string, verdicts: Verdict[]): Promise<void> {
  if (!verdicts.length) return;
  try {
    const db = admin();
    await db.from("judge_verdicts").upsert(
      verdicts.map((v) => ({ ref_key: refKey, domain: v.domain, url: v.url, score: v.score, axes: v.axes, why: v.why })),
      { onConflict: "ref_key,domain" }
    );
  } catch { /* verdict memory is best-effort */ }
}

/* ---------------- embedding reuse + screenshot enrichment ---------------- */

/** Stored corpus vectors for these domains — judged candidates that are already indexed
 *  shouldn't be re-embedded. PostgREST returns pgvector as a string; parse it. */
export async function corpusEmbeddingsByDomain(domains: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (!domains.length) return out;
  try {
    const db = admin();
    const { data } = await db
      .from("web_corpus")
      .select("domain,embedding")
      .in("domain", domains.slice(0, 100))
      .not("embedding", "is", null);
    for (const r of data ?? []) {
      const emb = typeof r.embedding === "string" ? JSON.parse(r.embedding) : r.embedding;
      if (Array.isArray(emb)) out.set(r.domain as string, emb as number[]);
    }
  } catch { /* fall back to embedding fresh */ }
  return out;
}

/** Enrich the index from the judge pipeline: the screenshot was already fetched and embedded
 *  to pre-rank candidates — keep both, so this site is instantly retrievable next time.
 *  Never clobbers an existing richer row; only fills missing embeddings. */
export async function upsertScreenshotEmbedding(cand: CorpusCandidate, image: string | null, embedding: number[], colors: string[] = []): Promise<void> {
  if (!okDomain(cand.domain)) return;
  try {
    const db = admin();
    await db.from("web_corpus").upsert(
      [{
        url: cand.url, domain: cand.domain, title: cand.title, image: image ?? cand.image,
        blurb: cand.blurb ?? null, tags: cand.tags, source: cand.source, embedding, colors,
        last_seen_at: new Date().toISOString(),
      }],
      { onConflict: "url", ignoreDuplicates: true }
    );
    await db.from("web_corpus").update({ embedding, colors }).eq("url", cand.url).is("embedding", null);
  } catch { /* enrichment is best-effort */ }
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

async function imagePart(url: string): Promise<{ part: VoyageContent; buf: Buffer } | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "").split(";")[0];
    if (!type.startsWith("image/")) return null;
    const raw = await res.arrayBuffer();
    if (raw.byteLength > MAX_IMAGE_BYTES || raw.byteLength < 2000) return null;
    const buf = Buffer.from(raw);
    return { part: { type: "image_base64", image_base64: `data:${type};base64,${buf.toString("base64")}` }, buf };
  } catch { return null; }
}

function embedTextOf(row: { title: string | null; tags: string[] | null; blurb: string | null }, colors: string[]): string {
  return [
    row.title,
    (row.tags ?? []).join(", "),
    colors.length ? `palette: ${colors.join(", ")}` : null,
    row.blurb,
  ].filter(Boolean).join(". ").slice(0, 1000);
}

/** Embed up to `batch` unembedded rows (screenshot + tags + palette + title -> one hybrid
 *  vector; named colours extracted from the same download). Stops early on rate limits;
 *  safe to call repeatedly until `remaining` hits 0. */
export async function embedPending(batch = 6): Promise<{ embedded: number; remaining: number; rateLimited: boolean }> {
  const db = admin();
  const { data } = await db
    .from("web_corpus")
    .select("id,url,title,image,blurb,tags,source")
    .is("embedding", null)
    .order("created_at", { ascending: true })
    .limit(batch);
  let embedded = 0;
  let rateLimited = false;
  for (const row of data ?? []) {
    const img = row.image ? await imagePart(row.image) : null;
    const colors = img ? await extractColorsFromImage(img.buf) : [];
    const text = embedTextOf(row, colors);
    const content: VoyageContent[] = [];
    if (text) content.push({ type: "text", text });
    if (img) content.push(img.part);
    if (!content.length) {
      // nothing embeddable — drop the row rather than retrying it forever
      await db.from("web_corpus").delete().eq("id", row.id);
      continue;
    }
    try {
      const embedding = await voyageEmbed(content, "document");
      await db.from("web_corpus").update({ embedding, colors }).eq("id", row.id);
      embedded++;
    } catch (e) {
      if (/429/.test((e as Error).message)) { rateLimited = true; break; }
      // terminal for this row (bad image etc.) — keep text-only as a fallback attempt
      if (img && text) {
        try {
          const embedding = await voyageEmbed([{ type: "text", text }], "document");
          await db.from("web_corpus").update({ embedding, colors }).eq("id", row.id);
          embedded++;
        } catch { /* leave for a future pass */ }
      }
    }
  }
  const { count } = await db
    .from("web_corpus")
    .select("*", { count: "exact", head: true })
    .is("embedding", null);
  return { embedded, remaining: count ?? 0, rateLimited };
}

/** Backfill palettes for rows embedded BEFORE colour extraction existed: re-extract from the
 *  stored image, rebuild the embed text with the palette line, and re-embed in place (the
 *  old vector stays live until the new one lands). */
export async function recolorPending(batch = 10): Promise<{ recolored: number; remaining: number; rateLimited: boolean }> {
  const db = admin();
  const { data } = await db
    .from("web_corpus")
    .select("id,url,title,image,blurb,tags,source")
    .not("embedding", "is", null)
    .eq("colors", "{}")
    .not("image", "is", null)
    .order("created_at", { ascending: true })
    .limit(batch);
  let recolored = 0;
  let rateLimited = false;
  for (const row of data ?? []) {
    const img = await imagePart(row.image!);
    if (!img) {
      // unreadable image — mark with tone-less sentinel so we don't retry forever
      await db.from("web_corpus").update({ colors: ["unknown"] }).eq("id", row.id);
      continue;
    }
    const colors = await extractColorsFromImage(img.buf);
    if (!colors.length) {
      await db.from("web_corpus").update({ colors: ["unknown"] }).eq("id", row.id);
      continue;
    }
    try {
      const embedding = await voyageEmbed(
        [{ type: "text", text: embedTextOf(row, colors) }, img.part],
        "document"
      );
      await db.from("web_corpus").update({ embedding, colors }).eq("id", row.id);
      recolored++;
    } catch (e) {
      if (/429/.test((e as Error).message)) { rateLimited = true; break; }
      await db.from("web_corpus").update({ colors }).eq("id", row.id); // palette still useful without re-embed
      recolored++;
    }
  }
  const { count } = await db
    .from("web_corpus")
    .select("*", { count: "exact", head: true })
    .not("embedding", "is", null)
    .eq("colors", "{}")
    .not("image", "is", null);
  return { recolored, remaining: count ?? 0, rateLimited };
}
