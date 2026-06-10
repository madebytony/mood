import { supabase, authToken } from "./supabase";
import { processImage, uploadProcessed } from "./media";
import type { Item, Library, LinkMeta, Space, Stack } from "./types";

// ---------- reads ----------

export async function fetchLibraries(): Promise<Library[]> {
  const { data, error } = await supabase.from("libraries").select("*").order("sort").order("created_at");
  if (error) throw error;
  return data ?? [];
}

export async function fetchSpaces(): Promise<Space[]> {
  const { data, error } = await supabase.from("spaces").select("*").order("sort").order("created_at");
  if (error) throw error;
  return data ?? [];
}

export async function fetchItems(spaceId: string | "all", search: string): Promise<Item[]> {
  let q = supabase
    .from("items")
    .select("*")
    .is("stack_id", null)
    .order("created_at", { ascending: false })
    .limit(500);
  if (spaceId !== "all") q = q.eq("space_id", spaceId);
  const s = search.trim().replace(/[,{}()]/g, " ").trim();
  if (s) {
    q = q.or(
      [
        `title.ilike.%${s}%`,
        `ai_caption.ilike.%${s}%`,
        `content.ilike.%${s}%`,
        `source_domain.ilike.%${s}%`,
        `tags.cs.{${s.toLowerCase()}}`,
      ].join(",")
    );
  }
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

/** Top tags across the most recent saves — the taste profile. */
export async function tasteTags(): Promise<string[]> {
  const { data } = await supabase
    .from("items")
    .select("tags")
    .order("created_at", { ascending: false })
    .limit(200);
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
    .select("*")
    .order("last_viewed_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(limit * 3);
  const pool = data ?? [];
  // light shuffle so it isn't identical every load
  return pool.sort(() => Math.random() - 0.5).slice(0, limit);
}

// ---------- signed URL cache ----------

const urlCache = new Map<string, { url: string; expires: number }>();

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
    })
    .select()
    .single();
  if (error) throw error;
  return data;
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
    .select()
    .single();
  if (error) throw error;
  return data;
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
  return addImageFile(blob, spaceId, { type: "site", source_url: url, title: domain });
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
      title: text.split("\n")[0].slice(0, 80),
      tags: [],
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateItem(id: string, patch: Partial<Item>): Promise<Item> {
  const { data, error } = await supabase.from("items").update(patch).eq("id", id).select().single();
  if (error) throw error;
  return data;
}

/** Undo-able delete, step 1: remove the row immediately (survives refresh/app close). */
export async function deleteItemRow(item: Item): Promise<void> {
  const { error } = await supabase.from("items").delete().eq("id", item.id);
  if (error) throw error;
}

/** Undo: re-insert the row exactly as it was (files weren't touched yet). */
export async function restoreItem(item: Item): Promise<void> {
  const { error } = await supabase.from("items").insert(item);
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
  return data;
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
    .select("*")
    .eq("stack_id", stackId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
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

/** Dissolve: items return to the space, stack row removed. */
export async function deleteStack(id: string): Promise<void> {
  await supabase.from("items").update({ stack_id: null }).eq("stack_id", id);
  const { error } = await supabase.from("stacks").delete().eq("id", id);
  if (error) throw error;
}

export async function setSpaceView(id: string, view: "grid" | "board"): Promise<void> {
  const { error } = await supabase.from("spaces").update({ view }).eq("id", id);
  if (error) throw error;
}

// ---------- AI ----------

let aiAvailable: boolean | null = null;

/** Caption + auto-tag an item in the background. Silently no-ops without an API key. */
export async function captionItem(item: Item, onDone?: (updated: Item) => void): Promise<void> {
  if (aiAvailable === false || !item.thumb_path) return;
  try {
    const urls = await signedUrls([item.thumb_path]);
    const res = await apiFetch("/api/ai/caption", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imageUrl: urls.get(item.thumb_path), title: item.title }),
    });
    if (res.status === 503) {
      aiAvailable = false;
      return;
    }
    if (!res.ok) return;
    aiAvailable = true;
    const { caption, tags } = await res.json();
    const merged = [...new Set([...(item.tags ?? []), ...(tags ?? [])])];
    const updated = await updateItem(item.id, { ai_caption: caption, tags: merged });
    onDone?.(updated);
  } catch {
    /* background job — never surface errors */
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
        caption: i.ai_caption,
        domain: i.source_domain,
      })),
    }),
  });
  if (!res.ok) return null;
  const { ids } = await res.json();
  return ids;
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

export async function discover(query: string | null, extraExclude: string[] = []): Promise<Suggestion[]> {
  const [taste, domains, seen] = await Promise.all([tasteTags(), libraryDomains(), seenUrls()]);
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (taste.length) params.set("taste", taste.join(","));
  const exclude = [...extraExclude, ...domains, ...seen].slice(0, 400);
  if (exclude.length) params.set("exclude", exclude.join(","));
  const res = await apiFetch(`/api/discover?${params}`);
  if (!res.ok) throw new Error("Discover failed");
  const { items } = await res.json();
  return items ?? [];
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
