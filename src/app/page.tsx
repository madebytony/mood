"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AuthGate from "@/components/AuthGate";
import Sidebar from "@/components/Sidebar";
import Masonry from "@/components/Masonry";
import Board from "@/components/Board";
import Feed from "@/components/Feed";
import Detail from "@/components/Detail";
import AddMenu from "@/components/AddMenu";
import { DialogHost, SkeletonGrid, ask, confirmDialog } from "@/components/ui";
import { useDialog } from "@/components/useDialog";
import {
  addFromUrl,
  addImageFile,
  addNote,
  addTodo,
  aiSearch,
  backfillCaptions,
  backfillEmbeddings,
  backfillThumbs,
  boardBrief,
  captionItem,
  captureSite,
  corpusTick,
  checkLink,
  addNoteToColumn,
  createColumn,
  createStack,
  deleteItemRow,
  deleteItemStorage,
  restoreItem,
  deleteStack,
  embedItem,
  fetchColumnItems,
  fetchItems,
  ITEMS_PAGE,
  fetchLibraries,
  fetchSpaces,
  fetchSpaceCounts,
  fetchStackItems,
  fetchStacks,
  renameStack,
  reorderColumnItems,
  semanticSearch,
  setLibraryMode as setLibraryModeDb,
  setSpaceView,
  signedUrls,
  stackThumbPaths,
  tasteTags,
  unstackItem,
  updateItem,
  updateStack,
  getOrCreateBookmarks,
} from "@/lib/db";
import { COLOR_NAMES, COLOR_HEX } from "@/lib/media";
import type { Item, Library, LibraryMode, Space, Stack } from "@/lib/types";
import { SparklesIcon, HomeIcon, GridIcon, BoardIcon, MenuIcon, PlusIcon, GlobeIcon, StackIcon, UnstackIcon, TrashIcon } from "@/components/icons";

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Link";
  }
}

const TYPE_MODE_RE = /\b(type|typography|font|foundry)\b/i;

function splitFontToken(token: string): { name: string; provider: string | null } {
  const i = token.lastIndexOf("@");
  if (i <= 0) return { name: token.trim(), provider: null };
  return { name: token.slice(0, i).trim(), provider: token.slice(i + 1).trim().toLowerCase() || null };
}

function fontGuessConfidence(token: string): number {
  const { provider } = splitFontToken(token);
  if (provider === "ai") return 0.58;
  if (provider) return 0.93;
  return 0.72;
}

function isTypeModeLabel(v: string | null | undefined): boolean {
  return !!v && TYPE_MODE_RE.test(v);
}

interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
  action?: { label: string; fn: () => void };
}

function App() {
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  // A freshly-created note id the Board should open straight into inline edit mode.
  const [autoEditId, setAutoEditId] = useState<string | null>(null);
  const [spaceCounts, setSpaceCounts] = useState<Map<string, number>>(new Map());
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [selected, setSelected] = useState<string | "all" | "home">(() => {
    if (typeof window === "undefined") return "home";
    const p = new URLSearchParams(window.location.search);
    const s = p.get("s");
    if (s) return s;
    const h = decodeURIComponent(window.location.hash.slice(1));
    if (h === "all" || h === "home") return h;
    if (h.startsWith("s/")) return h.slice(2);
    return "home";
  });
  const [search, setSearch] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("q") ?? "";
  });
  const [colorFilter, setColorFilter] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("c") ?? null;
  });
  const [typeTab, setTypeTab] = useState<"foundries" | "fonts" | "inuse">("foundries");
  const [open, setOpen] = useState<Item | null>(null);
  const [filing, setFiling] = useState<Item | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [similarQuery, setSimilarQuery] = useState<string | null>(null);
  // Reference image URL for multimodal "more like this" (null = text-only).
  const [similarImage, setSimilarImage] = useState<string | null>(null);
  const [similarItemId, setSimilarItemId] = useState<string | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);
  const [enrichBusy, setEnrichBusy] = useState(false);
  const [stacks, setStacks] = useState<Stack[]>([]);
  const [stackThumbs, setStackThumbs] = useState<Map<string, string[]>>(new Map());
  const [columnItems, setColumnItems] = useState<Map<string, Item[]>>(new Map());
  const [selIds, setSelIds] = useState<Set<string>>(new Set());
  const [confirmDel, setConfirmDel] = useState(false); // bulk-delete arms on first click
  const [aiItems, setAiItems] = useState<Item[] | null>(null); // AI search results overlay
  const [stackView, setStackView] = useState<{ stack: Stack; items: Item[] } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [ready, setReady] = useState(false);
  // Grid pagination (Fix: was a hard 500-item cap that silently hid older saves).
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<Item[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<{ id: number; label: string }[]>([]);
  const [addTick, setAddTick] = useState(0);
  const [fontReviewOpen, setFontReviewOpen] = useState(false);
  const [reviewBusy, setReviewBusy] = useState<string | null>(null);
  const toastId = useRef(0);
  const pendingId = useRef(0);
  const dragDepth = useRef(0);
  const embedSweepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Coalesce post-add embedding sweeps into a single trailing timer — dropping 30 files at once
   *  should schedule one sweep, not 30 — and clear it on unmount so it can't setState after logout. */
  const scheduleEmbedSweep = useCallback(() => {
    if (embedSweepTimer.current) clearTimeout(embedSweepTimer.current);
    embedSweepTimer.current = setTimeout(() => {
      embedSweepTimer.current = null;
      backfillEmbeddings();
    }, 12000);
  }, []);
  useEffect(() => () => {
    if (embedSweepTimer.current) clearTimeout(embedSweepTimer.current);
  }, []);

  /** Optimistic ghost card: shows instantly in the grid, vanishes when the real item lands. */
  const trackPending = useCallback((label: string) => {
    const id = ++pendingId.current;
    setPending((p) => [...p, { id, label }]);
    return () => setPending((p) => p.filter((x) => x.id !== id));
  }, []);

  // ---------- URL state: refresh / share restores the view ----------
  // selected / search / colorFilter are initialised from URL params via lazy useState
  // initialisers (above), so they're correct before the first render — no effect needed.
  // The write-back effect lives lower, after `showBoard` is known (so it can mirror
  // grid/board into ?v).

  const toast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  const loadStructure = useCallback(async () => {
    const [libs, sps] = await Promise.all([fetchLibraries(), fetchSpaces()]);
    setLibraries(libs);
    setSpaces(sps);
  }, []);

  // Sequence counter: incremented on every loadItems call so a slow "all items" fetch that
  // started when selected="home" can't overwrite the result of a later fetch for a specific space.
  const loadSeq = useRef(0);

  /** Stale-while-revalidate: cached views paint instantly, fresh data swaps in behind. */
  const viewCache = useRef(
    new Map<string, { items: Item[]; stacks: Stack[]; urls: Map<string, string>; stackThumbs: Map<string, string[]>; hasMore: boolean }>()
  );

  // Mirror items into a ref so loadMore can read the current tail (cursor) without
  // re-subscribing the IntersectionObserver on every append.
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  /** Drop every cached view snapshot. Call before a mutation so switching to another space can't
   *  paint a stale snapshot that still holds a deleted/moved item or expired signed URLs — the
   *  following loadItems() repopulates the current key from the network. */
  const invalidateViewCache = useCallback(() => viewCache.current.clear(), []);

  // Accessible-dialog plumbing (focus trap + Escape + focus restore) for the inline overlays.
  const filingRef = useDialog<HTMLDivElement>(() => setFiling(null), { active: !!filing });
  const similarRef = useDialog<HTMLDivElement>(() => setSimilarQuery(null), { active: !!similarQuery });
  const stackRef = useDialog<HTMLDivElement>(() => setStackView(null), { active: !!stackView });
  const reviewRef = useDialog<HTMLDivElement>(() => setFontReviewOpen(false), { active: !!fontReviewOpen });

  const loadItems = useCallback(async () => {
    const seq = ++loadSeq.current;
    const spaceKey = selected === "home" ? "all" : selected;
    const cacheKey = `${spaceKey}|${search}`;
    const cached = viewCache.current.get(cacheKey);
    if (cached) {
      setItems(cached.items);
      setStacks(cached.stacks);
      setUrls(cached.urls);
      setStackThumbs(cached.stackThumbs);
      setHasMore(cached.hasMore);
      setReady(true);
    }
    // Browse paginates (keyset, ITEMS_PAGE at a time); search stays single-shot at a higher ceiling.
    // On revalidation, refetch the full depth already loaded so a background refresh can't shrink a
    // deeply-scrolled view back to the first page.
    const paginated = !search.trim();
    const browseLimit = Math.max(ITEMS_PAGE, cached?.items.length ?? 0);
    const [data, stks] = await Promise.all([
      fetchItems(spaceKey, search, paginated ? { limit: browseLimit } : { limit: 1000 }),
      fetchStacks(spaceKey),
    ]);
    const more = paginated && data.length === browseLimit;
    const colStackIds = stks.filter((s) => s.kind === "column").map((s) => s.id);
    const [fan, colMap] = await Promise.all([
      stackThumbPaths(stks.map((s) => s.id)),
      colStackIds.length ? fetchColumnItems(colStackIds) : Promise.resolve(new Map<string, Item[]>()),
    ]);
    const colThumbPaths = [...colMap.values()].flat().map((i) => i.thumb_path).filter(Boolean) as string[];
    const paths = [
      ...(data.map((i) => i.thumb_path).filter(Boolean) as string[]),
      // Full-res for image/site cards so larger board cards stay crisp (bytes load only when rendered).
      ...(data.filter((i) => i.type === "image" || i.type === "site").map((i) => i.storage_path).filter(Boolean) as string[]),
      ...[...fan.values()].flat(),
      ...colThumbPaths,
    ];
    const map = paths.length ? await signedUrls(paths) : new Map<string, string>();
    const fanUrls = new Map<string, string[]>();
    for (const [sid, ps] of fan) fanUrls.set(sid, ps.map((p) => map.get(p)).filter(Boolean) as string[]);
    // Discard if a newer loadItems call has already started (e.g. selected changed mid-flight).
    if (seq !== loadSeq.current) return;
    viewCache.current.set(cacheKey, { items: data, stacks: stks, urls: map, stackThumbs: fanUrls, hasMore: more });
    setItems(data);
    setStacks(stks);
    setUrls(map);
    setStackThumbs(fanUrls);
    setColumnItems(colMap);
    setHasMore(more);
    setReady(true);
    // sidebar tallies are library-wide (not just this view) — refresh in the background
    fetchSpaceCounts().then(setSpaceCounts).catch(() => {});
  }, [selected, search]);

  /** Fetch the next keyset page (browse only) and append. Reads the current tail from a ref
   *  so the IntersectionObserver doesn't need to re-bind on every append. */
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || search.trim()) return;
    const tail = itemsRef.current[itemsRef.current.length - 1];
    if (!tail) return;
    const spaceKey = selected === "home" ? "all" : selected;
    setLoadingMore(true);
    try {
      const next = await fetchItems(spaceKey, "", { before: tail.created_at, beforeId: tail.id, limit: ITEMS_PAGE });
      const have = new Set(itemsRef.current.map((i) => i.id));
      const fresh = next.filter((i) => !have.has(i.id));
      const paths = [
        ...(fresh.map((i) => i.thumb_path).filter(Boolean) as string[]),
        ...(fresh.filter((i) => i.type === "image" || i.type === "site").map((i) => i.storage_path).filter(Boolean) as string[]),
      ];
      const m = paths.length ? await signedUrls(paths) : new Map<string, string>();
      const merged = [...itemsRef.current, ...fresh];
      const more = next.length === ITEMS_PAGE;
      // keep the SWR cache in sync so leaving and returning to this view preserves loaded pages
      const cached = viewCache.current.get(`${spaceKey}|`);
      if (cached) viewCache.current.set(`${spaceKey}|`, { ...cached, items: merged, urls: new Map([...cached.urls, ...m]), hasMore: more });
      setUrls((u) => new Map([...u, ...m]));
      setItems(merged);
      setHasMore(more);
    } catch (e) {
      toast(String((e as Error).message ?? e), "error");
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, search, selected, toast]);

  // Infinite scroll: trigger the next page when the sentinel nears the bottom of the grid.
  // Re-binds when the grid (re)mounts or loadMore changes; no-op while the sentinel is absent
  // (home/board views don't render it).
  useEffect(() => {
    const el = sentinelRef.current;
    const root = scrollRef.current;
    if (!el || !root || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) loadMore(); },
      { root, rootMargin: "800px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, hasMore, ready, selected, search]);

  useEffect(() => {
    loadStructure().catch((e) => toast(String(e.message ?? e), "error"));
  }, [loadStructure, toast]);

  // Auto-create the Bookmarks space on first load if it doesn't exist yet
  const bmCreated = useRef(false);
  useEffect(() => {
    if (bmCreated.current || !libraries.length || !spaces.length) return;
    if (spaces.some((s) => s.kind === "bookmarks")) { bmCreated.current = true; return; }
    bmCreated.current = true;
    getOrCreateBookmarks(spaces, libraries).then(() => loadStructure()).catch(() => {});
  }, [spaces, libraries, loadStructure]);

  useEffect(() => {
    const t = setTimeout(
      () => loadItems().catch((e) => toast(String(e.message ?? e), "error")),
      search ? 250 : 0
    );
    return () => clearTimeout(t);
  }, [loadItems, search, toast]);

  useEffect(() => {
    setSelIds(new Set()); // clear selection + AI results when the view changes
    setAiItems(null);
  }, [search, selected]);

  useEffect(() => setConfirmDel(false), [selIds]); // re-arm delete whenever the selection changes

  useEffect(() => {
    // skeletons only for views we've never seen this session
    const spaceKey = selected === "home" ? "all" : selected;
    if (!viewCache.current.has(`${spaceKey}|${search}`)) setReady(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const inbox = useMemo(() => spaces.find((s) => s.kind === "inbox"), [spaces]);
  const bookmarks = useMemo(() => spaces.find((s) => s.kind === "bookmarks"), [spaces]);
  const currentSpace = useMemo(
    () => (selected !== "all" && selected !== "home" ? spaces.find((s) => s.id === selected) : undefined),
    [spaces, selected]
  );
  const targetSpace = currentSpace?.id ?? inbox?.id;

  /** Bookmark a URL: auto-creates the Bookmarks space on first use, then saves the URL there. */
  const handleBookmark = useCallback(async (url: string) => {
    const bmId = bookmarks?.id ?? await getOrCreateBookmarks(spaces, libraries);
    await addFromUrl(url, bmId);
    invalidateViewCache();
    loadStructure();
  }, [bookmarks, spaces, libraries, invalidateViewCache, loadStructure]);

  const effectiveLibraryModes = useMemo<Record<string, LibraryMode>>(() => {
    const out: Record<string, LibraryMode> = {};
    for (const lib of libraries) {
      out[lib.id] = lib.mode === "type" ? "type" : (isTypeModeLabel(lib.name) ? "type" : "default");
    }
    return out;
  }, [libraries]);
  const spacesById = useMemo(() => new Map(spaces.map((s) => [s.id, s])), [spaces]);

  const setLibraryMode = useCallback(async (libraryId: string, mode: LibraryMode) => {
    const prev = effectiveLibraryModes[libraryId] ?? "default";
    if (prev === mode) return;

    setLibraries((libs) => libs.map((l) => (l.id === libraryId ? { ...l, mode } : l)));
    try {
      await setLibraryModeDb(libraryId, mode);
    } catch (e) {
      setLibraries((libs) => libs.map((l) => (l.id === libraryId ? { ...l, mode: prev } : l)));
      toast(`Library mode update failed: ${(e as Error).message}`, "error");
    }
  }, [effectiveLibraryModes, toast]);

  const spaceCaptionKind = useCallback(
    (spaceId: string | null | undefined): "type" | undefined => {
      if (!spaceId) return undefined;
      const sp = spacesById.get(spaceId);
      if (!sp) return undefined;
      if ((effectiveLibraryModes[sp.library_id] ?? "default") === "type") return "type";
      return isTypeModeLabel(sp.name) ? "type" : undefined;
    },
    [spacesById, effectiveLibraryModes]
  );
  const currentFeedMode = useMemo(() => spaceCaptionKind(currentSpace?.id), [spaceCaptionKind, currentSpace?.id]);

  useEffect(() => {
    setTypeTab("foundries");
  }, [selected, currentFeedMode]);

  const baseItems = aiItems ?? items;
  const visibleItems = useMemo(
    () => (colorFilter ? baseItems.filter((i) => i.colors?.includes(colorFilter)) : baseItems),
    [baseItems, colorFilter]
  );

  const typedVisibleItems = useMemo(() => {
    if (currentFeedMode !== "type") return visibleItems;
    return visibleItems.filter((i) => {
      if (typeTab === "foundries") return (i.type === "site" || i.type === "link") && !!i.source_domain;
      if (typeTab === "fonts") return (i.fonts?.length ?? 0) > 0;
      return i.type === "image" || i.type === "site";
    });
  }, [visibleItems, currentFeedMode, typeTab]);

  const counts = useMemo(() => {
    const m = new Map(spaceCounts);
    let total = 0;
    for (const n of spaceCounts.values()) total += n;
    m.set("all", total);
    return m;
  }, [spaceCounts]);

  const patchItemEverywhere = useCallback((updated: Item) => {
    setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    setAiItems((prev) => (prev ? prev.map((i) => (i.id === updated.id ? updated : i)) : prev));
    setOpen((prev) => (prev?.id === updated.id ? updated : prev));
  }, []);

  const typeScopeItems = useMemo(() => {
    if (selected === "home") return [] as Item[];
    const scoped = selected === "all" ? items : items.filter((i) => i.space_id === selected);
    return scoped.filter((i) => spaceCaptionKind(i.space_id) === "type");
  }, [items, selected, spaceCaptionKind]);

  const fontReviewQueue = useMemo(() => {
    return typeScopeItems
      .map((item) => ({
        item,
        pending: (item.fonts ?? []).filter((f) => splitFontToken(f).provider === "ai"),
      }))
      .filter((x) => x.pending.length)
      .sort((a, b) => b.item.created_at.localeCompare(a.item.created_at));
  }, [typeScopeItems]);

  const reviewCount = useMemo(
    () => fontReviewQueue.reduce((n, x) => n + x.pending.length, 0),
    [fontReviewQueue]
  );

  const reviewFontGuess = useCallback(
    async (item: Item, token: string, action: "approve" | "reject") => {
      const busyKey = `${item.id}:${token}:${action}`;
      setReviewBusy(busyKey);
      try {
        const nextByBase = new Map<string, string>();
        for (const raw of item.fonts ?? []) {
          if (raw === token && action === "reject") continue;
          const normalized = raw === token && action === "approve" ? splitFontToken(raw).name : raw;
          const base = splitFontToken(normalized).name.toLowerCase();
          if (!base) continue;
          const prev = nextByBase.get(base);
          if (!prev || splitFontToken(prev).provider === "ai") nextByBase.set(base, normalized);
        }
        const updated = await updateItem(item.id, { fonts: [...nextByBase.values()] });
        patchItemEverywhere(updated);
      } catch (e) {
        toast(`Font review failed: ${(e as Error).message}`, "error");
      } finally {
        setReviewBusy(null);
      }
    },
    [patchItemEverywhere, toast]
  );

  // ---------- capture handlers ----------

  /** Paint a freshly-saved item into the current view immediately, signing its thumb —
   *  so adds feel instant without a full reload per file. */
  const insertItem = useCallback(async (item: Item) => {
    if (item.thumb_path) {
      const m = await signedUrls([item.thumb_path]);
      setUrls((u) => new Map([...u, ...m]));
    }
    setItems((prev) => (prev.some((i) => i.id === item.id) ? prev : [item, ...prev]));
  }, []);

  const afterAdd = useCallback((item: Item) => {
    invalidateViewCache(); // the new item belongs in other cached views too
    // caption first so the embedding carries the style description
    captionItem(item, (updated) => {
      embedItem(updated);
      // patch the caption/tags into the current view in place — no full reload
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    }, spaceCaptionKind(item.space_id));
    // background reachability check for links/sites — flags dead_link without blocking the save
    if (item.source_url) {
      checkLink(item).then((updated) => {
        if (updated) setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
      });
    }
    // sweep catches items captioning never reaches (no key, notes, failures)
    scheduleEmbedSweep();
  }, [invalidateViewCache, scheduleEmbedSweep, spaceCaptionKind]);

  // Self-heal items on load: caption uncaptioned images (richer "more like this" + embeddings),
  // then backfill proper thumbnails + colours for clip-route saves (full-image thumbs, no colours),
  // then sweep any item still missing a vector. Patch each result into the grid so it's used now.
  useEffect(() => {
    if (!spaces.length || !libraries.length) return;
    let alive = true; // these sweeps resolve seconds later — don't setState after unmount/logout
    const patch = (updated: Item) => {
      if (!alive) return;
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    };
    // re-thumb changes thumb_path → sign the new thumb or the card would briefly go blank
    const patchThumb = (updated: Item) => {
      if (!alive) return;
      patch(updated);
      if (updated.thumb_path)
        signedUrls([updated.thumb_path])
          .then((m) => alive && setUrls((u) => new Map([...u, ...m])))
          .catch(() => {});
    };
    backfillCaptions(patch, 8, (item) => spaceCaptionKind(item.space_id))
      .finally(() => backfillThumbs(patchThumb))
      .finally(() => backfillEmbeddings())
      .finally(() => corpusTick());
    return () => {
      alive = false;
    };
  }, [libraries.length, spaceCaptionKind, spaces.length]);

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (!targetSpace) return toast("No space to save into yet", "error");
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (!images.length) return;
      let added = 0;
      for (const f of images) {
        const done = trackPending(f.name || "Image");
        try {
          const item = await addImageFile(f, targetSpace);
          insertItem(item).catch(() => {}); // optimistic paint
          afterAdd(item);
          added++;
        } catch (e) {
          toast(`Failed: ${(e as Error).message}`, "error");
        } finally {
          done();
        }
      }
      if (added) loadItems().catch(() => {}); // single reconciling refresh for the whole batch
    },
    [targetSpace, toast, loadItems, afterAdd, insertItem, trackPending]
  );

  const handleUrl = useCallback(
    async (url: string) => {
      if (!targetSpace) return toast("No space to save into yet", "error");
      if (!/^https?:\/\//i.test(url)) return toast("That doesn't look like a URL", "error");
      const done = trackPending(safeHost(url));
      try {
        const item = await addFromUrl(url, targetSpace);
        insertItem(item).catch(() => {}); // optimistic paint
        afterAdd(item);
        loadItems().catch(() => {}); // one reconciling refresh
      } catch (e) {
        toast(`Import failed: ${(e as Error).message}`, "error");
      } finally {
        done();
      }
    },
    [targetSpace, toast, loadItems, afterAdd, insertItem, trackPending]
  );

  const handleCapture = useCallback(
    async (url: string) => {
      if (!targetSpace) return toast("No space to save into yet", "error");
      if (!/^https?:\/\//i.test(url)) return toast("That doesn't look like a URL", "error");
      const done = trackPending(`${safeHost(url)} — capturing…`);
      try {
        const item = await captureSite(url, targetSpace);
        insertItem(item).catch(() => {}); // optimistic paint
        afterAdd(item);
        loadItems().catch(() => {}); // one reconciling refresh
      } catch (e) {
        toast(`Capture failed: ${(e as Error).message}`, "error");
      } finally {
        done();
      }
    },
    [targetSpace, toast, loadItems, afterAdd, insertItem, trackPending]
  );

  const handleNote = useCallback(
    async (text: string) => {
      if (!targetSpace) return toast("No space to save into yet", "error");
      try {
        const item = await addNote(text, targetSpace);
        invalidateViewCache();
        insertItem(item).catch(() => {}); // optimistic paint
        // On the board, open the new note straight into inline rich-text editing.
        if (currentSpace?.view === "board") setAutoEditId(item.id);
        loadItems().catch(() => {}); // one reconciling refresh
      } catch (e) {
        toast(`Note failed: ${(e as Error).message}`, "error");
      }
    },
    [targetSpace, loadItems, insertItem, toast, invalidateViewCache, currentSpace]
  );

  const handleColumn = useCallback(
    async (name: string) => {
      if (!targetSpace) return toast("No space to save into yet", "error");
      try {
        await createColumn(targetSpace, name);
        invalidateViewCache();
        loadItems().catch(() => {});
      } catch (e) {
        toast(`Column failed: ${(e as Error).message}`, "error");
      }
    },
    [targetSpace, toast, loadItems, invalidateViewCache]
  );

  const handleTodo = useCallback(
    async (title: string) => {
      if (!targetSpace) return toast("No space to save into yet", "error");
      try {
        const item = await addTodo(title, targetSpace);
        invalidateViewCache();
        insertItem(item).catch(() => {});
        loadItems().catch(() => {});
      } catch (e) {
        toast(`To-do list failed: ${(e as Error).message}`, "error");
      }
    },
    [targetSpace, toast, loadItems, insertItem, invalidateViewCache]
  );

  /** Instant delete with a 5s Undo window. The row is deleted immediately (so a refresh
   *  can't resurrect it); Undo re-inserts it. Files are cleared after the window closes. */
  async function softDelete(item: Item) {
    invalidateViewCache();
    setItems((prev) => prev.filter((i) => i.id !== item.id));
    setAiItems((prev) => (prev ? prev.filter((i) => i.id !== item.id) : prev));
    try {
      await deleteItemRow(item);
    } catch (e) {
      toast(`Delete failed: ${(e as Error).message}`, "error");
      loadItems();
      return;
    }
    const id = ++toastId.current;
    let undone = false;
    // One timer owns both dismissing the toast and purging storage, so there's no ordering race
    // between two 5.2s timeouts that could delete the blob out from under a just-restored row.
    const timer = setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
      if (!undone) deleteItemStorage(item).catch(() => {});
    }, 5200);
    setToasts((t) => [
      ...t,
      {
        id,
        text: "Deleted",
        kind: "info",
        action: {
          label: "Undo",
          fn: async () => {
            undone = true; // set synchronously before any await so the timer can never purge
            clearTimeout(timer);
            setToasts((ts) => ts.filter((x) => x.id !== id));
            try {
              await restoreItem(item);
            } catch (e) {
              toast(`Undo failed: ${(e as Error).message}`, "error");
            }
            invalidateViewCache();
            loadItems();
          },
        },
      },
    ]);
  }

  /** Bulk soft-delete the current selection with one combined Undo (mirrors softDelete). */
  async function bulkDelete() {
    const victims = baseItems.filter((i) => selIds.has(i.id));
    if (!victims.length) return;
    const ids = new Set(victims.map((v) => v.id));
    setSelIds(new Set());
    setConfirmDel(false);
    invalidateViewCache();
    setItems((prev) => prev.filter((i) => !ids.has(i.id)));
    setAiItems((prev) => (prev ? prev.filter((i) => !ids.has(i.id)) : prev));
    try {
      await Promise.all(victims.map((v) => deleteItemRow(v)));
    } catch (e) {
      toast(`Delete failed: ${(e as Error).message}`, "error");
      loadItems();
      return;
    }
    const id = ++toastId.current;
    let undone = false;
    // Single timer dismisses the toast and purges storage together (see softDelete).
    const timer = setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
      if (!undone) victims.forEach((v) => deleteItemStorage(v).catch(() => {}));
    }, 5200);
    setToasts((t) => [
      ...t,
      {
        id,
        text: `${victims.length} deleted`,
        kind: "info",
        action: {
          label: "Undo",
          fn: async () => {
            undone = true; // synchronous, before any await
            clearTimeout(timer);
            setToasts((ts) => ts.filter((x) => x.id !== id));
            try {
              await Promise.all(victims.map((v) => restoreItem(v)));
            } catch (e) {
              toast(`Undo failed: ${(e as Error).message}`, "error");
            }
            invalidateViewCache();
            loadItems();
          },
        },
      },
    ]);
  }

  function toggleSelect(id: string) {
    setSelIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function makeStack() {
    if (selIds.size < 2) return toast("Select at least 2 items", "error");
    const name = await ask({ title: "Name this stack", initial: "New stack", confirmLabel: "Create" });
    if (!name) return;
    const first = items.find((i) => selIds.has(i.id));
    const spaceId = currentSpace?.id ?? first?.space_id ?? inbox?.id;
    if (!spaceId) return;
    await createStack(spaceId, name, [...selIds]);
    setSelIds(new Set());
    toast(`Stacked ✓ — ${name}`);
    invalidateViewCache();
    loadItems();
  }

  async function openStack(s: Stack) {
    const its = await fetchStackItems(s.id);
    const paths = its.map((i) => i.thumb_path).filter(Boolean) as string[];
    if (paths.length) {
      const m = await signedUrls(paths);
      setUrls((u) => new Map([...u, ...m]));
    }
    setStackView({ stack: s, items: its });
  }

  async function unstackOne(item: Item) {
    await unstackItem(item.id);
    if (stackView) {
      const left = stackView.items.filter((i) => i.id !== item.id);
      if (left.length === 0) {
        await deleteStack(stackView.stack.id).catch(() => {});
        setStackView(null);
      } else {
        setStackView({ ...stackView, items: left });
      }
    }
    invalidateViewCache();
    loadItems();
  }

  async function dissolveStack() {
    if (!stackView) return;
    const ok = await confirmDialog({
      title: `Unstack “${stackView.stack.name}”?`,
      body: "The items return to their space.",
      danger: true,
      confirmLabel: "Unstack",
    });
    if (!ok) return;
    await deleteStack(stackView.stack.id);
    setStackView(null);
    invalidateViewCache();
    loadItems();
  }

  async function runAiSearch() {
    if (!search.trim()) return;
    setAiBusy(true);
    try {
      const q = search.trim();
      let ranked: Item[] | null = null;
      // instant visual-semantic search over embeddings first
      const sem = await semanticSearch(q);
      if (sem?.length) {
        const top = sem[0].similarity ?? 0;
        ranked = sem.filter((i, idx) => !i.stack_id && (idx < 12 || (i.similarity ?? 0) >= top * 0.9));
      }
      if (!ranked) {
        // fallback: Claude reads titles/tags/captions
        const all = await fetchItems("all", "");
        const ids = await aiSearch(q, all);
        if (ids === null) {
          toast("AI search needs VOYAGE_API_KEY or ANTHROPIC_API_KEY in .env.local", "error");
          return;
        }
        const byId = new Map(all.map((i) => [i.id, i]));
        ranked = ids.map((id) => byId.get(id)).filter(Boolean) as Item[];
      }
      setAiItems(ranked);
      const paths = ranked.map((i) => i.thumb_path).filter(Boolean) as string[];
      if (paths.length) {
        const m = await signedUrls(paths);
        setUrls((u) => new Map([...u, ...m]));
      }
      toast(`${ranked.length} matches across your library`);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setAiBusy(false);
    }
  }

  // Global paste
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]")) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length) {
        e.preventDefault();
        handleFiles(files);
        return;
      }
      const text = e.clipboardData?.getData("text/plain")?.trim();
      if (text && /^https?:\/\//i.test(text)) {
        e.preventDefault();
        handleUrl(text);
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handleFiles, handleUrl]);

  // Global drag & drop
  useEffect(() => {
    function onDragEnter(e: DragEvent) {
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    }
    function onDragLeave(e: DragEvent) {
      e.preventDefault();
      if (--dragDepth.current <= 0) {
        dragDepth.current = 0;
        setDragging(false);
      }
    }
    function onDragOver(e: DragEvent) {
      e.preventDefault();
    }
    function onDrop(e: DragEvent) {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) {
        handleFiles(files);
        return;
      }
      const url = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain");
      if (url && /^https?:\/\//i.test(url.trim())) handleUrl(url.trim());
    }
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [handleFiles, handleUrl]);

  /** Called by Board after optimistic updates so page state stays in sync. */
  function handleItemUpdate(id: string, patch: Partial<Item>) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
    // Also patch inside any open column
    setColumnItems((prev) => {
      const next = new Map(prev);
      for (const [sid, arr] of next) {
        if (arr.some((i) => i.id === id)) next.set(sid, arr.map((i) => (i.id === id ? { ...i, ...patch } : i)));
      }
      return next;
    });
  }

  function handleStackUpdate(id: string, patch: Partial<Stack>) {
    setStacks((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  /** Optimistically move an item from the board into a column, then persist. */
  async function handleDropToColumn(item: Item, columnStackId: string) {
    // Remove from board items immediately
    setItems((prev) => prev.filter((i) => i.id !== item.id));
    // Add to column items immediately
    setColumnItems((prev) => {
      const next = new Map(prev);
      const arr = next.get(columnStackId) ?? [];
      if (!arr.some((i) => i.id === item.id)) next.set(columnStackId, [...arr, { ...item, stack_id: columnStackId }]);
      return next;
    });
    invalidateViewCache();
    try {
      await updateItem(item.id, { stack_id: columnStackId });
    } catch {
      // Revert on failure
      setItems((prev) => [item, ...prev]);
      setColumnItems((prev) => {
        const next = new Map(prev);
        const arr = next.get(columnStackId) ?? [];
        next.set(columnStackId, arr.filter((i) => i.id !== item.id));
        return next;
      });
    }
    // Refresh to get proper stack_order etc.
    loadItems().catch(() => {});
  }

  /** Optimistically move an item back to the board from a column. */
  async function handleRemoveFromColumn(item: Item) {
    const colId = item.stack_id;
    // Remove from column immediately
    setColumnItems((prev) => {
      const next = new Map(prev);
      if (colId) next.set(colId, (next.get(colId) ?? []).filter((i) => i.id !== item.id));
      return next;
    });
    // Add back to board immediately (stack_id cleared)
    const restored = { ...item, stack_id: null };
    setItems((prev) => [restored, ...prev]);
    invalidateViewCache();
    try {
      await updateItem(item.id, { stack_id: null });
    } catch {
      // Revert on failure
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setColumnItems((prev) => {
        const next = new Map(prev);
        if (colId) next.set(colId, [...(next.get(colId) ?? []), item]);
        return next;
      });
    }
    loadItems().catch(() => {});
  }

  /** Quick-add a note card to a column (the + at its foot), optimistic then persisted. */
  async function handleAddNoteToColumn(columnStackId: string, text: string) {
    const stack = stacks.find((s) => s.id === columnStackId);
    const spaceId = stack?.space_id ?? targetSpace;
    if (!spaceId) return;
    try {
      const item = await addNoteToColumn(columnStackId, spaceId, text);
      setColumnItems((prev) => {
        const next = new Map(prev);
        next.set(columnStackId, [...(next.get(columnStackId) ?? []), item]);
        return next;
      });
      invalidateViewCache();
    } catch (e) {
      toast(`Add failed: ${(e as Error).message}`, "error");
    }
  }

  /** Optimistically reorder items inside a column, then persist sequential stack_order. */
  function handleReorderColumn(columnStackId: string, orderedIds: string[]) {
    setColumnItems((prev) => {
      const next = new Map(prev);
      const arr = next.get(columnStackId) ?? [];
      const byId = new Map(arr.map((i) => [i.id, i]));
      next.set(columnStackId, orderedIds.map((id) => byId.get(id)!).filter(Boolean));
      return next;
    });
    invalidateViewCache();
    reorderColumnItems(orderedIds).catch(() => loadItems());
  }

  function onItemChanged(updated: Item | null) {
    invalidateViewCache(); // an edit/move may belong to (or leave) other cached views
    if (!updated) return loadItems();
    setOpen(updated);
    // Patch the edited item into the current view in place (mirrors softDelete's optimistic
    // path) — title/tag/space edits no longer trigger a full reload. A space move that takes
    // the item out of the current space drops it from the grid.
    const inView = selected === "all" || selected === "home" || updated.space_id === selected;
    setItems((prev) =>
      inView ? prev.map((i) => (i.id === updated.id ? updated : i)) : prev.filter((i) => i.id !== updated.id)
    );
    setAiItems((prev) => (prev ? prev.map((i) => (i.id === updated.id ? updated : i)) : prev));
  }

  async function fileTo(item: Item, spaceId: string) {
    setFiling(null);
    invalidateViewCache();
    await updateItem(item.id, { space_id: spaceId });
    toast("Filed ✓");
    loadItems();
  }

  async function toggleView() {
    if (!currentSpace) return;
    const next = currentSpace.view === "board" ? "grid" : "board";
    setSpaces((s) => s.map((x) => (x.id === currentSpace.id ? { ...x, view: next } : x)));
    await setSpaceView(currentSpace.id, next).catch(() => {});
  }

  /** Distil this board's aesthetic into a style brief, then open the web-similar dialog with it —
   *  the whole board becomes the reference instead of a single item. */
  async function exploreBoardStyle() {
    if (!currentSpace || briefBusy) return;
    setBriefBusy(true);
    try {
      const res = await boardBrief(currentSpace.id, currentSpace.name);
      if (!res) {
        toast("No described items on this board yet — save a few references first", "error");
        return;
      }
      // Brief generation failing (AI down) shouldn't block exploring: corpus retrieval runs
      // off the board centroid; the taste tags make a serviceable query for the web fallback.
      const fallback = (await tasteTags(currentSpace.id).catch(() => [] as string[])).slice(0, 8).join(", ");
      setSimilarItemId(null);
      setSimilarImage(res.image);
      setSimilarQuery(res.brief ?? (fallback || currentSpace.name));
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBriefBusy(false);
    }
  }

  const currentName =
    selected === "home" ? "Home" : selected === "all" ? "Everything" : currentSpace?.name ?? "";
  const showBoard = currentSpace?.view === "board";
  const masonryItems = currentFeedMode === "type" && selected !== "home" && !showBoard ? typedVisibleItems : visibleItems;

  // Mirror the active view into the URL (?s, ?q, ?c, ?v) so refresh/bookmark/share restore it.
  // ?v reflects the current space's grid/board mode — the DB stays the source of truth on load.
  useEffect(() => {
    const p = new URLSearchParams();
    p.set("s", selected);
    if (search.trim()) p.set("q", search.trim());
    if (colorFilter) p.set("c", colorFilter);
    if (showBoard) p.set("v", "board");
    history.replaceState(null, "", `?${p.toString()}`);
  }, [selected, search, colorFilter, showBoard]);

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="hidden w-60 shrink-0 border-r border-white/5 bg-[#121216]/55 backdrop-blur-2xl backdrop-saturate-150 md:block">
        <Sidebar
          libraries={libraries}
          libraryModes={effectiveLibraryModes}
          spaces={spaces}
          selected={selected}
          counts={counts}
          onSelect={(id) => {
            setSelected(id);
            setSearch("");
            setColorFilter(null);
          }}
          onSetLibraryMode={setLibraryMode}
          onChanged={loadStructure}
        />
      </aside>
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setSidebarOpen(false)} />
          <aside className="absolute left-0 top-0 h-full w-72 border-r border-white/10 bg-[#121216]/75 backdrop-blur-2xl backdrop-saturate-150">
            <Sidebar
              libraries={libraries}
              libraryModes={effectiveLibraryModes}
              spaces={spaces}
              selected={selected}
              counts={counts}
              onSelect={(id) => {
                setSelected(id);
                setSearch("");
                setColorFilter(null);
                setSidebarOpen(false);
              }}
              onSetLibraryMode={setLibraryMode}
              onChanged={loadStructure}
              onClose={() => setSidebarOpen(false)}
            />
          </aside>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 px-4 pb-2 pt-[max(1rem,env(safe-area-inset-top))]">
          <h1 className="truncate text-sm font-medium text-zinc-300">{currentName}</h1>
          {currentSpace && (
            <button
              onClick={toggleView}
              className="rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-zinc-400 hover:border-white/30 hover:text-zinc-200"
              title="Toggle grid / board"
            >
              <span className="flex items-center gap-1.5">{showBoard ? <GridIcon className="h-3.5 w-3.5" /> : <BoardIcon className="h-3.5 w-3.5" />}{showBoard ? "Grid" : "Board"}</span>
            </button>
          )}
          {currentSpace && (
            <button
              onClick={exploreBoardStyle}
              disabled={briefBusy}
              className="rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-zinc-400 hover:border-white/30 hover:text-zinc-200 disabled:opacity-50"
              title="Distil this board's aesthetic and find more like it on the web"
            >
              <span className="flex items-center gap-1.5"><SparklesIcon className="h-3.5 w-3.5" />{briefBusy ? "Reading the board…" : "Explore style"}</span>
            </button>
          )}
          {currentSpace?.kind === "bookmarks" && (
            <>
              <label
                className="cursor-pointer rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-zinc-400 hover:border-white/30 hover:text-zinc-200"
                title="Import Chrome bookmarks, Pocket export, or social saves (HTML, CSV, or JSON)"
              >
                <span className="flex items-center gap-1.5">Import bookmarks</span>
                <input
                  type="file"
                  accept=".html,.htm,.csv,.tsv,.json,.txt"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file || !currentSpace) return;
                    e.target.value = ""; // reset so same file can be re-selected
                    try {
                      const text = await file.text();
                      const { parseBookmarksHtml, parseBookmarksCsv, parseSocialJson, importBookmarks } = await import("@/lib/db");
                      const ext = file.name.split(".").pop()?.toLowerCase();
                      const entries = ext === "csv" || ext === "tsv"
                        ? parseBookmarksCsv(text)
                        : ext === "json"
                          ? parseSocialJson(text)
                          : parseBookmarksHtml(text);
                      if (!entries.length) { toast("No bookmarks found in file", "error"); return; }
                      const n = await importBookmarks(entries, currentSpace.id);
                      toast(n ? `Imported ${n} bookmark${n === 1 ? "" : "s"} — fetching images…` : "All bookmarks already imported");
                      invalidateViewCache(); loadItems(); loadStructure();
                      if (n) {
                        const { enrichLinkThumbs } = await import("@/lib/db");
                        setEnrichBusy(true);
                        enrichLinkThumbs(currentSpace.id, (done, total) => {
                          toast(`Fetching images… ${done}/${total}`);
                        }).then((enriched) => {
                          toast(enriched ? `Got images for ${enriched} bookmark${enriched === 1 ? "" : "s"}` : "No images found — links saved");
                          invalidateViewCache(); loadItems();
                        }).catch(() => {}).finally(() => setEnrichBusy(false));
                      }
                    } catch (err) {
                      toast(`Import failed: ${(err as Error).message}`, "error");
                    }
                  }}
                />
              </label>
              <button
                disabled={enrichBusy}
                className="rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-zinc-400 hover:border-white/30 hover:text-zinc-200 disabled:opacity-50"
                title="Fetch preview images for bookmarks that don't have one yet"
                onClick={async () => {
                  if (!currentSpace || enrichBusy) return;
                  setEnrichBusy(true);
                  try {
                    const { enrichLinkThumbs } = await import("@/lib/db");
                    const enriched = await enrichLinkThumbs(currentSpace.id, (done, total) => {
                      toast(`Fetching images… ${done}/${total}`);
                    });
                    toast(enriched ? `Got images for ${enriched} bookmark${enriched === 1 ? "" : "s"}` : "No new images found");
                    invalidateViewCache(); loadItems();
                  } catch (err) {
                    toast(`Failed: ${(err as Error).message}`, "error");
                  } finally {
                    setEnrichBusy(false);
                  }
                }}
              >
                {enrichBusy ? "Fetching…" : "Fetch images"}
              </button>
            </>
          )}
          {selected !== "home" && currentFeedMode === "type" && (
            <button
              onClick={() => setFontReviewOpen(true)}
              className="rounded-lg border border-amber-300/30 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-100 hover:border-amber-200/50"
              title="Review AI-detected font guesses"
            >
              Review fonts {reviewCount ? `(${reviewCount})` : ""}
            </button>
          )}
          {selected !== "home" && (
            <div className="ml-auto flex w-full max-w-md items-center gap-1.5">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && e.metaKey && runAiSearch()}
                placeholder="Search… (⌘↩ for AI search)"
                className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm outline-none placeholder:text-zinc-600 focus:border-white/30"
              />
              <button
                onClick={runAiSearch}
                disabled={aiBusy || !search.trim()}
                title="AI search — understands meaning, not just words"
                className="shrink-0 rounded-xl border border-white/10 px-3 py-2 text-sm text-zinc-200 hover:border-white/30 disabled:opacity-40"
              >
                {aiBusy ? "…" : <SparklesIcon className="h-4 w-4" />}
              </button>
            </div>
          )}
        </header>

        {selected !== "home" && !showBoard && (
          <div className="no-scrollbar flex items-center gap-1.5 overflow-x-auto px-4 pb-2">
            {COLOR_NAMES.map((c) => (
              <button
                key={c}
                onClick={() => setColorFilter(colorFilter === c ? null : c)}
                title={c}
                className={`h-5 w-5 shrink-0 rounded-full border transition-transform ${
                  colorFilter === c ? "scale-125 border-white" : "border-white/20 hover:scale-110"
                }`}
                style={{ background: COLOR_HEX[c] }}
              />
            ))}
            {colorFilter && (
              <button onClick={() => setColorFilter(null)} className="ml-1 text-[11px] text-zinc-500 hover:text-zinc-200">
                clear
              </button>
            )}
          </div>
        )}

        {selected !== "home" && !showBoard && currentFeedMode === "type" && (
          <div className="no-scrollbar flex items-center gap-1.5 overflow-x-auto px-4 pb-2">
            {([
              { id: "foundries", label: "Foundries" },
              { id: "fonts", label: "Fonts" },
              { id: "inuse", label: "In Use" },
            ] as const).map((t) => (
              <button
                key={t.id}
                onClick={() => setTypeTab(t.id)}
                className={`rounded-full border px-3 py-1 text-[11px] ${
                  typeTab === t.id
                    ? "border-amber-300/40 bg-amber-500/15 text-amber-100"
                    : "border-white/10 text-zinc-400 hover:border-white/30 hover:text-zinc-200"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        <div ref={scrollRef} className={`flex-1 ${showBoard && selected !== "home" ? "overflow-hidden" : "no-scrollbar overflow-y-auto"}`}>
          {selected === "home" ? (
            <Feed
              spaces={spaces}
              inboxId={inbox?.id}
              onBookmark={handleBookmark}
              onOpenItem={(i) => setOpen(i)}
              onSaved={() => { invalidateViewCache(); loadItems(); loadStructure(); }}
              toast={toast}
            />
          ) : showBoard ? (
            <Board
              items={visibleItems}
              urls={urls}
              onOpen={setOpen}
              stacks={stacks}
              stackThumbs={stackThumbs}
              columnItems={columnItems}
              onOpenStack={openStack}
              selected={selIds}
              onMarquee={(ids, additive) =>
                setSelIds((prev) => new Set(additive ? [...prev, ...ids] : ids))
              }
              onItemUpdate={handleItemUpdate}
              onStackUpdate={handleStackUpdate}
              onDropToColumn={handleDropToColumn}
              onRemoveFromColumn={handleRemoveFromColumn}
              onReorderColumn={handleReorderColumn}
              onAddNoteToColumn={handleAddNoteToColumn}
              autoEditId={autoEditId}
              onAutoEditConsumed={() => setAutoEditId(null)}
            />
          ) : !ready ? (
            <SkeletonGrid />
          ) : (
            <>
              {aiItems && (
                <div className="flex items-center gap-2 px-4 pb-2 text-[11px] text-violet-300">
                  ✨ {aiItems.length} AI matches across your library
                  <button onClick={() => setAiItems(null)} className="text-zinc-500 hover:text-zinc-200">
                    clear
                  </button>
                </div>
              )}
              {currentFeedMode === "type" && !masonryItems.length ? (
                <div className="px-4 pb-6 text-xs text-zinc-500">
                  {typeTab === "foundries" && "No foundry cards in this space yet. Save foundry sites or links to build this lane."}
                  {typeTab === "fonts" && "No font-tagged cards yet. Review AI guesses or save more specimens."}
                  {typeTab === "inuse" && "No in-use cards yet. Save screenshots or captures with typography in context."}
                </div>
              ) : (
                <Masonry
                  items={masonryItems}
                  urls={urls}
                  onOpen={setOpen}
                  onFile={currentSpace?.kind === "inbox" ? (i) => setFiling(i) : undefined}
                  stacks={aiItems ? [] : stacks}
                  stackThumbs={stackThumbs}
                  onOpenStack={openStack}
                  selected={selIds}
                  onToggleSelect={toggleSelect}
                  onMarquee={(ids, additive) =>
                    setSelIds((prev) => new Set(additive ? [...prev, ...ids] : ids))
                  }
                  ghosts={pending}
                />
              )}
              {search.trim() && (
                <div className="px-3 pb-24">
                  <button
                    onClick={() => { setSimilarImage(null); setSimilarQuery(search.trim()); }}
                    className="mx-auto block rounded-full border border-white/10 bg-white/[0.03] px-5 py-2.5 text-xs text-zinc-200 hover:border-white/30"
                  >
                    <span className="flex items-center justify-center gap-2"><GlobeIcon className="h-4 w-4" /> Search the web for “{search.trim()}”</span>
                  </button>
                </div>
              )}
              {!search.trim() && !aiItems && (
                <div ref={sentinelRef} className="px-3 pb-24 pt-3 text-center text-[11px] text-zinc-600">
                  {loadingMore ? "Loading more…" : !hasMore && items.length >= ITEMS_PAGE ? "That's everything" : ""}
                </div>
              )}
            </>
          )}
        </div>
      </main>

      <AddMenu
        onFiles={handleFiles}
        onUrl={handleUrl}
        onCapture={handleCapture}
        onNote={handleNote}
        noteInline={showBoard}
        onColumn={showBoard ? handleColumn : undefined}
        onTodo={showBoard ? handleTodo : undefined}
        openTick={addTick}
      />

      {/* Mobile bottom tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex items-stretch border-t border-white/10 bg-[#0f0f12]/65 pb-[env(safe-area-inset-bottom)] backdrop-blur-2xl backdrop-saturate-150 md:hidden">
        {(
          [
            { key: "home", icon: <HomeIcon className="h-5 w-5" />, label: "Home", fn: () => { setSelected("home"); setSearch(""); setColorFilter(null); } },
            { key: "all", icon: <GridIcon className="h-5 w-5" />, label: "All", fn: () => { setSelected("all"); setSearch(""); setColorFilter(null); } },
            { key: "add", icon: null, label: "Add", fn: () => setAddTick((t) => t + 1) },
            { key: "spaces", icon: <MenuIcon className="h-5 w-5" />, label: "Spaces", fn: () => setSidebarOpen(true) },
          ] as const
        ).map((t) =>
          t.key === "add" ? (
            <button key={t.key} onClick={t.fn} className="flex flex-1 items-center justify-center py-1.5" title="Add to Mood">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-white text-black shadow-lg shadow-black/50 active:scale-95">
                <PlusIcon className="h-5 w-5" />
              </span>
            </button>
          ) : (
            <button
              key={t.key}
              onClick={t.fn}
              className={`flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[10px] ${
                selected === t.key ? "text-zinc-200" : "text-zinc-500 active:text-zinc-300"
              }`}
            >
              <span className="leading-none">{t.icon}</span>
              {t.label}
            </button>
          )
        )}
      </nav>

      {open && (
        <Detail
          item={open}
          spaces={spaces}
          allItems={items}
          siblings={masonryItems}
          urls={urls}
          onClose={() => setOpen(null)}
          onChanged={onItemChanged}
          onOpenItem={(i) => setOpen(i)}
          onWebSimilar={(q, imageUrl, itemId) => {
            setOpen(null);
            setSimilarItemId(itemId ?? null);
            setSimilarImage(imageUrl ?? null);
            setSimilarQuery(q);
          }}
          onDelete={softDelete}
        />
      )}

      {filing && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" onClick={() => setFiling(null)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div
            ref={filingRef}
            role="dialog"
            aria-modal="true"
            aria-label="File to a space"
            tabIndex={-1}
            className="relative z-10 w-full max-w-sm glass-dark rounded-t-2xl p-3 outline-none sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-2 pb-2 text-xs uppercase tracking-wider text-zinc-500">File to…</div>
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {libraries.map((lib) => {
                const libSpaces = spaces.filter((s) => s.library_id === lib.id && s.kind !== "inbox");
                if (!libSpaces.length) return null;
                return (
                  <div key={lib.id}>
                    {libraries.length > 1 && (
                      <div className="px-4 pb-1 pt-2 text-[10px] uppercase tracking-wider text-zinc-500">{lib.name}</div>
                    )}
                    {libSpaces.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => fileTo(filing, s.id)}
                        className="w-full rounded-xl px-4 py-2.5 text-left text-sm text-zinc-200 hover:bg-white/10"
                      >
                        {s.name}
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {fontReviewOpen && (
        <div className="fixed inset-0 z-40 flex" onClick={() => setFontReviewOpen(false)}>
          <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" />
          <div
            ref={reviewRef}
            role="dialog"
            aria-modal="true"
            aria-label="Typography font review"
            tabIndex={-1}
            className="relative z-10 m-auto flex h-[88dvh] w-[min(900px,96vw)] flex-col overflow-hidden glass-dark rounded-2xl outline-none"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/5 px-5 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-zinc-200">Font Review Queue</div>
                <div className="truncate text-[11px] text-zinc-600">
                  {reviewCount} pending AI font guess{reviewCount === 1 ? "" : "es"}
                </div>
              </div>
              <button onClick={() => setFontReviewOpen(false)} className="ml-4 text-zinc-500 hover:text-zinc-200">
                ✕
              </button>
            </div>
            <div className="no-scrollbar flex-1 space-y-3 overflow-y-auto p-4">
              {!fontReviewQueue.length && (
                <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-zinc-400">
                  No pending AI font guesses in this view.
                </div>
              )}
              {fontReviewQueue.map(({ item, pending }) => (
                <div key={item.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                  <button
                    onClick={() => {
                      setFontReviewOpen(false);
                      setOpen(item);
                    }}
                    className="text-left text-sm font-medium text-zinc-200 hover:underline"
                  >
                    {item.title ?? item.source_domain ?? "Untitled item"}
                  </button>
                  <div className="mt-0.5 text-[11px] text-zinc-600">
                    {item.source_domain ?? "uploaded image"}
                  </div>
                  <div className="mt-2 space-y-2">
                    {pending.map((token) => {
                      const busyApprove = reviewBusy === `${item.id}:${token}:approve`;
                      const busyReject = reviewBusy === `${item.id}:${token}:reject`;
                      const { name } = splitFontToken(token);
                      return (
                        <div key={`${item.id}:${token}`} className="flex items-center justify-between gap-3 rounded-lg border border-white/8 px-3 py-2">
                          <div className="min-w-0">
                            <div className="truncate text-sm text-zinc-200">{name}</div>
                            <div className="text-[11px] text-amber-200/90">AI guess · {Math.round(fontGuessConfidence(token) * 100)}%</div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => reviewFontGuess(item, token, "approve")}
                              disabled={!!reviewBusy}
                              className="rounded-lg border border-emerald-300/30 bg-emerald-500/15 px-2.5 py-1 text-[11px] text-emerald-100 hover:border-emerald-200/50 disabled:opacity-50"
                            >
                              {busyApprove ? "Saving…" : "Approve"}
                            </button>
                            <button
                              onClick={() => reviewFontGuess(item, token, "reject")}
                              disabled={!!reviewBusy}
                              className="rounded-lg border border-red-300/30 bg-red-500/15 px-2.5 py-1 text-[11px] text-red-100 hover:border-red-200/50 disabled:opacity-50"
                            >
                              {busyReject ? "Saving…" : "Reject"}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {selIds.size > 0 && (
        <div className="rise-in fixed bottom-20 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 glass rounded-full px-4 py-2.5 md:bottom-6">
          <span className="text-xs text-zinc-400">{selIds.size} selected</span>
          <button
            onClick={makeStack}
            className="rounded-full bg-white px-4 py-1.5 text-xs font-medium text-black hover:bg-zinc-200"
          >
            <span className="flex items-center gap-1.5"><StackIcon className="h-4 w-4" /> Stack</span>
          </button>
          <button
            onClick={() => (confirmDel ? bulkDelete() : setConfirmDel(true))}
            className={`rounded-full px-4 py-1.5 text-xs font-medium ${
              confirmDel
                ? "bg-red-500 text-white hover:bg-red-400"
                : "border border-white/10 text-red-300 hover:border-red-400/40"
            }`}
          >
            <span className="flex items-center gap-1.5"><TrashIcon className="h-4 w-4" /> {confirmDel ? "Confirm delete" : "Delete"}</span>
          </button>
          <button onClick={() => setSelIds(new Set())} className="px-2 text-xs text-zinc-500 hover:text-zinc-200">
            Clear
          </button>
        </div>
      )}

      {similarQuery && (
        <div className="fixed inset-0 z-40 flex" onClick={() => setSimilarQuery(null)}>
          <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" />
          <div
            ref={similarRef}
            role="dialog"
            aria-modal="true"
            aria-label="Similar on the web"
            tabIndex={-1}
            className="relative z-10 m-auto flex h-[90dvh] w-[min(1280px,96vw)] flex-col overflow-hidden glass-dark rounded-2xl outline-none"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/5 px-5 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-zinc-200">Similar on the web</div>
                <div className="truncate text-[11px] text-zinc-600">
                  “{similarQuery}” — saves go to {currentSpace?.name ?? "Inbox"}
                </div>
              </div>
              <button onClick={() => setSimilarQuery(null)} className="ml-4 text-zinc-500 hover:text-zinc-200">
                ✕
              </button>
            </div>
            <div className="no-scrollbar flex-1 overflow-y-auto p-4">
              <Feed
                compact
                briefControls
                initialQuery={similarQuery}
                initialImage={similarImage}
                mode={currentFeedMode}
                defaultSpaceId={targetSpace}
                tasteSpaceId={currentSpace?.id}
                similarToItemId={similarItemId}
                spaces={spaces}
                inboxId={inbox?.id}
                onBookmark={handleBookmark}
                onOpenItem={(i) => {
                  setSimilarQuery(null);
                  setOpen(i);
                }}
                onSaved={() => { invalidateViewCache(); loadItems(); loadStructure(); }}
                toast={toast}
              />
            </div>
          </div>
        </div>
      )}

      {stackView && (
        <div className="fixed inset-0 z-40 flex" onClick={() => setStackView(null)}>
          <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" />
          <div
            ref={stackRef}
            role="dialog"
            aria-modal="true"
            aria-label={stackView.stack.name || "Stack"}
            tabIndex={-1}
            className="relative z-10 m-auto flex max-h-[88dvh] w-[min(980px,96vw)] flex-col overflow-hidden glass-dark rounded-2xl outline-none"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-white/5 px-5 py-3">
              <input
                defaultValue={stackView.stack.name}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== stackView.stack.name) {
                    renameStack(stackView.stack.id, v).then(loadItems).catch(() => {});
                  }
                }}
                className="w-full max-w-xs rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm font-medium text-zinc-200 outline-none hover:border-white/10 focus:border-white/30"
              />
              <div className="flex shrink-0 items-center gap-3">
                <button onClick={dissolveStack} className="text-xs text-red-400/80 hover:text-red-300">
                  Unstack all
                </button>
                <button onClick={() => setStackView(null)} className="text-zinc-500 hover:text-zinc-200">
                  ✕
                </button>
              </div>
            </div>
            <div className="no-scrollbar flex-1 overflow-y-auto p-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {stackView.items.map((i) => (
                  <div key={i.id} className="group relative">
                    <button
                      onClick={() => {
                        setStackView(null);
                        setOpen(i);
                      }}
                      className="block w-full overflow-hidden rounded-lg border border-white/10 hover:border-white/30"
                    >
                      {i.thumb_path && urls.get(i.thumb_path) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={urls.get(i.thumb_path)} alt="" className="aspect-[4/3] w-full object-cover object-top" />
                      ) : (
                        <div className="grid aspect-[4/3] w-full place-items-center bg-white/5 px-2 text-[11px] text-zinc-500">
                          {(i.title ?? i.source_domain ?? "note").slice(0, 30)}
                        </div>
                      )}
                    </button>
                    <button
                      onClick={() => unstackOne(i)}
                      title="Remove from stack"
                      className="absolute right-1.5 top-1.5 hidden rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white backdrop-blur hover:bg-white hover:text-black group-hover:block pointer-coarse:block"
                    >
                      <span className="flex items-center gap-1"><UnstackIcon className="h-3 w-3" /> unstack</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center border-4 border-dashed border-white/40 bg-white/10">
          <div className="glass rounded-2xl px-6 py-4 text-sm text-zinc-100">
            Drop to add to{" "}
            <span className="font-semibold text-zinc-200">{currentSpace?.name ?? "Inbox"}</span>
          </div>
        </div>
      )}

      <div className="pointer-events-none fixed bottom-24 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rise-in pointer-events-auto flex items-center gap-3 rounded-full px-4 py-2 text-xs shadow-lg ${
              t.kind === "error" ? "border border-red-400/20 bg-red-950/80 text-red-200 backdrop-blur-xl" : "glass text-zinc-100"
            }`}
          >
            {t.text}
            {t.action && (
              <button onClick={t.action.fn} className="font-semibold text-white hover:text-zinc-300">
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>

      <DialogHost />
    </div>
  );
}

export default function Page() {
  return (
    <AuthGate>
      <App />
    </AuthGate>
  );
}
