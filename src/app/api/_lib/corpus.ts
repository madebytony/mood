import { createClient } from "@supabase/supabase-js";
import { voyageEmbed, type VoyageContent } from "./voyage";

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
async function minimalGallery(pages = 4): Promise<CorpusCandidate[]> {
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
const ARENA_CHANNELS = [
  "interesting-web-design-and-ux",
  "www-portfolio-studio",
  "portfolio-studio",
  "websites-portfolio-nesycqz_xdu",
  "portfolio-websites-1488038381",
  "portfolio-3q_6cl1-064",
  "type-design-type-foundries",
  "typography-specimens",
  "type-in-use",
];

async function arena(): Promise<CorpusCandidate[]> {
  const out: CorpusCandidate[] = [];
  for (const slug of ARENA_CHANNELS) {
    try {
      const r = await fetch(
        `https://api.are.na/v2/channels/${encodeURIComponent(slug)}/contents?per=50&sort=position&direction=desc`,
        { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10000) }
      );
      if (!r.ok) continue;
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
          tags: slug.replace(/-\w{10,}$|[-\d]+$/g, "").split("-").filter(Boolean),
          source: `are.na/${slug}`,
        });
      }
    } catch { /* one channel failing shouldn't sink the rest */ }
  }
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
  const results = await Promise.allSettled([minimalGallery(), arena(), homepages()]);
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

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

async function imagePart(url: string): Promise<VoyageContent | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "").split(";")[0];
    if (!type.startsWith("image/")) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_BYTES || buf.byteLength < 2000) return null;
    return { type: "image_base64", image_base64: `data:${type};base64,${Buffer.from(buf).toString("base64")}` };
  } catch { return null; }
}

/** Embed up to `batch` unembedded rows (screenshot + tags + title -> one hybrid vector).
 *  Stops early on rate limits; safe to call repeatedly until `remaining` hits 0. */
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
    const text = [row.title, (row.tags ?? []).join(", "), row.blurb].filter(Boolean).join(". ").slice(0, 1000);
    const content: VoyageContent[] = [];
    if (text) content.push({ type: "text", text });
    const img = row.image ? await imagePart(row.image) : null;
    if (img) content.push(img);
    if (!content.length) {
      // nothing embeddable — drop the row rather than retrying it forever
      await db.from("web_corpus").delete().eq("id", row.id);
      continue;
    }
    try {
      const embedding = await voyageEmbed(content, "document");
      await db.from("web_corpus").update({ embedding }).eq("id", row.id);
      embedded++;
    } catch (e) {
      if (/429/.test((e as Error).message)) { rateLimited = true; break; }
      // terminal for this row (bad image etc.) — keep text-only as a fallback attempt
      if (img && text) {
        try {
          const embedding = await voyageEmbed([{ type: "text", text }], "document");
          await db.from("web_corpus").update({ embedding }).eq("id", row.id);
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
