import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { voyageEmbed, type VoyageContent } from "./voyage";
import { getEmbedder, hasCfKey } from "./embedder";
import { extractColorsFromImage } from "./colors";
import { safeFetch } from "./ssrf";

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
  /** Feed lane: "site" (default) or "type" (foundries, specimens, type-in-use). */
  kind?: "site" | "type";
  /** Many distinct pieces share this domain (blogs, Fonts In Use) — dedup/exclude by URL,
   *  not domain. */
  multiEntry?: boolean;
}

/** Sources where each URL is a distinct piece on a shared domain. Detected from the source
 *  string so it survives the `index/<source>` prefix retrieval adds. */
export const MULTI_ENTRY_RE = /fontsinuse|itsnicethat|^studio\//;

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
const ARENA_CHANNELS: { slug: string; tags?: string[]; kind?: "site" | "type" }[] = [
  { slug: "interesting-web-design-and-ux" },
  { slug: "www-portfolio-studio" },
  { slug: "portfolio-studio" },
  { slug: "websites-portfolio-nesycqz_xdu" },
  { slug: "portfolio-websites-1488038381" },
  { slug: "portfolio-3q_6cl1-064" },
  { slug: "type-design-type-foundries", kind: "type" },
  { slug: "typography-specimens", kind: "type" },
  { slug: "type-in-use", kind: "type" },
];

/** The broad aesthetic spectrum — a wide net, not a taste statement. Each harvest samples
 *  a handful at random, so over successive nights the index sweeps the whole space without
 *  any single run ballooning. The query's aesthetic word rides along as a tag. */
const SPECTRUM_QUERIES: { q: string; tag: string }[] = [
  { q: "colorful web design", tag: "colorful" },
  { q: "playful web design", tag: "playful" },
  { q: "brutalist websites", tag: "brutalist" },
  { q: "editorial web design", tag: "editorial" },
  { q: "experimental web design", tag: "experimental" },
  { q: "monochrome web design", tag: "monochrome" },
  { q: "pastel web design", tag: "pastel" },
  { q: "retro web design", tag: "retro" },
  { q: "luxury brand websites", tag: "luxury" },
  { q: "maximalist web design", tag: "maximalist" },
  { q: "organic natural web design", tag: "organic" },
  { q: "3d web design", tag: "3d" },
  { q: "illustration websites", tag: "illustration" },
  { q: "fashion websites", tag: "fashion" },
  { q: "art direction websites", tag: "art direction" },
  { q: "motion design websites", tag: "motion" },
  { q: "typographic websites", tag: "typographic" },
  { q: "dark mode websites", tag: "dark mode" },
  { q: "e-commerce design inspiration", tag: "e-commerce" },
  { q: "swiss design websites", tag: "swiss" },
];

/** Taste-driven queries: the user's own top tags steer extra discovery, so the index grows
 *  fastest where their library actually lives — whatever that is, however it changes. */
async function tasteQueries(limit = 4): Promise<{ q: string; tag: string }[]> {
  try {
    const db = admin();
    const { data } = await db
      .from("items")
      .select("tags")
      .order("created_at", { ascending: false })
      .limit(200);
    const counts = new Map<string, number>();
    for (const row of data ?? []) {
      for (const t of (row.tags as string[] | null) ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    // skip layout/structure words — channel names are about look and subject, not grid math
    const SKIP = /whitespace|hero|grid|layout|composition|full-bleed|caps|scale|labels|cards|background|text/i;
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => t)
      .filter((t) => t.length > 3 && !SKIP.test(t))
      .slice(0, limit)
      .map((t) => ({ q: `${t} web design`, tag: t }));
  } catch { return []; }
}

// keep junk and NSFW channels out of a design corpus
const BAD_CHANNEL_RE = /nsfw|porn|onlyfans|x-rated|xxx|sex|gore|leak/i;

/** Discover fresh channels — a rotating sample of the broad spectrum plus the user's own
 *  taste tags. The corpus self-diversifies as Are.na grows AND follows the library's lead. */
async function arenaDiscover(): Promise<{ slug: string; tags: string[] }[]> {
  const sampled = [...SPECTRUM_QUERIES];
  for (let i = sampled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [sampled[i], sampled[j]] = [sampled[j], sampled[i]]; }
  const queries = [...sampled.slice(0, 6), ...(await tasteQueries())];
  const found: { slug: string; tags: string[] }[] = [];
  await Promise.allSettled(queries.map(async ({ q, tag }) => {
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

async function arenaChannel(slug: string, extraTags: string[], kind: "site" | "type" = "site"): Promise<CorpusCandidate[]> {
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
        kind,
      });
    }
  } catch { /* one channel failing shouldn't sink the rest */ }
  return out;
}

async function arena(): Promise<CorpusCandidate[]> {
  const discovered = await arenaDiscover();
  const seen = new Set<string>();
  const channels: { slug: string; tags: string[]; kind?: "site" | "type" }[] = [];
  for (const c of [...ARENA_CHANNELS.map((c) => ({ slug: c.slug, tags: c.tags ?? [], kind: c.kind })), ...discovered]) {
    if (seen.has(c.slug)) continue;
    seen.add(c.slug);
    channels.push(c);
  }
  const results = await Promise.allSettled(channels.map((c) => arenaChannel(c.slug, c.tags, c.kind ?? "site")));
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

/** Typewolf "Site of the Day" via RSS — a hand-curated feed of typography-led real websites.
 *  Each SOTD page's first outbound link is the real site (the rest are the curator's own),
 *  so entries resolve to DISTINCT real-site domains with a real 2x screenshot — premium
 *  gallery material, not blog-domain clutter. Bounded to the recent feed. */
async function typewolf(cap = 20): Promise<CorpusCandidate[]> {
  let xml: string;
  try {
    const res = await fetch("https://www.typewolf.com/feed", {
      headers: { "user-agent": UA, accept: "application/rss+xml,text/xml,*/*" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    xml = await res.text();
  } catch { return []; }

  const items: { title: string | null; page: string; image: string | null }[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    if (items.length >= cap) break;
    const b = m[1];
    const page = /<link>([^<]+)<\/link>/.exec(b)?.[1]?.trim();
    if (!page || !/\/site-of-the-day\//.test(page)) continue;
    const title = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(b)?.[1]?.trim() ?? null;
    const img = /<img[^>]+src="([^"]+)"/.exec(b)?.[1] ?? null;
    items.push({ title, page, image: img });
  }
  if (!items.length) return [];

  const resolved = await Promise.allSettled(items.map(async (it): Promise<CorpusCandidate | null> => {
    try {
      const res = await fetch(it.page, { headers: { "user-agent": UA, accept: "text/html" }, signal: AbortSignal.timeout(9000) });
      if (!res.ok) return null;
      const html = (await res.text()).slice(0, 200_000);
      // first external link that isn't Typewolf or the curator's own site = the featured site
      let site: string | null = null;
      for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
        const h = hostOf(m[1]);
        if (!h || /typewolf\.com$|jeremiahshoaf\.com$/.test(h)) continue;
        if (!okDomain(h)) continue;
        site = m[1];
        break;
      }
      if (!site) return null;
      const domain = hostOf(site);
      let image: string | null = it.image;
      if (image) { try { image = new URL(image, "https://www.typewolf.com").href; } catch {} }
      return { url: site, domain, title: it.title, image, tags: ["typography", "editorial", "site of the day"], source: "typewolf" };
    } catch { return null; }
  }));
  return resolved.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
}

/** It's Nice That via RSS — editorial design journalism. Each article is a distinct piece
 *  on the shared itsnicethat.com domain (multi-entry), with a wide hero image of the work. */
async function itsnicethat(cap = 30): Promise<CorpusCandidate[]> {
  let xml: string;
  try {
    const res = await fetch("https://www.itsnicethat.com/articles.rss", {
      headers: { "user-agent": UA, accept: "application/rss+xml,text/xml,*/*" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    xml = await res.text();
  } catch { return []; }
  const out: CorpusCandidate[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    if (out.length >= cap) break;
    const b = m[1];
    const link = /<link>([^<]+)<\/link>/.exec(b)?.[1]?.trim();
    if (!link || !/itsnicethat\.com\//.test(link) || /\/articles\/?$/.test(link)) continue;
    const title = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(b)?.[1]?.trim() ?? null;
    const img = /<img[^>]+src="([^"]+)"/.exec(b)?.[1] ?? /<media:content[^>]+url="([^"]+)"/.exec(b)?.[1] ?? null;
    if (!img) continue; // no hero image -> weak embedding, skip
    out.push({
      url: link,
      domain: "itsnicethat.com",
      title,
      image: img,
      tags: ["editorial", "graphic design"],
      source: "blog/itsnicethat",
      kind: "site",
      multiEntry: true,
    });
  }
  return out;
}

/** Fonts In Use — each /uses/ page is a distinct typographic-design reference (multi-entry,
 *  kind 'type', feeds the home-feed Type lane). The og:image is a branded cardshot, so we
 *  pull the real design photo (use-media-items asset) from the page instead. */
async function fontsinuse(cap = 24): Promise<CorpusCandidate[]> {
  let paths: string[];
  try {
    const res = await fetch("https://fontsinuse.com/", { headers: { "user-agent": UA, accept: "text/html" }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const html = await res.text();
    paths = [...new Set([...html.matchAll(/\/uses\/(\d+)\/([a-z0-9-]+)/g)].map((m) => m[0]))].slice(0, cap);
  } catch { return []; }
  if (!paths.length) return [];
  const resolved = await Promise.allSettled(paths.map(async (p): Promise<CorpusCandidate | null> => {
    try {
      const url = `https://fontsinuse.com${p}`;
      const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" }, signal: AbortSignal.timeout(9000) });
      if (!res.ok) return null;
      const html = (await res.text()).slice(0, 200_000);
      // the real design photo, not the nameplate logo or the branded cardshot
      const img = /<img[^>]+src="(https:\/\/assets\.fontsinuse\.com\/static\/use-media-items\/[^"]+)"/.exec(html)?.[1] ?? null;
      if (!img) return null;
      const title = /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/.exec(html)?.[1]?.replace(/\s*[–|]\s*Fonts In Use.*$/i, "").trim() ?? null;
      return { url, domain: "fontsinuse.com", title, image: img, tags: ["typography", "type in use"], source: "fontsinuse", kind: "type", multiEntry: true };
    } catch { return null; }
  }));
  return resolved.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
}

/* ---------------- watched studios: dynamic foundry + agency list ---------------- */

/** Shape of a row from the watched_studios table (only the fields we need here). */
interface WatchedStudio {
  id: string;
  url: string;
  domain: string;
  name: string | null;
  kind: string;                      // "foundry" | "agency"
  content_paths: string[] | null;
  instagram_handle?: string | null;
}

const OG_IMG_RE = /<meta[^>]+(?:property|name)=["'](?:og:image|og:image:url|twitter:image)["'][^>]+content=["']([^"']+)["']/i;
const OG_IMG_RE_REV = /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|og:image:url|twitter:image)["']/i;

/** Fetch each watched studio's homepage for the directory card + corpus row.
 *  Reads from the watched_studios table so new entries (seed or discovered) are
 *  picked up automatically without touching this file. */
async function directSites(): Promise<CorpusCandidate[]> {
  const db = admin();
  const { data: studios } = await db
    .from("watched_studios")
    .select("url, domain, name, kind")
    .order("created_at", { ascending: true });
  if (!studios?.length) return [];

  const out: CorpusCandidate[] = [];
  await Promise.allSettled(
    (studios as { url: string; domain: string; name: string | null; kind: string }[]).map(async (s) => {
      const domain = hostOf(s.url);
      if (!domain) return;
      const isFoundry = s.kind === "foundry";
      try {
        const res = await fetch(s.url, {
          headers: { "user-agent": UA, accept: "text/html" },
          redirect: "follow",
          signal: AbortSignal.timeout(9000),
        });
        if (!res.ok) return;
        const html = (await res.text()).slice(0, 300_000);
        const og = OG_IMG_RE.exec(html)?.[1] ?? OG_IMG_RE_REV.exec(html)?.[1] ?? null;
        let image: string | null = null;
        if (og) { try { image = new URL(og, res.url || s.url).href; } catch {} }
        out.push({
          url: s.url,
          domain,
          title: s.name,
          image,
          tags: isFoundry ? ["type foundry", "typography"] : ["agency", "studio", "portfolio"],
          source: isFoundry ? "foundry-direct" : "agency-direct",
          kind: isFoundry ? "type" : "site",
        });
      } catch { /* one studio down shouldn't sink the batch */ }
    })
  );
  return out;
}

/** Scrape fresh articles / work entries from watched studios' content paths.
 *  Only active studios (seed tier or gallery_appearances >= 2) with known
 *  content_paths are checked; at most `cap` studios per harvest to stay within
 *  the 120-s Vercel budget. Returns multi-entry CorpusCandidate[] — one row per
 *  article/work page found. Source is "studio/<domain>" for feed-lane filtering. */
async function studioContent(cap = 30): Promise<CorpusCandidate[]> {
  const db = admin();
  const { data: studios } = await db
    .from("watched_studios")
    .select("id, url, domain, name, kind, content_paths")
    .or("tier.eq.seed,gallery_appearances.gte.2")
    .not("content_paths", "is", null)
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(cap);
  if (!studios?.length) return [];

  const out: CorpusCandidate[] = [];
  const checkedIds: string[] = [];

  await Promise.allSettled(
    (studios as WatchedStudio[]).map(async (studio) => {
      checkedIds.push(studio.id);
      for (const path of studio.content_paths!) {
        try {
          const listUrl = `https://${studio.domain}${path}`;
          const res = await fetch(listUrl, {
            headers: { "user-agent": UA, accept: "text/html" },
            redirect: "follow",
            signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) continue;
          const html = (await res.text()).slice(0, 400_000);

          // Collect internal links that are sub-pages of this content section
          const pathPrefix = path.endsWith("/") ? path : path + "/";
          const seen = new Set<string>();
          for (const m of html.matchAll(/href=["']([^"'#?]+)["']/g)) {
            const raw = m[1].trim();
            let fullPath: string;
            try {
              const abs = new URL(raw, listUrl);
              if (abs.hostname.replace(/^www\./, "") !== studio.domain.replace(/^www\./, "")) continue;
              fullPath = abs.pathname;
            } catch { continue; }
            if (!fullPath.startsWith(pathPrefix)) continue;
            const remainder = fullPath.slice(pathPrefix.length);
            if (!remainder) continue;
            if (/\.(css|js|png|jpg|webp|svg|ico|pdf|woff|json)$/.test(fullPath)) continue;
            if (/^(page\/\d|tag\/|category\/|author\/|feed\/?$|rss)/.test(remainder)) continue;
            seen.add(fullPath);
          }

          // Fetch og:image from up to 8 article pages per path
          let fetched = 0;
          for (const href of [...seen].slice(0, 8)) {
            if (fetched >= 8) break;
            const articleUrl = `https://${studio.domain}${href}`;
            try {
              const r = await fetch(articleUrl, {
                headers: { "user-agent": UA, accept: "text/html" },
                redirect: "follow",
                signal: AbortSignal.timeout(8000),
              });
              if (!r.ok) continue;
              const aHtml = (await r.text()).slice(0, 200_000);
              const og = OG_IMG_RE.exec(aHtml)?.[1] ?? OG_IMG_RE_REV.exec(aHtml)?.[1] ?? null;
              if (!og) continue; // no image = weak embedding, skip
              let image: string | null = null;
              try { image = new URL(og, articleUrl).href; } catch {}
              if (!image) continue;
              const titleMatch =
                /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/.exec(aHtml)?.[1] ??
                /<meta[^>]+content="([^"]+)"[^>]+property="og:title"/.exec(aHtml)?.[1] ??
                /<title>([^<]+)<\/title>/.exec(aHtml)?.[1] ??
                null;
              const kind: "site" | "type" = studio.kind === "foundry" ? "type" : "site";
              out.push({
                url: articleUrl,
                domain: studio.domain,
                title: titleMatch?.replace(/\s*[|–\-]\s*[^|–\-]*$/, "").trim() ?? null,
                image,
                tags: studio.kind === "foundry"
                  ? ["type foundry", "typography"]
                  : ["agency", "studio", "portfolio"],
                source: `studio/${studio.domain}`,
                kind,
                multiEntry: true,
              });
              fetched++;
            } catch { /* one article failing is fine */ }
          }
        } catch { /* one path failing is fine */ }
      }
    })
  );

  // Stamp last_checked_at for everything we attempted, regardless of results
  if (checkedIds.length) {
    try {
      await db
        .from("watched_studios")
        .update({ last_checked_at: new Date().toISOString() })
        .in("id", checkedIds);
    } catch { /* best-effort */ }
  }
  return out;
}

/** Pull recent posts from watched studios' public Instagram profiles.
 *  Uses Instagram's undocumented web_profile_info endpoint — no auth, no cookies,
 *  returns the 12 most recent posts. Processes studios sequentially with a small
 *  delay to avoid rate-limiting. Only image posts are kept (videos have no usable
 *  thumbnail for embedding). Source is "studio/<domain>" so posts slot into the
 *  same feed lane as blog/work scrapes. */
async function studioInstagram(cap = 25): Promise<CorpusCandidate[]> {
  const db = admin();
  const { data: studios } = await db
    .from("watched_studios")
    .select("id, url, domain, name, kind, instagram_handle")
    .not("instagram_handle", "is", null)
    .or("tier.eq.seed,gallery_appearances.gte.2")
    .limit(cap);
  if (!studios?.length) return [];

  const out: CorpusCandidate[] = [];

  for (const studio of studios as (WatchedStudio & { instagram_handle: string })[]) {
    try {
      const res = await fetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(studio.instagram_handle)}`,
        {
          headers: {
            "user-agent": UA,
            "x-ig-app-id": "936619743392459",
            "accept": "*/*",
          },
          signal: AbortSignal.timeout(10000),
        }
      );
      if (!res.ok) continue;
      const data = await res.json();
      const edges: unknown[] = data?.data?.user?.edge_owner_to_timeline_media?.edges ?? [];

      for (const edge of edges.slice(0, 12)) {
        const node = (edge as { node: Record<string, unknown> }).node;
        if (node.is_video) continue; // videos have no stable image thumbnail
        const shortcode = node.shortcode as string | undefined;
        if (!shortcode) continue;
        // thumbnail_src is a 640px CDN image — expires in days but embedPending
        // runs nightly so it'll be embedded before expiry; hygiene handles any stragglers
        const image = (node.thumbnail_src as string | null) ?? null;
        if (!image) continue;
        const captionEdges = (node.edge_media_to_caption as { edges: { node: { text: string } }[] } | undefined)?.edges ?? [];
        const caption = captionEdges[0]?.node?.text?.replace(/[\r\n]+/g, " ").trim().slice(0, 200) ?? null;
        const kind: "site" | "type" = studio.kind === "foundry" ? "type" : "site";
        out.push({
          url: `https://www.instagram.com/p/${shortcode}/`,
          domain: studio.domain,
          title: caption,
          image,
          tags: studio.kind === "foundry"
            ? ["type foundry", "typography", "instagram"]
            : ["agency", "studio", "instagram"],
          source: `studio/${studio.domain}`,
          kind,
          multiEntry: true,
        });
      }
    } catch { /* one studio failing is fine */ }

    // Brief pause between requests — Instagram rate-limits aggressive bursts
    await new Promise((r) => setTimeout(r, 350));
  }

  return out;
}

/** Grow watched_studios automatically from gallery co-appearances in web_corpus.
 *  Any domain that has been indexed from 2+ distinct gallery sources but isn't yet
 *  in watched_studios is upserted as tier='discovered' with gallery_appearances set
 *  to its source count. Capped at 20 new entries per harvest run. */
async function discoverStudios(): Promise<void> {
  const db = admin();

  // Sample the last 30 days of corpus rows (all gallery sources, not studio scrapes)
  const { data: rows } = await db
    .from("web_corpus")
    .select("domain, source, kind")
    .gte("last_seen_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
    .not("source", "like", "studio/%")
    .limit(10000);
  if (!rows?.length) return;

  // Tally distinct gallery sources per domain + detect kind signal
  const domainMeta = new Map<string, { sources: Set<string>; isType: boolean }>();
  for (const row of rows) {
    const domain = row.domain as string;
    if (!domain) continue;
    if (!domainMeta.has(domain)) domainMeta.set(domain, { sources: new Set(), isType: false });
    const m = domainMeta.get(domain)!;
    m.sources.add(row.source as string);
    if ((row.kind as string) === "type") m.isType = true;
  }

  // Skip already-watched domains
  const { data: existing } = await db.from("watched_studios").select("domain");
  const watchedSet = new Set((existing ?? []).map((r) => r.domain as string));

  const candidates: {
    url: string; domain: string; kind: string; tier: string; gallery_appearances: number;
  }[] = [];

  for (const [domain, { sources, isType }] of domainMeta) {
    if (sources.size < 2) continue;
    if (watchedSet.has(domain)) continue;
    if (!okDomain(domain)) continue;
    candidates.push({
      url: `https://${domain}`,
      domain,
      kind: isType ? "foundry" : "agency",
      tier: "discovered",
      gallery_appearances: sources.size,
    });
    if (candidates.length >= 20) break;
  }

  if (!candidates.length) return;
  try {
    await db
      .from("watched_studios")
      .upsert(candidates, { onConflict: "domain", ignoreDuplicates: true });
  } catch { /* discovery is best-effort */ }
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
  // Grow watched_studios from corpus co-appearances before the main harvest so
  // any newly discovered studios get a homepage row in this same run.
  await discoverStudios().catch(() => {});

  const results = await Promise.allSettled([
    minimalGallery(), arena(), homepages(), brutalist(), httpsterArchives(),
    directSites(), typewolf(), itsnicethat(), fontsinuse(),
    studioContent(),   // multi-entry: blog posts / work pages from watched studios
    studioInstagram(), // multi-entry: recent Instagram posts from watched studios
  ]);
  const cands = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  // Single-entry sources: one row per domain (a studio featured by 3 galleries = 1 row).
  // Multi-entry sources (blogs, Fonts In Use): one row per URL — each piece is distinct.
  const byKey = new Map<string, CorpusCandidate>();
  for (const c of cands) {
    const multi = c.multiEntry || MULTI_ENTRY_RE.test(c.source);
    const key = multi ? `u:${c.url}` : `d:${c.domain}`;
    const prev = byKey.get(key);
    if (!prev || (!prev.tags.length && c.tags.length) || (!prev.image && c.image)) {
      byKey.set(key, {
        ...c,
        multiEntry: multi,
        tags: [...new Set([...(prev?.tags ?? []), ...c.tags])],
        kind: prev?.kind === "type" || c.kind === "type" ? "type" : "site",
      });
    }
  }
  const rows = [...byKey.values()];
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
      kind: c.kind ?? "site",
      multi_entry: c.multiEntry ?? MULTI_ENTRY_RE.test(c.source),
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
      blurb: c.blurb ?? null, tags: c.tags, source: c.source, kind: c.kind ?? "site",
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
      .lte("score", 2)
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

/** Stored corpus v2 vectors for these domains — judged candidates that are already indexed
 *  shouldn't be re-embedded. Prefers embedding_v2 (512-dim CLIP); falls back to
 *  embedding (1024-dim Voyage) when v2 is not yet populated. PostgREST returns pgvector
 *  as a string; parse it. */
export async function corpusEmbeddingsByDomain(domains: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (!domains.length) return out;
  try {
    const db = admin();
    const { data } = await db
      .from("web_corpus")
      .select("domain,embedding_v2")
      .in("domain", domains.slice(0, 100))
      .not("embedding_v2", "is", null);
    for (const r of data ?? []) {
      const emb = typeof r.embedding_v2 === "string" ? JSON.parse(r.embedding_v2) : r.embedding_v2;
      if (Array.isArray(emb)) out.set(r.domain as string, emb as number[]);
    }
  } catch { /* fall back to embedding fresh */ }
  return out;
}

/** Enrich the index from the judge pipeline: the screenshot was already fetched and embedded
 *  to pre-rank candidates — keep both, so this site is instantly retrievable next time.
 *  Writes embedding_v2 (the v2 CLIP space); never clobbers an existing richer row. */
export async function upsertScreenshotEmbedding(cand: CorpusCandidate, image: string | null, embedding: number[], colors: string[] = []): Promise<void> {
  if (!okDomain(cand.domain)) return;
  try {
    const db = admin();
    // embedding param now carries the v2 vector (512-dim from embedShot in discover route)
    await db.from("web_corpus").upsert(
      [{
        url: cand.url, domain: cand.domain, title: cand.title, image: image ?? cand.image,
        blurb: cand.blurb ?? null, tags: cand.tags, source: cand.source, embedding_v2: embedding, colors,
        last_seen_at: new Date().toISOString(),
      }],
      { onConflict: "url", ignoreDuplicates: true }
    );
    await db.from("web_corpus").update({ embedding_v2: embedding, colors }).eq("url", cand.url).is("embedding_v2", null);
  } catch { /* enrichment is best-effort */ }
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

interface ImageData {
  part: VoyageContent;   // for Voyage backward compat
  base64: string;         // pure base64, no data-URI prefix
  mimeType: string;
  buf: Buffer;
}

async function imagePart(url: string): Promise<ImageData | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const mimeType = (res.headers.get("content-type") ?? "").split(";")[0];
    if (!mimeType.startsWith("image/")) return null;
    const raw = await res.arrayBuffer();
    if (raw.byteLength > MAX_IMAGE_BYTES || raw.byteLength < 2000) return null;
    const buf = Buffer.from(raw);
    const base64 = buf.toString("base64");
    return {
      part: { type: "image_base64", image_base64: `data:${mimeType};base64,${base64}` },
      base64,
      mimeType,
      buf,
    };
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

/** Embed up to `batch` unembedded rows into embedding_v2 (512-dim CLIP) using the
 *  configured embedder. Cloudflare CLIP has no rate limit so batches can be large;
 *  Voyage falls back gracefully on 429. Safe to call repeatedly until remaining=0. */
export async function embedPending(batch = 6): Promise<{ embedded: number; remaining: number; rateLimited: boolean }> {
  const embedder = getEmbedder();
  const useCf = hasCfKey();
  const db = admin();
  const { data } = await db
    .from("web_corpus")
    .select("id,url,title,image,blurb,tags,source")
    .is("embedding_v2", null)
    // multi-entry rows (blogs, Fonts In Use) jump the queue — those lanes go live quickly
    .order("multi_entry", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(batch);
  let embedded = 0;
  let rateLimited = false;
  for (const row of data ?? []) {
    const img = row.image ? await imagePart(row.image) : null;
    const colors = img ? await extractColorsFromImage(img.buf) : [];
    const text = embedTextOf(row, colors);
    if (!img && !text) {
      await db.from("web_corpus").delete().eq("id", row.id);
      continue;
    }
    try {
      let embedding_v2: number[];
      if (useCf) {
        if (img && text) {
          embedding_v2 = await embedder.embedHybrid(img.base64, img.mimeType, text);
        } else if (img) {
          embedding_v2 = await embedder.embedImage(img.base64, img.mimeType);
        } else {
          embedding_v2 = await embedder.embedText(text);
        }
      } else {
        // Voyage path: multimodal content array
        const content: VoyageContent[] = [];
        if (text) content.push({ type: "text", text });
        if (img) content.push(img.part);
        embedding_v2 = await voyageEmbed(content, "document");
      }
      await db.from("web_corpus").update({ embedding_v2, colors }).eq("id", row.id);
      embedded++;
    } catch (e) {
      if (/429/.test((e as Error).message)) { rateLimited = true; break; }
      // terminal error (bad image etc.) — try text-only as last resort
      if (img && text) {
        try {
          const embedding_v2 = await embedder.embedText(text);
          await db.from("web_corpus").update({ embedding_v2, colors }).eq("id", row.id);
          embedded++;
        } catch { /* leave for a future pass */ }
      }
    }
  }
  const { count } = await db
    .from("web_corpus")
    .select("*", { count: "exact", head: true })
    .is("embedding_v2", null);
  return { embedded, remaining: count ?? 0, rateLimited };
}

/** Backfill palettes for rows embedded before colour extraction existed: re-extract
 *  from the stored image, rebuild embed text with the palette, and re-embed into
 *  embedding_v2 in place. Old embedding stays live until the new one lands. */
export async function recolorPending(batch = 10): Promise<{ recolored: number; remaining: number; rateLimited: boolean }> {
  const embedder = getEmbedder();
  const useCf = hasCfKey();
  const db = admin();
  const { data } = await db
    .from("web_corpus")
    .select("id,url,title,image,blurb,tags,source")
    .not("embedding_v2", "is", null)
    .eq("colors", "{}")
    .not("image", "is", null)
    .order("created_at", { ascending: true })
    .limit(batch);
  let recolored = 0;
  let rateLimited = false;
  for (const row of data ?? []) {
    const img = await imagePart(row.image!);
    if (!img) {
      await db.from("web_corpus").update({ colors: ["unknown"] }).eq("id", row.id);
      continue;
    }
    const colors = await extractColorsFromImage(img.buf);
    if (!colors.length) {
      await db.from("web_corpus").update({ colors: ["unknown"] }).eq("id", row.id);
      continue;
    }
    const text = embedTextOf(row, colors);
    try {
      let embedding_v2: number[];
      if (useCf) {
        embedding_v2 = text
          ? await embedder.embedHybrid(img.base64, img.mimeType, text)
          : await embedder.embedImage(img.base64, img.mimeType);
      } else {
        embedding_v2 = await voyageEmbed(
          [{ type: "text", text: embedTextOf(row, colors) }, img.part],
          "document"
        );
      }
      await db.from("web_corpus").update({ embedding_v2, colors }).eq("id", row.id);
      recolored++;
    } catch (e) {
      if (/429/.test((e as Error).message)) { rateLimited = true; break; }
      await db.from("web_corpus").update({ colors }).eq("id", row.id);
      recolored++;
    }
  }
  const { count } = await db
    .from("web_corpus")
    .select("*", { count: "exact", head: true })
    .not("embedding_v2", "is", null)
    .eq("colors", "{}")
    .not("image", "is", null);
  return { recolored, remaining: count ?? 0, rateLimited };
}

/* ---------------- hygiene: prune dead links, repair logo-as-screenshot rows ---------------- */

const MSHOT = (u: string) => `https://s.wordpress.com/mshots/v1/${encodeURIComponent(u)}?w=480`;

/** Alive if HEAD or GET returns < 400, with one retry each to ride out a blip. Mirrors the
 *  item link-checker. Network/DNS errors and a final 4xx/5xx count as dead. */
async function reachable(url: string): Promise<boolean> {
  for (const method of ["HEAD", "GET"] as const) {
    for (let tries = 0; tries < 2; tries++) {
      try {
        const res = await safeFetch(url, {
          method,
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
          headers: { "user-agent": "Mozilla/5.0 (compatible; MoodCorpusCheck/1)" },
        });
        if (res.status < 400) return true;
        break; // definite 4xx/5xx — try GET, don't retry this method
      } catch { /* transient — retry once */ }
    }
  }
  return false;
}

/** True ONLY when an image is POSITIVELY a logo/icon rather than a screenshot. Calibrated on
 *  real corpus data: genuine screenshots are reliably landscape (>=1.5:1), brand marks sit
 *  near square (~1:1) — nothing legitimate falls between. Width alone is NOT a signal (sources
 *  serve wide previews downscaled). A fetch blip is inconclusive (false), never a repair —
 *  dead-link pruning handles truly-gone sites; transient image failures shouldn't cause churn. */
async function looksLikeLogo(imageUrl: string): Promise<boolean> {
  try {
    const res = await fetch(imageUrl, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return false; // can't confirm — leave it alone
    const type = (res.headers.get("content-type") ?? "").split(";")[0];
    if (!type.startsWith("image/")) return true; // not an image at all
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < 2500) return true; // tracking pixel / placeholder
    const meta = await sharp(buf).metadata().catch(() => null);
    if (!meta?.width || !meta?.height) return false; // undecodable — inconclusive
    const aspect = meta.width / meta.height;
    if (meta.width < 250 && meta.height < 250) return true; // favicon-scale icon
    return aspect < 1.25; // square / portrait = brand mark, not a screenshot
  } catch {
    return false; // network blip — inconclusive, don't churn
  }
}

/** One hygiene pass over the stalest `batch` rows: delete dead links; for rows whose image
 *  reads like a logo (or is missing), swap to an mShots screenshot of the real site and
 *  clear the embedding so it re-embeds from honest pixels. Stamps checked_at so the next
 *  pass moves on. Best-effort; never throws. */
export async function hygiene(batch = 12): Promise<{ checked: number; dead: number; repaired: number; remaining: number }> {
  const db = admin();
  const { data } = await db
    .from("web_corpus")
    .select("id,url,domain,image")
    .order("checked_at", { ascending: true, nullsFirst: true })
    .limit(batch);
  let dead = 0, repaired = 0, checked = 0;
  for (const row of data ?? []) {
    checked++;
    if (!(await reachable(row.url))) {
      await db.from("web_corpus").delete().eq("id", row.id);
      dead++;
      continue;
    }
    const bad = !row.image || (await looksLikeLogo(row.image));
    if (bad) {
      // mShots renders the actual homepage; clearing the embedding requeues it so the vector
      // is rebuilt from that screenshot (poisoned logo embeddings shouldn't linger).
      await db.from("web_corpus").update({
        image: MSHOT(row.url),
        embedding_v2: null,
        colors: [],
        checked_at: new Date().toISOString(),
      }).eq("id", row.id);
      repaired++;
    } else {
      await db.from("web_corpus").update({ checked_at: new Date().toISOString() }).eq("id", row.id);
    }
  }
  // how many remain never-checked
  const { count } = await db
    .from("web_corpus")
    .select("*", { count: "exact", head: true })
    .is("checked_at", null);
  return { checked, dead, repaired, remaining: count ?? 0 };
}
