import { supabase, authToken } from "./supabase";
import { makeThumb, processImage, uploadProcessed } from "./media";
import type { Item, ItemType, Library, LibraryMode, LinkMeta, Space, Stack } from "./types";
import { filtersToQueryAddendum } from "./facets";

/** All item columns EXCEPT the 1024-dim embedding vector (too heavy to ship to the client). */
const ITEM_COLS: string =
  "id,space_id,user_id,type,storage_path,thumb_path,content,title,source_url,source_domain," +
  "tags,colors,fonts,tech,width,height,board_x,board_y,board_w,board_h,board_z,collapsed,card_color,stack_id,stack_order," +
  "ai_caption,caption_v,dead_link,created_at,last_viewed_at";

/** Bump when the caption prompt changes materially — backfillCaptions re-captions (and
 *  re-embeds) anything below this so the whole library converges on the new captions. */
const CAPTION_VERSION = 2;

/** Derive a short plain-text title from a note body that may be HTML or plain text. */
export function noteTitle(body: string): string {
  const text = body.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  return text.split("\n")[0].slice(0, 80);
}

// ---------- reads ----------

export async function fetchLibraries(): Promise<Library[]> {
  const { data, error } = await supabase.from("libraries").select("*").order("sort").order("created_at");
  if (error) throw error;
  return ((data ?? []) as Library[]).map((l) => ({
    ...l,
    mode: l.mode === "type" ? "type" : "default",
  }));
}

export async function fetchSpaces(): Promise<Space[]> {
  const { data, error } = await supabase.from("spaces").select("*").order("sort").order("created_at");
  if (error) throw error;
  return data ?? [];
}

/** Unstacked-item count per space_id — drives the sidebar tallies (matches what each space's grid shows).
 *  Uses a grouped-count RPC (counts in Postgres, one row per space). Falls back to the legacy row scan
 *  if the space_item_counts migration hasn't been applied yet. */
export async function fetchSpaceCounts(): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  const { data: rpc, error: rpcErr } = await supabase.rpc("space_item_counts");
  if (!rpcErr && rpc) {
    for (const row of rpc as { space_id: string; n: number }[]) m.set(row.space_id, Number(row.n));
    return m;
  }
  // Fallback (pre-migration): pull space_id rows and tally client-side.
  const { data, error } = await supabase.from("items").select("space_id").is("stack_id", null).limit(10000);
  if (error) throw error;
  for (const row of (data ?? []) as { space_id: string | null }[]) {
    if (row.space_id) m.set(row.space_id, (m.get(row.space_id) ?? 0) + 1);
  }
  return m;
}

/** Page size for the keyset-paginated grid (Fix: was a hard 500-item cap with no way to
 *  reach older saves). `before` is a `created_at` cursor — pass the oldest loaded item's
 *  timestamp to fetch the next page. Search stays single-shot at a higher ceiling. */
export const ITEMS_PAGE = 200;

export async function fetchItems(
  spaceId: string | "all",
  search: string,
  opts: { before?: string; beforeId?: string; limit?: number } = {}
): Promise<Item[]> {
  const limit = opts.limit ?? 500;
  let q = supabase
    .from("items")
    .select(ITEM_COLS)
    .is("stack_id", null)
    // (created_at, id) is the keyset order: id breaks ties so a page boundary that lands on a
    // shared timestamp can't skip its siblings (created_at alone would .lt() right past them).
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (spaceId !== "all") q = q.eq("space_id", spaceId);
  if (opts.before) {
    q = opts.beforeId
      ? q.or(`created_at.lt.${opts.before},and(created_at.eq.${opts.before},id.lt.${opts.beforeId})`)
      : q.lt("created_at", opts.before);
  }
  const s = search.trim().replace(/[,{}()]/g, " ").trim();
  const sLower = s.toLowerCase();
  if (s) {
    q = q.or(
      [
        `title.ilike.%${s}%`,
        `ai_caption.ilike.%${s}%`,
        `content.ilike.%${s}%`,
        `source_domain.ilike.%${s}%`,
        `tags.cs.{${s.toLowerCase()}}`,
        `fonts.cs.{${s}}`,
        `fonts.cs.{${sLower}}`,
      ].join(",")
    );
  }
  const { data, error } = await q;
  if (error) throw error;
  let out = (data ?? []) as unknown as Item[];
  if (!s) return out;

  // Font arrays are not ideal for partial text matching in PostgREST; when a font-like query
  // misses in SQL, run one local substring pass over the same view and merge any font hits.
  const hasFontHit = out.some((i) => (i.fonts ?? []).some((f) => f.toLowerCase().includes(sLower)));
  if (hasFontHit) return out;

  let q2 = supabase
    .from("items")
    .select(ITEM_COLS)
    .is("stack_id", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (spaceId !== "all") q2 = q2.eq("space_id", spaceId);
  const { data: allRows, error: e2 } = await q2;
  if (e2) throw e2;
  const fontHits = ((allRows ?? []) as unknown as Item[]).filter((i) =>
    (i.fonts ?? []).some((f) => f.toLowerCase().includes(sLower))
  );
  if (!fontHits.length) return out;

  const merged = new Map(out.map((i) => [i.id, i]));
  for (const i of fontHits) merged.set(i.id, i);
  out = [...merged.values()];
  return out;
}

/** Every item library-wide that still carries an unconfirmed AI font guess (a "Name@ai"
 *  token). Drives the global Font Review queue independently of the current view, so the
 *  queue reflects the whole library rather than just the space you happen to be looking at. */
export async function fetchAiFontItems(): Promise<Item[]> {
  const { data, error } = await supabase
    .from("items")
    .select(ITEM_COLS)
    .not("fonts", "is", null)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) throw error;
  return ((data ?? []) as unknown as Item[]).filter((i) =>
    (i.fonts ?? []).some((f) => f.toLowerCase().endsWith("@ai"))
  );
}

/** Top tags across the most recent saves — the taste profile. Scoped to one board when
 *  `spaceId` is given, so a warm-editorial project and a brutalist-dark project don't
 *  pollute each other's Discover feed. */
export async function tasteTags(spaceId?: string): Promise<string[]> {
  let q = supabase
    .from("items")
    .select("tags")
    .order("created_at", { ascending: false })
    .limit(200);
  if (spaceId) q = q.eq("space_id", spaceId);
  const { data } = await q;
  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    for (const t of row.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([t]) => t);
}

/** Taste profile for the LLM curator + web search: top tags PLUS the dominant palette buckets.
 *  Tags alone throw away colour — the one axis the visual judge weights highest — so the most
 *  common named colours ride along as "<colour> tones" phrases. Scoped per board like tasteTags. */
export async function tasteProfile(spaceId?: string): Promise<string[]> {
  let q = supabase
    .from("items")
    .select("tags,colors")
    .order("created_at", { ascending: false })
    .limit(200);
  if (spaceId) q = q.eq("space_id", spaceId);
  const { data } = await q;
  const tagCounts = new Map<string, number>();
  const colorCounts = new Map<string, number>();
  for (const row of data ?? []) {
    for (const t of row.tags ?? []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    for (const c of row.colors ?? []) colorCounts.set(c, (colorCounts.get(c) ?? 0) + 1);
  }
  const tags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([t]) => t);
  const palette = [...colorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([c]) => `${c} tones`);
  return [...palette, ...tags];
}

/** Domains already in the library (Discover should not re-offer these). */
export async function libraryDomains(): Promise<string[]> {
  const { data } = await supabase.from("items").select("source_domain").not("source_domain", "is", null).limit(1000);
  return [...new Set((data ?? []).map((r) => r.source_domain as string))];
}

/** Old gems for the feed: least recently seen first. */
export async function resurface(limit = 8): Promise<Item[]> {
  const { data } = await supabase
    .from("items")
    .select(ITEM_COLS)
    .order("last_viewed_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(limit * 3);
  const pool = (data ?? []) as unknown as Item[];
  // light shuffle so it isn't identical every load
  return pool.sort(() => Math.random() - 0.5).slice(0, limit);
}

// ---------- signed URL cache ----------

const urlCache = new Map<string, { url: string; expires: number }>();
const URL_CACHE_MAX = 2000;

// Signed URLs are scoped to the signed-in session, so drop them on any auth change — otherwise a
// new account could be served the previous user's URLs until TTL, and the map would grow forever.
supabase.auth.onAuthStateChange(() => urlCache.clear());

export async function signedUrls(paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const now = Date.now();
  const missing = [...new Set(paths)].filter((p) => {
    const hit = urlCache.get(p);
    if (hit && hit.expires > now) {
      out.set(p, hit.url);
      return false;
    }
    return true;
  });
  if (missing.length) {
    const { data, error } = await supabase.storage.from("media").createSignedUrls(missing, 60 * 60 * 12);
    if (error) throw error;
    for (const row of data ?? []) {
      if (row.signedUrl && row.path) {
        urlCache.set(row.path, { url: row.signedUrl, expires: now + 60 * 60 * 11 * 1000 });
        out.set(row.path, row.signedUrl);
      }
    }
    // bound the cache — evict oldest (insertion-ordered) entries past the cap
    while (urlCache.size > URL_CACHE_MAX) {
      const oldest = urlCache.keys().next().value;
      if (oldest === undefined) break;
      urlCache.delete(oldest);
    }
  }
  return out;
}

// ---------- writes ----------

async function userId(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error("Not signed in");
  return data.user.id;
}

function cleanFilename(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
}

export async function addImageFile(file: File | Blob, spaceId: string, extras: Partial<Item> = {}): Promise<Item> {
  const uid = await userId();
  const processed = await processImage(file);
  const media = await uploadProcessed(processed);
  const title = extras.title ?? (file instanceof File ? cleanFilename(file.name) : null);
  const { data, error } = await supabase
    .from("items")
    .insert({
      space_id: spaceId,
      user_id: uid,
      type: extras.type ?? "image",
      ...media,
      title,
      source_url: extras.source_url ?? null,
      source_domain: extras.source_url ? hostOf(extras.source_url) : null,
      tags: extras.tags ?? [],
      colors: processed.colors,
      fonts: extras.fonts ?? [],
      tech: extras.tech ?? [],
    })
    .select(ITEM_COLS)
    .single();
  if (error) throw error;
  return data as unknown as Item;
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await authToken();
  // No session → fail loudly instead of sending the literal string "Bearer null", which every
  // API route would just 401. Background callers swallow this; foreground callers surface it.
  if (!token) throw new Error("Not authenticated");
  return fetch(path, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
}

export async function fetchLinkMeta(url: string): Promise<LinkMeta> {
  const res = await apiFetch(`/api/meta?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error("Could not fetch link metadata");
  return res.json();
}

export async function fetchRemoteImage(url: string): Promise<Blob> {
  const res = await apiFetch(`/api/proxy-image?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error("Could not fetch image");
  return res.blob();
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?$/i;

/** Paste/import any URL: image URLs become image items, pages become link cards. */
export async function addFromUrl(url: string, spaceId: string): Promise<Item> {
  if (IMAGE_EXT.test(url)) {
    const blob = await fetchRemoteImage(url);
    return addImageFile(blob, spaceId, { source_url: url, title: null });
  }
  const meta = await fetchLinkMeta(url);
  const uid = await userId();
  let media = {
    storage_path: null as string | null,
    thumb_path: null as string | null,
    width: null as number | null,
    height: null as number | null,
  };
  let colors: string[] = [];
  if (meta.image) {
    try {
      const blob = await fetchRemoteImage(meta.image);
      const processed = await processImage(blob);
      const up = await uploadProcessed(processed);
      media = { ...up };
      colors = processed.colors;
    } catch {
      /* link card without an image is fine */
    }
  }
  const { data, error } = await supabase
    .from("items")
    .insert({
      space_id: spaceId,
      user_id: uid,
      type: "link",
      ...media,
      title: meta.title,
      content: meta.description,
      source_url: url,
      source_domain: meta.domain,
      tags: [],
      colors,
    })
    .select(ITEM_COLS)
    .single();
  if (error) throw error;
  return data as unknown as Item;
}

/** Full-page screenshot of a site -> 'site' card. */
export async function captureSite(url: string, spaceId: string): Promise<Item> {
  const res = await apiFetch(`/api/capture-site?url=${encodeURIComponent(url)}`);
  if (!res.ok) {
    const out = await res.json().catch(() => ({ error: `capture failed (${res.status})` }));
    throw new Error(out.error ?? "capture failed");
  }
  const blob = await res.blob();
  const domain = hostOf(url);
  let fonts: string[] = [];
  let tech: string[] = [];
  try {
    fonts = JSON.parse(decodeURIComponent(res.headers.get("x-page-fonts") ?? "%5B%5D"));
    tech = JSON.parse(decodeURIComponent(res.headers.get("x-page-tech") ?? "%5B%5D"));
  } catch {}
  return addImageFile(blob, spaceId, { type: "site", source_url: url, title: domain, fonts, tech });
}

export async function addNote(text: string, spaceId: string): Promise<Item> {
  const uid = await userId();
  const { data, error } = await supabase
    .from("items")
    .insert({
      space_id: spaceId,
      user_id: uid,
      type: "note",
      content: text,
      title: noteTitle(text) || "Note",
      tags: [],
    })
    .select(ITEM_COLS)
    .single();
  if (error) throw error;
  return data as unknown as Item;
}

export async function addTodo(title: string, spaceId: string): Promise<Item> {
  const uid = await userId();
  const { data, error } = await supabase
    .from("items")
    .insert({ space_id: spaceId, user_id: uid, type: "todo", title, content: "[]", tags: [] })
    .select(ITEM_COLS)
    .single();
  if (error) throw error;
  return data as unknown as Item;
}

export async function createColumn(spaceId: string, name: string): Promise<Stack> {
  const uid = await userId();
  const { data, error } = await supabase
    .from("stacks")
    .insert({ user_id: uid, space_id: spaceId, name, kind: "column" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Items inside column-type stacks, keyed by stack_id, ordered by stack_order then created_at. */
export async function fetchColumnItems(stackIds: string[]): Promise<Map<string, Item[]>> {
  const out = new Map<string, Item[]>();
  if (!stackIds.length) return out;
  const { data } = await supabase
    .from("items")
    .select(ITEM_COLS)
    .in("stack_id", stackIds)
    .order("stack_order", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });
  for (const item of (data ?? []) as unknown as Item[]) {
    if (!item.stack_id) continue;
    const arr = out.get(item.stack_id) ?? [];
    arr.push(item);
    out.set(item.stack_id, arr);
  }
  return out;
}

/** Create a note card directly inside a column, appended after its existing items. */
export async function addNoteToColumn(columnStackId: string, spaceId: string, text: string): Promise<Item> {
  const uid = await userId();
  const { data: last } = await supabase
    .from("items").select("stack_order").eq("stack_id", columnStackId)
    .order("stack_order", { ascending: false, nullsFirst: false }).limit(1);
  const nextOrder = ((last?.[0]?.stack_order as number | null) ?? -1) + 1;
  const { data, error } = await supabase
    .from("items")
    .insert({ space_id: spaceId, user_id: uid, type: "note", content: text, title: noteTitle(text) || "Note", tags: [], stack_id: columnStackId, stack_order: nextOrder })
    .select(ITEM_COLS).single();
  if (error) throw error;
  return data as unknown as Item;
}

/** Persist a new ordering of items inside a column by writing sequential stack_order values. */
export async function reorderColumnItems(orderedIds: string[]): Promise<void> {
  await Promise.all(
    orderedIds.map((id, i) => supabase.from("items").update({ stack_order: i }).eq("id", id))
  );
}

export async function updateItem(id: string, patch: Partial<Item>): Promise<Item> {
  const { data, error } = await supabase.from("items").update(patch).eq("id", id).select(ITEM_COLS).single();
  if (error) throw error;
  return data as unknown as Item;
}

/** Undo-able delete, step 1: remove the row immediately (survives refresh/app close). */
export async function deleteItemRow(item: Item): Promise<void> {
  const { error } = await supabase.from("items").delete().eq("id", item.id);
  if (error) throw error;
}

/** Undo: re-insert the row exactly as it was (files weren't touched yet). `similarity` is an
 *  RPC-only field (not a real column), so strip it or PostgREST rejects the insert — which would
 *  silently break Undo for items deleted from a "more like this"/semantic-search view. */
export async function restoreItem(item: Item): Promise<void> {
  const { similarity: _drop, ...row } = item;
  void _drop;
  const { error } = await supabase.from("items").insert(row);
  if (error) throw error;
}

/** Step 2, after the undo window: clear storage unless another item shares the files. */
export async function deleteItemStorage(item: Item): Promise<void> {
  const paths = [...new Set([item.storage_path, item.thumb_path].filter(Boolean))] as string[];
  if (!paths.length) return;
  const { data } = await supabase
    .from("items")
    .select("id")
    .or(paths.map((p) => `storage_path.eq.${p},thumb_path.eq.${p}`).join(","))
    .limit(1);
  if (data?.length) return; // content-addressed files still referenced elsewhere
  await supabase.storage.from("media").remove(paths);
}

/** Lazily ensure a Bookmarks space exists in the user's first library.
 *  Returns its ID — used by the like action and bookmark import. */
export async function getOrCreateBookmarks(spaces: Space[], libraries: Library[]): Promise<string> {
  const existing = spaces.find((s) => s.kind === "bookmarks");
  if (existing) return existing.id;
  const lib = libraries[0];
  if (!lib) throw new Error("No library");
  const uid = await userId();
  const { data, error } = await supabase
    .from("spaces")
    .insert({ library_id: lib.id, user_id: uid, name: "Bookmarks", kind: "bookmarks" })
    .select()
    .single();
  if (error) throw error;
  return data.id;
}

/** Parse a Chrome/Firefox bookmarks HTML export and return [{url, title}] pairs. */
export function parseBookmarksHtml(html: string): { url: string; title: string }[] {
  const out: { url: string; title: string }[] = [];
  const re = /<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>([^<]*)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const url = m[1].trim();
    const title = m[2].trim();
    if (url) out.push({ url, title: title || url });
  }
  return out;
}

/** Parse a CSV (Twitter/X bookmarks, Pocket export, generic) and return [{url, title}] pairs.
 *  Detects URL-containing columns automatically. */
export function parseBookmarksCsv(csv: string): { url: string; title: string }[] {
  const out: { url: string; title: string }[] = [];
  const lines = csv.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return out;
  for (const line of lines) {
    // Find URLs in each line (handles any CSV structure)
    const urls = line.match(/https?:\/\/[^\s,"]+/g);
    if (!urls) continue;
    // First non-URL field is the title
    const fields = line.split(/[,\t]/).map((f) => f.replace(/^"|"$/g, "").trim());
    const title = fields.find((f) => !/^https?:\/\//.test(f) && f.length > 1) ?? urls[0];
    for (const url of urls) out.push({ url, title });
  }
  return out;
}

/** Parse Instagram/Pinterest/social JSON data exports.
 *  Handles Instagram liked_posts.json, saved_posts.json, saved_collections.json,
 *  and generic JSON arrays with href/url fields. */
export function parseSocialJson(raw: string): { url: string; title: string }[] {
  const out: { url: string; title: string }[] = [];
  try {
    const data = JSON.parse(raw);
    // Walk the entire JSON tree looking for objects with href or url fields
    // This handles Instagram's nested format (likes_media_likes → string_list_data → href)
    // as well as flat arrays from Pinterest, Are.na, etc.
    function walk(obj: unknown) {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) { for (const item of obj) walk(item); return; }
      const rec = obj as Record<string, unknown>;
      const href = (typeof rec.href === "string" && rec.href) ||
                   (typeof rec.url === "string" && rec.url) ||
                   (typeof rec.link === "string" && rec.link);
      if (href && /^https?:\/\//.test(href)) {
        const title = (typeof rec.value === "string" && rec.value) || // Instagram: username
                      (typeof rec.title === "string" && rec.title) ||
                      (typeof rec.name === "string" && rec.name) ||
                      href;
        out.push({ url: href, title });
      }
      // Recurse into nested objects/arrays
      for (const v of Object.values(rec)) walk(v);
    }
    walk(data);
  } catch { /* invalid JSON */ }
  return out;
}

/** Batch-import bookmarks into a space. Skips duplicates by source_url. Returns the count imported. */
export async function importBookmarks(entries: { url: string; title: string }[], spaceId: string): Promise<number> {
  const uid = await userId();
  // Check which URLs already exist in this space
  const urls = entries.map((e) => e.url);
  const { data: existing } = await supabase
    .from("items")
    .select("source_url")
    .eq("space_id", spaceId)
    .in("source_url", urls.slice(0, 500));
  const have = new Set((existing ?? []).map((r) => r.source_url));
  const fresh = entries.filter((e) => !have.has(e.url)).slice(0, 200); // cap at 200 per import
  if (!fresh.length) return 0;
  // Batch insert as link cards (metadata enrichment happens async via background processing)
  const rows = fresh.map((e) => {
    let domain = "";
    try { domain = new URL(e.url).hostname.replace(/^www\./, ""); } catch { /* skip */ }
    return {
      space_id: spaceId,
      user_id: uid,
      type: "link" as const,
      title: e.title,
      source_url: e.url,
      source_domain: domain,
      tags: [],
      colors: [],
    };
  });
  const { error } = await supabase.from("items").insert(rows);
  if (error) throw error;
  return rows.length;
}

/** Enrich imported link items that have no thumbnail by fetching og:image.
 *  Runs in batches of 4 in parallel. Calls onProgress(done, total) after each batch.
 *  Returns the number of items successfully enriched. */
export async function enrichLinkThumbs(
  spaceId: string,
  onProgress?: (done: number, total: number) => void
): Promise<number> {
  const { data } = await supabase
    .from("items")
    .select(ITEM_COLS)
    .eq("space_id", spaceId)
    .eq("type", "link")
    .is("thumb_path", null)
    .not("source_url", "is", null)
    .limit(200);
  const items = (data ?? []) as unknown as Item[];
  if (!items.length) return 0;

  let enriched = 0;
  const BATCH = 4;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    await Promise.all(batch.map(async (item) => {
      try {
        const url = item.source_url!;
        const igMatch = url.match(/instagram\.com\/(?:p|reel)\/([A-Za-z0-9_-]+)/i);

        if (igMatch) {
          // Instagram's oEmbed requires auth since 2020 and og:image is JS-rendered.
          // Best option without auth: Puppeteer-capture the public embed page.
          const embedUrl = `https://www.instagram.com/p/${igMatch[1]}/embed/captioned/`;
          const res = await apiFetch(`/api/capture-site?url=${encodeURIComponent(embedUrl)}`);
          if (!res.ok) return;
          const blob = await res.blob();
          const processed = await processImage(blob);
          const up = await uploadProcessed(processed);
          await updateItem(item.id, {
            thumb_path: up.thumb_path,
            storage_path: up.storage_path ?? up.thumb_path,
            width: up.width ?? item.width,
            height: up.height ?? item.height,
            colors: processed.colors.length ? processed.colors : item.colors,
          });
          enriched++;
        } else {
          const meta = await fetchLinkMeta(url);
          if (!meta.image) return;
          const blob = await fetchRemoteImage(meta.image);
          const processed = await processImage(blob);
          const up = await uploadProcessed(processed);
          await updateItem(item.id, {
            thumb_path: up.thumb_path,
            storage_path: up.storage_path ?? item.storage_path,
            width: up.width ?? item.width,
            height: up.height ?? item.height,
            title: item.title || meta.title || item.title,
            colors: processed.colors.length ? processed.colors : item.colors,
          });
          enriched++;
        }
      } catch { /* skip items that fail */ }
    }));
    onProgress?.(Math.min(i + BATCH, items.length), items.length);
  }
  return enriched;
}

export async function createSpace(libraryId: string, name: string): Promise<Space> {
  const uid = await userId();
  const { data, error } = await supabase
    .from("spaces")
    .insert({ library_id: libraryId, user_id: uid, name })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function createLibrary(name: string): Promise<Library> {
  const uid = await userId();
  const { data, error } = await supabase.from("libraries").insert({ user_id: uid, name }).select().single();
  if (error) throw error;
  return { ...(data as Library), mode: (data as Library).mode === "type" ? "type" : "default" };
}

export async function setLibraryMode(id: string, mode: LibraryMode): Promise<void> {
  const { error } = await supabase.from("libraries").update({ mode }).eq("id", id);
  if (error) throw error;
}

export async function renameSpace(id: string, name: string): Promise<void> {
  const { error } = await supabase.from("spaces").update({ name }).eq("id", id);
  if (error) throw error;
}

export async function deleteSpace(id: string): Promise<void> {
  const { error } = await supabase.from("spaces").delete().eq("id", id);
  if (error) throw error;
}

// ---------- stacks ----------

export async function fetchStacks(spaceId: string | "all"): Promise<Stack[]> {
  let q = supabase.from("stacks").select("*").order("created_at", { ascending: false });
  if (spaceId !== "all") q = q.eq("space_id", spaceId);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

export async function createStack(spaceId: string, name: string, itemIds: string[]): Promise<Stack> {
  const uid = await userId();
  const { data, error } = await supabase
    .from("stacks")
    .insert({ user_id: uid, space_id: spaceId, name })
    .select()
    .single();
  if (error) throw error;
  const { error: e2 } = await supabase.from("items").update({ stack_id: data.id, space_id: spaceId }).in("id", itemIds);
  if (e2) throw e2;
  return data;
}

export async function fetchStackItems(stackId: string): Promise<Item[]> {
  const { data, error } = await supabase
    .from("items")
    .select(ITEM_COLS)
    .eq("stack_id", stackId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as Item[];
}

/** Up to 3 thumbnail paths per stack, for the fanned pile. */
export async function stackThumbPaths(stackIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!stackIds.length) return out;
  const { data } = await supabase
    .from("items")
    .select("stack_id, thumb_path")
    .in("stack_id", stackIds)
    .not("thumb_path", "is", null)
    .limit(200);
  for (const row of data ?? []) {
    const arr = out.get(row.stack_id as string) ?? [];
    if (arr.length < 3) arr.push(row.thumb_path as string);
    out.set(row.stack_id as string, arr);
  }
  return out;
}

export async function unstackItem(itemId: string): Promise<void> {
  const { error } = await supabase.from("items").update({ stack_id: null }).eq("id", itemId);
  if (error) throw error;
}

export async function renameStack(id: string, name: string): Promise<void> {
  const { error } = await supabase.from("stacks").update({ name }).eq("id", id);
  if (error) throw error;
}

export async function updateStack(id: string, patch: Partial<Stack>): Promise<void> {
  const { error } = await supabase.from("stacks").update(patch).eq("id", id);
  if (error) throw error;
}

export interface BoardItemPos { id: string; user_id: string; space_id: string; type: ItemType; created_at: string; board_x: number; board_y: number; board_w: number; }
export interface BoardStackPos { id: string; user_id: string; space_id: string; name: string; created_at: string; board_x: number; board_y: number; board_w: number; }

/** Persist many board positions in one upsert per table — replaces a PATCH-per-card storm on Tidy.
 *  Identity + NOT NULL columns are included so the upsert's INSERT arm is valid; content columns
 *  (title, tags, content, …) are deliberately omitted so a tidy can never clobber a concurrent edit. */
export async function saveBoardPositions(items: BoardItemPos[], stacks: BoardStackPos[]): Promise<void> {
  const [ir, sr] = await Promise.all([
    items.length ? supabase.from("items").upsert(items, { onConflict: "id" }) : null,
    stacks.length ? supabase.from("stacks").upsert(stacks, { onConflict: "id" }) : null,
  ]);
  if (ir?.error) throw ir.error;
  if (sr?.error) throw sr.error;
}

/** Dissolve: items return to the space, stack row removed. */
export async function deleteStack(id: string): Promise<void> {
  // Un-stack the items first; if that fails, don't delete the stack row or we'd orphan the items
  // with a dangling stack_id pointing at a row that no longer exists.
  const { error: unstackErr } = await supabase.from("items").update({ stack_id: null }).eq("stack_id", id);
  if (unstackErr) throw unstackErr;
  const { error } = await supabase.from("stacks").delete().eq("id", id);
  if (error) throw error;
}

export async function setSpaceView(id: string, view: "grid" | "board"): Promise<void> {
  const { error } = await supabase.from("spaces").update({ view }).eq("id", id);
  if (error) throw error;
}

// ---------- AI ----------

// A 503 (no key / transient outage) backs AI off for a few minutes, then we re-probe — rather than
// disabling captions+search for the whole page session on a single blip.
let aiCooldownUntil = 0;
const AI_COOLDOWN_MS = 5 * 60_000;
const aiDown = () => Date.now() < aiCooldownUntil;

function fontBaseName(font: string): string {
  return font.split("@")[0]?.trim().toLowerCase() ?? "";
}

/** Caption + auto-tag an item in the background. Returns whether it captioned (for backfill
 *  back-off). Silently no-ops without an API key. Pass kind="type" for typography items so
 *  the prompt focuses on typeface character and extracts font names. */
export async function captionItem(item: Item, onDone?: (updated: Item) => void | Promise<void>, kind?: "type"): Promise<boolean> {
  if (aiDown() || !item.thumb_path) return false;
  try {
    const urls = await signedUrls([item.thumb_path]);
    const res = await apiFetch("/api/ai/caption", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imageUrl: urls.get(item.thumb_path), title: item.title, kind }),
    });
    if (res.status === 503) {
      aiCooldownUntil = Date.now() + AI_COOLDOWN_MS;
      return false;
    }
    if (!res.ok) return false;
    aiCooldownUntil = 0;
    const { caption, tags, fonts: detectedFonts } = await res.json();
    if (!caption && !(tags ?? []).length) return false; // nothing useful came back
    const merged = [...new Set([...(item.tags ?? []), ...(tags ?? [])])];
    // In type mode, store model guesses as "name@ai" so they can be explicitly reviewed.
    const aiFonts = kind === "type" && Array.isArray(detectedFonts)
      ? detectedFonts
          .map((f) => String(f ?? "").trim())
          .filter(Boolean)
          .map((f) => (f.includes("@") ? f : `${f}@ai`))
      : [];

    // Merge AI-detected font names while preferring known non-AI providers over @ai guesses.
    let mergedFonts = item.fonts;
    if (kind === "type" && aiFonts.length) {
      const out = [...(item.fonts ?? [])];
      const seen = new Set(out.map(fontBaseName));
      for (const f of aiFonts) {
        const base = fontBaseName(f);
        if (!base || seen.has(base)) continue;
        out.push(f);
        seen.add(base);
      }
      mergedFonts = out;
    }
    const patch: Partial<Item> = { ai_caption: caption, tags: merged, caption_v: CAPTION_VERSION };
    if (mergedFonts !== item.fonts) patch.fonts = mergedFonts ?? [];
    const updated = await updateItem(item.id, patch);
    await onDone?.(updated);
    return true;
  } catch {
    return false; // background job — never surface errors
  }
}

export async function aiSearch(query: string, items: Item[]): Promise<string[] | null> {
  const res = await apiFetch("/api/ai/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query,
      items: items.map((i) => ({
        id: i.id,
        title: i.title,
        tags: i.tags,
        fonts: i.fonts,
        caption: i.ai_caption,
        domain: i.source_domain,
      })),
    }),
  });
  if (!res.ok) return null;
  const { ids } = await res.json();
  return ids;
}

// ---------- visual embeddings (taste engine) ----------

let voyageCooldownUntil = 0;
const VOYAGE_COOLDOWN_MS = 5 * 60_000;
const voyageDown = () => Date.now() < voyageCooldownUntil;

/** Style-anchored text for the hybrid vector — captions name the aesthetic the pixels show. */
function embedText(item: Item): string {
  return [
    item.ai_caption,
    (item.tags ?? []).join(", "),
    (item.fonts ?? []).join(", "),
    item.colors?.length ? `palette: ${item.colors.join(", ")}` : null,
    item.title,
    item.content?.slice(0, 500),
  ]
    .filter(Boolean)
    .join(". ");
}

/** Embed one item (image + caption hybrid) in the background.
 *  Writes embedding (Voyage 1024-dim) and embedding_v2 (CLIP 512-dim) when both are
 *  available. Silently no-ops without any embed key. */
export async function embedItem(item: Item): Promise<boolean> {
  if (voyageDown()) return false;
  const text = embedText(item);
  if (!item.thumb_path && !text) return false;
  try {
    let imageUrl: string | undefined;
    if (item.thumb_path) {
      const urls = await signedUrls([item.thumb_path]);
      imageUrl = urls.get(item.thumb_path);
    }
    const res = await apiFetch("/api/ai/embed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imageUrl, text: text || undefined, input_type: "document" }),
    });
    if (res.status === 503) {
      voyageCooldownUntil = Date.now() + VOYAGE_COOLDOWN_MS;
      return false;
    }
    if (!res.ok) return false;
    voyageCooldownUntil = 0;
    const { embedding, embedding_v2 } = await res.json();
    if (!Array.isArray(embedding)) return false;
    const patch: Record<string, unknown> = { embedding };
    if (Array.isArray(embedding_v2)) patch.embedding_v2 = embedding_v2;
    const { error } = await supabase.from("items").update(patch).eq("id", item.id);
    return !error;
  } catch {
    return false; // background job — never surface errors
  }
}

let backfillRunning = false;

/** Embed any items still missing vectors, a few at a time. Safe to call on every load. */
export async function backfillEmbeddings(batch = 12): Promise<void> {
  if (backfillRunning || voyageDown()) return;
  backfillRunning = true;
  try {
    const { data } = await supabase
      .from("items")
      .select(ITEM_COLS)
      .is("embedding", null)
      .order("created_at", { ascending: false })
      .limit(batch);
    let failures = 0;
    for (const item of (data ?? []) as unknown as Item[]) {
      const ok = await embedItem(item);
      if (!ok && voyageDown()) break;
      // back off after repeated failures (e.g. 429 rate limits) — next app load retries
      if (!ok && ++failures >= 2) break;
      if (ok) failures = 0;
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    backfillRunning = false;
  }
}

let captionBackfillRunning = false;

/** Caption + tag image items whose caption is missing OR written by an older prompt version,
 *  a few per load, re-embedding each so its vector carries the style words. Closes the gap for
 *  pre-AI / failed-caption saves and gradually upgrades the whole library whenever
 *  CAPTION_VERSION bumps. `onCaptioned` lets the caller patch live state so an immediate
 *  "more like this" uses the fresh caption. `kindForItem` lets callers route type spaces
 *  through the type-aware caption prompt. No key -> no-op. */
export async function backfillCaptions(
  onCaptioned?: (item: Item) => void,
  batch = 8,
  kindForItem?: (item: Item) => "type" | undefined
): Promise<void> {
  if (captionBackfillRunning || aiDown()) return;
  captionBackfillRunning = true;
  try {
    const { data } = await supabase
      .from("items")
      .select(ITEM_COLS)
      .or(`ai_caption.is.null,caption_v.lt.${CAPTION_VERSION}`)
      .not("thumb_path", "is", null)
      .order("created_at", { ascending: false })
      .limit(batch);
    let failures = 0;
    for (const item of (data ?? []) as unknown as Item[]) {
      if (aiDown()) break; // key went away / 503 mid-run
      const kind = kindForItem?.(item);
      const ok = await captionItem(item, async (updated) => {
        // awaited so caption→embed runs serially; otherwise a batch fans out concurrent embed
        // POSTs that burst the Voyage rate limit and trip the cooldown
        await embedItem(updated);
        onCaptioned?.(updated);
      }, kind);
      // back off after repeated failures (e.g. 429 rate limits) — next app load retries
      if (!ok && ++failures >= 2) break;
      if (ok) failures = 0;
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    captionBackfillRunning = false;
  }
}

let thumbBackfillRunning = false;

/** Regenerate a proper 480px thumbnail + colour palette for one item from its stored full image,
 *  without touching the full. Leaves storage_path alone; only adds a thumb + colours + dims. */
async function reThumb(item: Item, onThumb?: (item: Item) => void): Promise<boolean> {
  if (!item.storage_path) return false;
  try {
    const urls = await signedUrls([item.storage_path]);
    const fullUrl = urls.get(item.storage_path);
    if (!fullUrl) return false;
    const res = await fetch(fullUrl);
    if (!res.ok) return false;
    const { thumbBlob, colors, width, height, ext } = await makeThumb(await res.blob());
    const base = item.storage_path.split("/").pop()!.replace(/\.[^.]+$/, ""); // content hash
    const thumb_path = `thumbs/${base}.${ext}`;
    const up = await supabase.storage
      .from("media")
      .upload(thumb_path, thumbBlob, { upsert: true, contentType: thumbBlob.type });
    if (up.error) return false;
    const updated = await updateItem(item.id, {
      thumb_path,
      colors,
      width: item.width ?? width,
      height: item.height ?? height,
    });
    onThumb?.(updated);
    return true;
  } catch {
    return false; // background job — never surface errors
  }
}

/** Backfill proper thumbnails + colours for image items stored without them — clip-route saves use
 *  the full image as the thumb and skip colour extraction (heavy grids + no colour filter). Runs a
 *  few per load, downloading each full image once. `onThumb` lets the caller patch live state. */
export async function backfillThumbs(onThumb?: (item: Item) => void, batch = 4): Promise<void> {
  if (thumbBackfillRunning) return;
  thumbBackfillRunning = true;
  try {
    const { data } = await supabase
      .from("items")
      .select(ITEM_COLS)
      .not("thumb_path", "is", null)
      .not("storage_path", "is", null)
      .order("created_at", { ascending: false })
      .limit(200);
    const broken = ((data ?? []) as unknown as Item[])
      .filter((i) => (i.colors?.length ?? 0) === 0 || i.thumb_path === i.storage_path)
      .slice(0, batch);
    for (const item of broken) {
      await reThumb(item, onThumb);
      await new Promise((r) => setTimeout(r, 600));
    }
  } finally {
    thumbBackfillRunning = false;
  }
}

/** Visual nearest-neighbours for an item, library-wide. Prefers v2 (CLIP) index;
 *  falls back to v1 (Voyage) when the item hasn't been re-embedded yet. */
export async function matchToItem(itemId: string, count = 12): Promise<Item[]> {
  const { data: v2, error: e2 } = await supabase.rpc("match_to_item_v2", { p_item_id: itemId, p_count: count });
  if (!e2 && (v2 ?? []).length) return (v2 ?? []) as Item[];
  const { data, error } = await supabase.rpc("match_to_item", { p_item_id: itemId, p_count: count });
  if (error) return [];
  return (data ?? []) as Item[];
}

/** Semantic text -> image search. Prefers the v2 (CLIP) index; falls back to v1 (Voyage).
 *  Returns null when no embedding service is reachable. */
export async function semanticSearch(query: string, count = 60): Promise<Item[] | null> {
  if (voyageDown()) return null;
  try {
    const res = await apiFetch("/api/ai/embed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: query, input_type: "query" }),
    });
    if (res.status === 503) {
      voyageCooldownUntil = Date.now() + VOYAGE_COOLDOWN_MS;
      return null;
    }
    if (!res.ok) return null;
    voyageCooldownUntil = 0;
    const { embedding, embedding_v2 } = await res.json();
    // Try v2 index first (CLIP 512-dim); fall back to v1 (Voyage 1024-dim)
    if (embedding_v2) {
      const { data: v2, error: e2 } = await supabase.rpc("match_items_v2", { p_query: embedding_v2, p_count: count });
      if (!e2 && (v2 ?? []).length) return (v2 ?? []) as Item[];
    }
    const { data, error } = await supabase.rpc("match_items", { p_query: embedding, p_count: count });
    if (error) return null;
    return (data ?? []) as Item[];
  } catch {
    return null;
  }
}

// ---------- Discover / Feed ----------

export interface Suggestion {
  url: string;
  title: string | null;
  image: string | null;
  domain: string;
  source: string;
  blurb?: string | null;
}

const toDomain = (e: string): string => {
  if (!/^https?:\/\//i.test(e)) return e;
  try { return new URL(e).hostname.replace(/^www\./, ""); } catch { return ""; }
};

/** Instant "similar" from the harvested web_corpus index (the mini-Pinterest path).
 *  Query vector priority: the item's own vector (itemId) > board taste centroid (spaceId)
 *  > embedded query text > the whole library's centroid. Only matches above a similarity
 *  floor count — a thin index must fall through to the live pipeline, not present its
 *  nearest-whatever as a match. Returns [] whenever the corpus can't answer. */
export interface DiscoverFilters {
  /** Feed lane: "site" or "type" (foundries/specimens). */
  kind?: "site" | "type";
  /** Named palette bucket (e.g. "red", "dark") — corpus rows carry extracted colours. */
  color?: string;
  /** CIE LAB target [L, a, b] for delta-E colour-verified discovery (Phase 2). */
  colorLab?: [number, number, number];
  /** Structured facet constraints — keys from FACET_VOCABULARY, values are required labels.
   *  e.g. { mood: ["crafted", "heritage"], era: ["contemporary"] } */
  facets?: Record<string, string[]>;
}

/** Discovery policy: controls *how* candidates are retrieved, independent of content type. */
export type DiscoveryMode = "foryou" | "fresh" | "explore" | "trending";

export async function corpusSimilar(
  query: string | null,
  spaceId: string | null,
  count = 24,
  excludeDomains: string[] = [],
  itemId?: string | null,
  minSimOverride?: number,
  filters?: DiscoverFilters,
  excludeUrls: string[] = [],
  preVec?: number[] | null,
): Promise<Suggestion[]> {
  try {
    // --- v2 path: CLIP 512-dim (preferred when available) ---
    const v2Result = await corpusSimilarV2(query, spaceId, count, excludeDomains, itemId, minSimOverride, filters, excludeUrls, preVec);
    if (v2Result !== null) return v2Result;

    // --- v1 fallback: Voyage 1024-dim ---
    let queryVec: unknown = null;
    let minSim = 0.42;
    if (itemId) {
      const { data } = await supabase.from("items").select("embedding").eq("id", itemId).single();
      queryVec = data?.embedding ?? null;
    }
    if (!queryVec && (spaceId || !query)) {
      const { data } = await supabase.rpc("space_centroid", { p_space_id: spaceId });
      queryVec = data ?? null;
    }
    if (!queryVec && query && !voyageDown()) {
      minSim = 0.32;
      const res = await apiFetch("/api/ai/embed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: query, input_type: "query" }),
      });
      if (res.ok) queryVec = (await res.json()).embedding ?? null;
    }
    if (minSimOverride !== undefined) minSim = minSimOverride;
    if (!queryVec) return [];
    const { data, error } = await supabase.rpc("match_corpus", {
      p_query: queryVec,
      p_count: count,
      p_exclude: excludeDomains.slice(0, 400),
      p_kind: filters?.kind ?? null,
      p_color: filters?.color ?? null,
      p_exclude_urls: excludeUrls.slice(0, 400),
    });
    if (error) return [];
    return corpusRowsToSuggestions(data ?? [], minSim);
  } catch {
    return [];
  }
}

/** v2 corpus similarity using CLIP 512-dim index. Returns null when no v2 query
 *  vector can be obtained (not yet embedded), so the caller falls back to v1.
 *  `preVec`: optional pre-computed query vector (e.g. preference-blended centroid)
 *  that skips the centroid RPC when provided. */
async function corpusSimilarV2(
  query: string | null,
  spaceId: string | null,
  count: number,
  excludeDomains: string[],
  itemId: string | null | undefined,
  minSimOverride: number | undefined,
  filters: DiscoverFilters | undefined,
  excludeUrls: string[],
  preVec?: number[] | null,
): Promise<Suggestion[] | null> {
  try {
    let queryVec: unknown = null;
    let minSim = 0.35; // CLIP cosines are calibrated differently; start a touch lower
    if (itemId) {
      const { data } = await supabase.from("items").select("embedding_v2").eq("id", itemId).single();
      queryVec = data?.embedding_v2 ?? null;
    }
    // Use pre-computed preference vector when supplied (skips centroid RPC)
    if (!queryVec && preVec) {
      queryVec = preVec;
    }
    if (!queryVec && (spaceId || !query)) {
      const { data } = await supabase.rpc("space_centroid_v2", { p_space_id: spaceId });
      queryVec = data ?? null;
    }
    if (!queryVec && query && !voyageDown()) {
      minSim = 0.25; // cross-modal text→image floor
      const res = await apiFetch("/api/ai/embed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: query, input_type: "query" }),
      });
      if (res.ok) {
        const body = await res.json();
        queryVec = body.embedding_v2 ?? null;
      }
    }
    if (minSimOverride !== undefined) minSim = minSimOverride;
    if (!queryVec) return null; // no v2 vector available — fall back

    // --- Colour-verified path: use match_corpus_colour_v2 when a LAB target is given ---
    if (filters?.colorLab) {
      const { data: colourData, error: colourErr } = await supabase.rpc("match_corpus_colour_v2", {
        p_query: queryVec,
        p_target_lab: filters.colorLab,
        p_max_de: 28,
        p_count: count,
        p_exclude: excludeDomains.slice(0, 400),
        p_kind: filters.kind ?? null,
        p_exclude_urls: excludeUrls.slice(0, 400),
      });
      if (!colourErr && (colourData ?? []).length) {
        // Add delta-E to blurb for explainability
        const hits = (colourData as Array<CorpusRow & { min_delta_e?: number }>)
          .filter((r) => r.similarity >= minSim)
          .map((r) => ({
            url: r.url,
            title: r.title,
            image: r.image,
            domain: r.domain,
            source: `index/${r.source}`,
            blurb: [
              r.tags?.length ? r.tags.slice(0, 2).join(", ") : null,
              r.min_delta_e != null ? `colour ΔE ${Math.round(r.min_delta_e)}` : null,
              `${Math.round(r.similarity * 100)}% match`,
            ].filter(Boolean).join(" · "),
          }));
        if (hits.length) return hits;
      }
      // No colour-matched results — fall through to regular v2 search without the LAB gate
    }

    // --- Facet path: use match_corpus_facets_v2 when facet constraints are given ---
    if (filters?.facets && Object.keys(filters.facets).length) {
      const { data: facetData, error: facetErr } = await supabase.rpc("match_corpus_facets_v2", {
        p_query: queryVec,
        p_facets: filters.facets,
        p_count: count,
        p_exclude: excludeDomains.slice(0, 400),
        p_kind: filters.kind ?? null,
        p_exclude_urls: excludeUrls.slice(0, 400),
      });
      if (!facetErr && (facetData ?? []).length) {
        const hits = corpusRowsToSuggestions(facetData ?? [], minSim);
        if (hits.length) return hits;
      }
    }

    const { data, error } = await supabase.rpc("match_corpus_v2", {
      p_query: queryVec,
      p_count: count,
      p_exclude: excludeDomains.slice(0, 400),
      p_kind: filters?.kind ?? null,
      p_color: filters?.color ?? null,
      p_exclude_urls: excludeUrls.slice(0, 400),
    });
    if (error || !(data ?? []).length) return null;
    const hits = corpusRowsToSuggestions(data ?? [], minSim);
    return hits.length ? hits : null;
  } catch {
    return null;
  }
}

type CorpusRow = { url: string; domain: string; title: string | null; image: string | null; blurb: string | null; tags: string[]; source: string; similarity: number };

function corpusRowsToSuggestions(rows: CorpusRow[], minSim: number): Suggestion[] {
  return rows.filter((r) => r.similarity >= minSim).map((r) => ({
    url: r.url,
    title: r.title,
    image: r.image,
    domain: r.domain,
    source: `index/${r.source}`,
    blurb: [
      r.tags?.length ? r.tags.slice(0, 3).join(", ") : null,
      `${Math.round(r.similarity * 100)}% taste match`,
    ].filter(Boolean).join(" — "),
  }));
}

// ---------- Phase 1: lane helpers ----------

/** Reciprocal Rank Fusion: fuse multiple ranked candidate lists into one.
 *  Standard constant k=60 — robust across list sizes. Dedupes by URL. */
function rrfFuse(lists: Suggestion[][], k = 60): Suggestion[] {
  const scores = new Map<string, number>();
  const items = new Map<string, Suggestion>();
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      scores.set(s.url, (scores.get(s.url) ?? 0) + 1 / (k + i + 1));
      if (!items.has(s.url)) items.set(s.url, s);
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([url]) => items.get(url)!)
    .filter(Boolean);
}

/** MMR-lite diversity pass: cap each domain at 2 appearances so one source
 *  can't flood the feed. Preserves relative ranking within the cap. */
function mmrDiversify(items: Suggestion[]): Suggestion[] {
  const counts = new Map<string, number>();
  return items.filter((s) => {
    const n = counts.get(s.domain) ?? 0;
    if (n >= 2) return false;
    counts.set(s.domain, n + 1);
    return true;
  });
}

type FreshRow = { url: string; domain: string; title: string | null; image: string | null; blurb: string | null; tags: string[]; source: string };

/** Fresh lane: recency-ordered corpus, no taste signal. */
async function freshCorpus(exclude: string[], filters?: DiscoverFilters): Promise<Suggestion[]> {
  try {
    const excludeDomains = [...new Set(exclude.map(toDomain))].filter(Boolean);
    const excludeUrls = exclude.filter((e) => /^https?:\/\//i.test(e));
    const { data, error } = await supabase.rpc("fresh_corpus_v2", {
      p_count: 30,
      p_exclude: excludeDomains.slice(0, 400),
      p_kind: filters?.kind ?? null,
      p_color: filters?.color ?? null,
      p_exclude_urls: excludeUrls.slice(0, 400),
    });
    if (error || !data?.length) return [];
    return (data as FreshRow[]).map((r) => ({
      url: r.url, title: r.title, image: r.image, domain: r.domain,
      source: `index/${r.source}`,
      blurb: r.tags?.length ? r.tags.slice(0, 3).join(", ") : null,
    }));
  } catch { return []; }
}

/** Explore lane: random corpus sample, excluding near-taste duplicates. */
async function exploreCorpus(spaceId: string | null, exclude: string[], filters?: DiscoverFilters): Promise<Suggestion[]> {
  try {
    const excludeDomains = [...new Set(exclude.map(toDomain))].filter(Boolean);
    const excludeUrls = exclude.filter((e) => /^https?:\/\//i.test(e));
    const { data: centroid } = await supabase.rpc("space_centroid_v2", { p_space_id: spaceId });
    const { data, error } = await supabase.rpc("explore_corpus_v2", {
      p_query: centroid ?? null,
      p_count: 30,
      p_exclude: excludeDomains.slice(0, 400),
      p_kind: filters?.kind ?? null,
      p_color: filters?.color ?? null,
      p_exclude_urls: excludeUrls.slice(0, 400),
    });
    if (error || !data?.length) return [];
    return (data as FreshRow[]).map((r) => ({
      url: r.url, title: r.title, image: r.image, domain: r.domain,
      source: `index/${r.source}`,
      blurb: r.tags?.length ? r.tags.slice(0, 3).join(", ") : null,
    }));
  } catch { return []; }
}

/** L2-normalise a vector so cosine queries stay calibrated after vector arithmetic. */
function normalizeVec(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm > 0 ? v.map((x) => x / norm) : v;
}

/**
 * Preference vector: liked_centroid − 0.3 × disliked_centroid, L2-normalised.
 * When there are no dislikes, returns the pure liked centroid (space_centroid_v2).
 * Returns null when the board has no embedded items.
 */
async function preferenceVector(spaceId: string | null, userId: string | null): Promise<number[] | null> {
  const [{ data: liked }, { data: disliked }] = await Promise.all([
    supabase.rpc("space_centroid_v2", { p_space_id: spaceId }),
    userId
      ? supabase.rpc("dislike_centroid_v2", { p_user_id: userId })
      : Promise.resolve({ data: null }),
  ]);
  if (!liked) return null;
  const likedArr = liked as number[];
  if (!disliked) return likedArr;
  const dislikedArr = disliked as number[];
  if (likedArr.length !== dislikedArr.length) return likedArr;
  const blended = likedArr.map((v, i) => v - 0.3 * (dislikedArr[i] ?? 0));
  return normalizeVec(blended);
}

/** Trending lane: corpus rows with positive engagement velocity (14-day window). */
async function trendingCorpus(exclude: string[], filters?: DiscoverFilters): Promise<Suggestion[]> {
  try {
    const excludeDomains = [...new Set(exclude.map(toDomain))].filter(Boolean);
    const excludeUrls = exclude.filter((e) => /^https?:\/\//i.test(e));
    const { data, error } = await supabase.rpc("trending_corpus_v2", {
      p_count: 30,
      p_exclude: excludeDomains.slice(0, 400),
      p_kind: filters?.kind ?? null,
      p_exclude_urls: excludeUrls.slice(0, 400),
    });
    if (error || !data?.length) return [];
    return (data as FreshRow[]).map((r) => ({
      url: r.url, title: r.title, image: r.image, domain: r.domain,
      source: `index/${r.source}`,
      blurb: r.tags?.length ? r.tags.slice(0, 3).join(", ") : null,
    }));
  } catch { return []; }
}

/** Log a discovery interaction — fire-and-forget, never throws. */
export async function logDiscoveryEvent(
  url: string,
  kind: "impression" | "open" | "save" | "like" | "dislike" | "dwell",
  opts: { lane?: string; refKey?: string; model?: string; value?: number } = {}
): Promise<void> {
  try {
    const { data } = await supabase.auth.getUser();
    if (!data.user) return;
    await supabase.from("discovery_events").insert({
      user_id: data.user.id,
      url,
      kind,
      lane: opts.lane ?? null,
      ref_key: opts.refKey ?? null,
      model: opts.model ?? null,
      value: opts.value ?? null,
    });
  } catch { /* best-effort */ }
}

/** Consume SSE stream from /api/discover, calling onPartial as batches arrive. */
async function discoverStreaming(
  body: object,
  onPartial: (items: Suggestion[]) => void,
): Promise<Suggestion[]> {
  const res = await apiFetch("/api/discover", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Discover failed");
  const ct = res.headers.get("content-type") ?? "";
  // Server may not support streaming yet — fall back to JSON
  if (!ct.includes("text/event-stream")) {
    const { items } = await res.json();
    return (items ?? []) as Suggestion[];
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let allItems: Suggestion[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Parse SSE events: "event: <name>\ndata: <json>\n\n"
    const parts = buffer.split("\n\n");
    buffer = parts.pop()!; // keep the incomplete trailing chunk
    for (const part of parts) {
      const lines = part.split("\n");
      let eventName = "";
      let data = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) eventName = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (eventName === "items" && data) {
        try {
          // Each "items" event is a snapshot of the current judge's best matches.
          // Merge with existing items (dedup by URL) so cards never disappear mid-stream.
          const batch = JSON.parse(data) as Suggestion[];
          const seen = new Set(allItems.map((s) => s.url));
          for (const s of batch) {
            if (!seen.has(s.url)) { allItems.push(s); seen.add(s.url); }
          }
          onPartial([...allItems]);
        } catch { /* malformed event, skip */ }
      }
    }
  }
  return allItems;
}

export async function discover(query: string | null, extraExclude: string[] = [], mode?: "type", imageUrl?: string | null, tasteSpaceId?: string, similarToItemId?: string | null, filters?: DiscoverFilters, discoveryMode: DiscoveryMode = "foryou", onPartial?: (items: Suggestion[]) => void): Promise<Suggestion[]> {
  const [taste, domains, seen] = await Promise.all([
    tasteProfile(tasteSpaceId),
    query ? Promise.resolve([] as string[]) : libraryDomains(),
    seenUrls(),
  ]);
  // Prioritise session exclusions (extraExclude) over stale seen URLs —
  // don't let a large seen history starve the pool of fresh results.
  const exclude = [...extraExclude, ...domains, ...seen.slice(0, Math.max(0, 300 - extraExclude.length))];
  const graded = !!imageUrl && !!query;

  // --- Fresh lane: recency-sorted corpus, no taste signal ---
  if (discoveryMode === "fresh" && !query && mode !== "type") {
    const fresh = await freshCorpus(exclude, filters);
    if (fresh.length >= 6) return mmrDiversify(fresh);
    // thin fresh corpus → fall through to For You
  }

  // --- Explore lane: random far-from-centroid corpus ---
  if (discoveryMode === "explore" && !query && mode !== "type") {
    const explored = await exploreCorpus(tasteSpaceId ?? null, exclude, filters);
    if (explored.length >= 6) return mmrDiversify(explored);
    // thin explore pool → fall through to For You
  }

  // --- Rising lane: engagement-velocity ranked corpus. ---
  // Pure trend signal: return whatever the index ranks as rising, or an empty list
  // when there isn't enough activity yet. We deliberately DON'T fall through to For
  // You — a "Rising" tab that silently serves taste-ranked results is misleading.
  // The Feed renders an honest "warming up" empty state instead (see Feed.tsx).
  if (discoveryMode === "trending" && !query && mode !== "type") {
    const trending = await trendingCorpus(exclude, filters);
    return trending.length ? mmrDiversify(trending) : [];
  }

  // --- For You lane (default) + graded visual-similar path ---
  // Preference vector: liked centroid − 0.3 × disliked centroid (negative taste signal).
  // Only used on the pure For You path with no specific item/query reference.
  let prefVec: number[] | null = null;
  if (discoveryMode === "foryou" && !query && !similarToItemId && !graded && mode !== "type") {
    const { data: auth } = await supabase.auth.getUser();
    prefVec = await preferenceVector(tasteSpaceId ?? null, auth?.user?.id ?? null);
  }

  let corpus: Suggestion[] = [];
  if (mode !== "type") {
    const excludeDomains = [...new Set([...exclude.map(toDomain), ...domains])].filter(Boolean);
    const excludeUrls = exclude.filter((e) => /^https?:\/\//i.test(e));
    corpus = await corpusSimilar(query, tasteSpaceId ?? null, 24, excludeDomains, similarToItemId, graded ? 0.25 : undefined, filters, excludeUrls, prefVec);
    // palette filtering only the index can honour — return directly, live-web has unknown colours
    if (filters?.color) return corpus;
    // Phase 1: the corpus≥10 early-return bypass is removed — always run the full pipeline
    // so live-web results fill gaps and the corpus is enriched with every search.
  }

  // Augment the Gemini query with active colour/facet constraints so the live-web path
  // respects them even when the corpus is empty or too thin to serve the colour filter.
  const filterAddendum = filters ? filtersToQueryAddendum(filters) : "";
  const augmentedQuery = filterAddendum
    ? [query, filterAddendum].filter(Boolean).join(", ")
    : query || undefined;

  // Progressive display: emit corpus results immediately so the UI shows cards in ~200ms
  // while the full web-search + visual-judge pipeline runs (10-13s).
  if (graded && onPartial && corpus.length) {
    onPartial(mmrDiversify(corpus));
  }

  const discoverBody = {
    q: augmentedQuery,
    filterHints: filterAddendum || undefined,
    mode: filters?.kind === "type" ? "type" : mode,
    img: imageUrl || undefined,
    taste,
    exclude,
    candidates: graded ? corpus : [],
    refKey: similarToItemId ? `item:${similarToItemId}` : tasteSpaceId ? `space:${tasteSpaceId}` : undefined,
  };

  // When streaming is available (graded + callback), consume SSE for incremental results
  if (graded && onPartial) {
    const streamed = await discoverStreaming(discoverBody, onPartial);
    return streamed;
  }

  const res = await apiFetch("/api/discover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(discoverBody),
  });
  if (!res.ok) throw new Error("Discover failed");
  const { items } = await res.json();
  const fromApi = (items ?? []) as Suggestion[];
  if (graded) return fromApi; // corpus candidates were judged server-side

  // RRF fusion of corpus taste-matches + live-web results, then MMR diversity pass
  return mmrDiversify(rrfFuse([corpus, fromApi]));
}

/** Distil one board's references into a named aesthetic via Gemini — a style brief that can
 *  drive a "find more like this board" web search. Also returns a representative image (the
 *  most recent visual item) so the discover pipeline can ground its visual judge in actual
 *  pixels from the board. Returns null ONLY when the board has no described items at all;
 *  if just the brief generation fails (Gemini down), brief is null but the caller can still
 *  proceed — corpus-centroid retrieval doesn't need a brief. */
const briefCache = new Map<string, { hash: string; brief: string | null; at: number }>();
export async function boardBrief(spaceId: string, name?: string): Promise<{ brief: string | null; image: string | null; images: string[] } | null> {
  const { data } = await supabase
    .from("items")
    .select(ITEM_COLS)
    .eq("space_id", spaceId)
    .order("created_at", { ascending: false })
    .limit(40);
  const items = (data ?? []) as unknown as Item[];
  const described = items.filter((i) => i.ai_caption || (i.tags ?? []).length);
  if (!described.length) return null;

  // Cache brief by space + item-set hash: same board → skip the Gemini call (saves 3-5s).
  // Invalidated when items change (hash differs) or after 1 hour.
  const itemIds = described.slice(0, 30).map((i) => i.id).sort().join(",");
  const hash = itemIds; // IDs are UUIDs — same set of items means same brief
  const cached = briefCache.get(spaceId);
  let brief: string | null = null;
  if (cached && cached.hash === hash && Date.now() - cached.at < 3600_000) {
    brief = cached.brief;
  } else {
    try {
      const res = await apiFetch("/api/ai/brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          items: described.slice(0, 30).map((i) => ({
            caption: i.ai_caption,
            tags: i.tags,
            colors: i.colors,
          })),
        }),
      });
      if (res.ok) brief = (await res.json()).brief ?? null;
    } catch { /* brief is a nice-to-have; centroid retrieval works without it */ }
    briefCache.set(spaceId, { hash, brief, at: Date.now() });
  }
  // Rep thumbs: items NEAREST the board's centroid (top 3), not most-recent.
  // Returns multiple references for multi-reference board search.
  let repThumbs: string[] = [];
  try {
    const { data: reps } = await supabase.rpc("space_rep_thumbs", { p_space_id: spaceId, p_count: 3 });
    repThumbs = ((reps as { thumb_path: string }[] | null) ?? [])
      .map((r) => r.thumb_path)
      .filter(Boolean);
  } catch { /* fall through to recency */ }
  if (!repThumbs.length) {
    const rep = items.find((i) => i.thumb_path && i.type === "image") ?? items.find((i) => i.thumb_path);
    if (rep?.thumb_path) repThumbs = [rep.thumb_path];
  }
  const urlMap = repThumbs.length ? await signedUrls(repThumbs) : new Map<string, string>();
  const images = repThumbs.map((p) => urlMap.get(p)).filter((u): u is string => !!u);
  // Keep backward-compat: primary `image` = first rep thumb
  return { brief, image: images[0] ?? null, images };
}

/** Idle corpus maintenance, called once per app load: drain a few pending embeds; full
 *  re-harvest at most once a day (the gallery adapters make ~15 outbound fetches — too
 *  heavy for every load). Fire-and-forget: never surfaces errors. */
export async function corpusTick(): Promise<void> {
  try {
    const key = "mood:lastCorpusHarvest";
    const last = Number(localStorage.getItem(key) ?? 0);
    const doHarvest = Date.now() - last > 24 * 60 * 60 * 1000;
    if (doHarvest) localStorage.setItem(key, String(Date.now()));
    await apiFetch("/api/corpus/harvest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // small per-load slices: drain embeds, recolour pre-palette rows, and rotate a few
      // rows through hygiene (dead-link prune + logo repair) so the index self-cleans.
      body: JSON.stringify({ harvest: doHarvest, embed: 4, recolor: 3, hygiene: 4 }),
    });
  } catch { /* background maintenance */ }
}

async function seenUrls(): Promise<string[]> {
  // Disliked/saved: always exclude.  Seen (impressed): exclude for 7 days so the
  // feed stays fresh across sessions without permanently burning through the corpus.
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from("seen_suggestions")
    .select("url, verdict")
    .or(`verdict.in.(disliked,saved),and(verdict.eq.seen,created_at.gte.${weekAgo})`)
    .limit(800);
  return (data ?? []).map((r) => r.url);
}

export async function markSeen(url: string, verdict: "seen" | "liked" | "disliked" | "saved"): Promise<void> {
  const uid = await userId();
  await supabase.from("seen_suggestions").upsert({ user_id: uid, url, verdict }, { onConflict: "user_id,url" });
}

export async function touchViewed(id: string): Promise<void> {
  await supabase.from("items").update({ last_viewed_at: new Date().toISOString() }).eq("id", id);
}

// ---------- dead-link check ----------

/** Background reachability check for an item's source URL. Fire-and-forget: returns the patched
 *  item if it flips dead_link (so callers can update state in place), else null. Never throws —
 *  the server does the SSRF-guarded fetch with a retry; some valid sites block HEAD, so a save is
 *  never blocked on this. */
export async function checkLink(item: Item): Promise<Item | null> {
  if (!item.source_url) return null;
  try {
    const res = await apiFetch(`/api/check-link?url=${encodeURIComponent(item.source_url)}`);
    if (!res.ok) return null; // our own endpoint failed — don't mark anything
    const { dead } = (await res.json()) as { dead?: boolean };
    if (dead === undefined || dead === item.dead_link) return null;
    return await updateItem(item.id, { dead_link: dead });
  } catch {
    return null;
  }
}
