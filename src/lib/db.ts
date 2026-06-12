import { supabase, authToken } from "./supabase";
import { makeThumb, processImage, uploadProcessed } from "./media";
import type { Item, ItemType, Library, LibraryMode, LinkMeta, Space, Stack } from "./types";

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

/** Unstacked-item count per space_id — drives the sidebar tallies (matches what each space's grid shows). */
export async function fetchSpaceCounts(): Promise<Map<string, number>> {
  const { data, error } = await supabase.from("items").select("space_id").is("stack_id", null).limit(10000);
  if (error) throw error;
  const m = new Map<string, number>();
  for (const row of (data ?? []) as { space_id: string | null }[]) {
    if (row.space_id) m.set(row.space_id, (m.get(row.space_id) ?? 0) + 1);
  }
  return m;
}

export async function fetchItems(spaceId: string | "all", search: string): Promise<Item[]> {
  let q = supabase
    .from("items")
    .select(ITEM_COLS)
    .is("stack_id", null)
    .order("created_at", { ascending: false })
    .limit(500);
  if (spaceId !== "all") q = q.eq("space_id", spaceId);
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
    .limit(500);
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
  const { error: e2 } = await supabase.from("items").update({ stack_id: data.id }).in("id", itemIds);
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

/** Embed one item (image + caption hybrid) in the background. Silently no-ops without a key. */
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
    const { embedding } = await res.json();
    if (!Array.isArray(embedding)) return false;
    const { error } = await supabase.from("items").update({ embedding }).eq("id", item.id);
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

/** Visual nearest-neighbours for an item, library-wide. Empty when not yet embedded. */
export async function matchToItem(itemId: string, count = 12): Promise<Item[]> {
  const { data, error } = await supabase.rpc("match_to_item", { p_item_id: itemId, p_count: count });
  if (error) return [];
  return (data ?? []) as Item[];
}

/** Semantic text -> image search. Returns null when embeddings are unavailable. */
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
    const { embedding } = await res.json();
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
export async function corpusSimilar(
  query: string | null,
  spaceId: string | null,
  count = 24,
  excludeDomains: string[] = [],
  itemId?: string | null,
  minSimOverride?: number
): Promise<Suggestion[]> {
  try {
    let queryVec: unknown = null;
    // same-modality floor (item/board vectors vs corpus screenshot vectors); tune as the index grows
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
      minSim = 0.32; // cross-modal (text query vs image docs) cosines run lower
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
    });
    if (error) return [];
    type CorpusRow = { url: string; domain: string; title: string | null; image: string | null; blurb: string | null; tags: string[]; source: string; similarity: number };
    return ((data ?? []) as CorpusRow[]).filter((r) => r.similarity >= minSim).map((r) => ({
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
  } catch {
    return [];
  }
}

export async function discover(query: string | null, extraExclude: string[] = [], mode?: "type", imageUrl?: string | null, tasteSpaceId?: string, similarToItemId?: string | null): Promise<Suggestion[]> {
  // For web-similar searches (query set), skip library domain exclusions — the user wants
  // aesthetic matches even if they've already saved work from those domains.
  // For Discover (no query), exclude library domains so we don't re-surface known work.
  const [taste, domains, seen] = await Promise.all([
    tasteTags(tasteSpaceId),
    query ? Promise.resolve([] as string[]) : libraryDomains(),
    seenUrls(),
  ]);
  const exclude = [...extraExclude, ...domains, ...seen].slice(0, 400);

  // Corpus retrieval: instant vector hits over the owned index. When a reference image
  // exists they become CANDIDATES for the server's visual judge (graded 0-10 against the
  // reference — retrieval proposes, grading decides). Without a reference image there's
  // nothing to grade against, so confident corpus hits return directly. Type mode keeps
  // its dedicated foundry pipeline.
  const graded = !!imageUrl && !!query;
  let corpus: Suggestion[] = [];
  if (mode !== "type") {
    const excludeDomains = [...new Set([...exclude.map(toDomain), ...domains])].filter(Boolean);
    // grading filters junk itself, so feed it a wider, lower-floor candidate set
    corpus = await corpusSimilar(query, tasteSpaceId ?? null, 24, excludeDomains, similarToItemId, graded ? 0.25 : undefined);
    if (!graded && corpus.length >= 10) return corpus;
  }

  const res = await apiFetch("/api/discover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      q: query || undefined,
      mode,
      img: imageUrl || undefined,
      taste,
      exclude,
      candidates: graded ? corpus : [],
      refKey: similarToItemId ? `item:${similarToItemId}` : tasteSpaceId ? `space:${tasteSpaceId}` : undefined,
    }),
  });
  if (!res.ok) throw new Error("Discover failed");
  const { items } = await res.json();
  const fromApi = (items ?? []) as Suggestion[];
  if (graded) return fromApi; // corpus candidates were judged server-side — already included or cut
  const have = new Set(corpus.map((c) => c.domain));
  return [...corpus, ...fromApi.filter((i) => !have.has(i.domain))];
}

/** Distil one board's references into a named aesthetic via Gemini — a style brief that can
 *  drive a "find more like this board" web search. Also returns a representative image (the
 *  most recent visual item) so the discover pipeline can ground its visual judge in actual
 *  pixels from the board. Returns null ONLY when the board has no described items at all;
 *  if just the brief generation fails (Gemini down), brief is null but the caller can still
 *  proceed — corpus-centroid retrieval doesn't need a brief. */
export async function boardBrief(spaceId: string, name?: string): Promise<{ brief: string | null; image: string | null } | null> {
  const { data } = await supabase
    .from("items")
    .select(ITEM_COLS)
    .eq("space_id", spaceId)
    .order("created_at", { ascending: false })
    .limit(40);
  const items = (data ?? []) as unknown as Item[];
  const described = items.filter((i) => i.ai_caption || (i.tags ?? []).length);
  if (!described.length) return null;
  let brief: string | null = null;
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
  // Reference for the visual judge: the item NEAREST the board's centroid, not the most
  // recent one — recency picks outliers (a stark-white capture on an otherwise dark board)
  // and the judge then grades against the wrong aesthetic.
  let repThumb: string | null = null;
  try {
    const { data: reps } = await supabase.rpc("space_rep_thumbs", { p_space_id: spaceId, p_count: 1 });
    repThumb = (reps as { thumb_path: string }[] | null)?.[0]?.thumb_path ?? null;
  } catch { /* fall through to recency */ }
  if (!repThumb) {
    const rep = items.find((i) => i.thumb_path && i.type === "image") ?? items.find((i) => i.thumb_path);
    repThumb = rep?.thumb_path ?? null;
  }
  const image = repThumb ? (await signedUrls([repThumb])).get(repThumb) ?? null : null;
  return { brief, image };
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
      body: JSON.stringify({ harvest: doHarvest, embed: 4 }),
    });
  } catch { /* background maintenance */ }
}

async function seenUrls(): Promise<string[]> {
  const { data } = await supabase
    .from("seen_suggestions")
    .select("url, verdict")
    .in("verdict", ["disliked", "saved"])
    .limit(500);
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
