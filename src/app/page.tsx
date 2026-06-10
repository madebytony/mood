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
import {
  addFromUrl,
  addImageFile,
  addNote,
  aiSearch,
  captionItem,
  captureSite,
  createStack,
  deleteItemRow,
  deleteItemStorage,
  restoreItem,
  deleteStack,
  fetchItems,
  fetchLibraries,
  fetchSpaces,
  fetchStackItems,
  fetchStacks,
  renameStack,
  setSpaceView,
  signedUrls,
  stackThumbPaths,
  unstackItem,
  updateItem,
} from "@/lib/db";
import { COLOR_NAMES, COLOR_HEX } from "@/lib/media";
import type { Item, Library, Space, Stack } from "@/lib/types";

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Link";
  }
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
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [selected, setSelected] = useState<string | "all" | "home">("home");
  const [search, setSearch] = useState("");
  const [colorFilter, setColorFilter] = useState<string | null>(null);
  const [open, setOpen] = useState<Item | null>(null);
  const [filing, setFiling] = useState<Item | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [similarQuery, setSimilarQuery] = useState<string | null>(null);
  const [stacks, setStacks] = useState<Stack[]>([]);
  const [stackThumbs, setStackThumbs] = useState<Map<string, string[]>>(new Map());
  const [selIds, setSelIds] = useState<Set<string>>(new Set());
  const [stackView, setStackView] = useState<{ stack: Stack; items: Item[] } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<{ id: number; label: string }[]>([]);
  const [addTick, setAddTick] = useState(0);
  const toastId = useRef(0);
  const pendingId = useRef(0);
  const dragDepth = useRef(0);

  /** Optimistic ghost card: shows instantly in the grid, vanishes when the real item lands. */
  const trackPending = useCallback((label: string) => {
    const id = ++pendingId.current;
    setPending((p) => [...p, { id, label }]);
    return () => setPending((p) => p.filter((x) => x.id !== id));
  }, []);

  // ---------- URL state: refresh / share keeps the current view ----------
  useEffect(() => {
    const h = decodeURIComponent(window.location.hash.slice(1));
    if (h === "all" || h === "home") setSelected(h);
    else if (h.startsWith("s/")) setSelected(h.slice(2));
  }, []);

  useEffect(() => {
    const h = selected === "home" || selected === "all" ? selected : `s/${selected}`;
    history.replaceState(null, "", `#${h}`);
  }, [selected]);

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

  /** Stale-while-revalidate: cached views paint instantly, fresh data swaps in behind. */
  const viewCache = useRef(
    new Map<string, { items: Item[]; stacks: Stack[]; urls: Map<string, string>; stackThumbs: Map<string, string[]> }>()
  );

  const loadItems = useCallback(async () => {
    const spaceKey = selected === "home" ? "all" : selected;
    const cacheKey = `${spaceKey}|${search}`;
    const cached = viewCache.current.get(cacheKey);
    if (cached) {
      setItems(cached.items);
      setStacks(cached.stacks);
      setUrls(cached.urls);
      setStackThumbs(cached.stackThumbs);
      setReady(true);
    }
    const [data, stks] = await Promise.all([fetchItems(spaceKey, search), fetchStacks(spaceKey)]);
    const fan = await stackThumbPaths(stks.map((s) => s.id));
    const paths = [
      ...(data.map((i) => i.thumb_path).filter(Boolean) as string[]),
      ...[...fan.values()].flat(),
    ];
    const map = paths.length ? await signedUrls(paths) : new Map<string, string>();
    const fanUrls = new Map<string, string[]>();
    for (const [sid, ps] of fan) fanUrls.set(sid, ps.map((p) => map.get(p)).filter(Boolean) as string[]);
    viewCache.current.set(cacheKey, { items: data, stacks: stks, urls: map, stackThumbs: fanUrls });
    setItems(data);
    setStacks(stks);
    setUrls(map);
    setStackThumbs(fanUrls);
    setReady(true);
  }, [selected, search]);

  useEffect(() => {
    loadStructure().catch((e) => toast(String(e.message ?? e), "error"));
  }, [loadStructure, toast]);

  useEffect(() => {
    const t = setTimeout(
      () => loadItems().catch((e) => toast(String(e.message ?? e), "error")),
      search ? 250 : 0
    );
    return () => clearTimeout(t);
  }, [loadItems, search, toast]);

  useEffect(() => {
    setSelIds(new Set()); // clear selection when the view changes
  }, [search, selected]);

  useEffect(() => {
    // skeletons only for views we've never seen this session
    const spaceKey = selected === "home" ? "all" : selected;
    if (!viewCache.current.has(`${spaceKey}|${search}`)) setReady(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const inbox = useMemo(() => spaces.find((s) => s.kind === "inbox"), [spaces]);
  const currentSpace = useMemo(
    () => (selected !== "all" && selected !== "home" ? spaces.find((s) => s.id === selected) : undefined),
    [spaces, selected]
  );
  const targetSpace = currentSpace?.id ?? inbox?.id;

  const visibleItems = useMemo(
    () => (colorFilter ? items.filter((i) => i.colors?.includes(colorFilter)) : items),
    [items, colorFilter]
  );

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    m.set("all", items.length);
    return m;
  }, [items]);

  // ---------- capture handlers ----------

  const afterAdd = useCallback(
    (item: Item) => {
      captionItem(item, () => loadItems().catch(() => {}));
    },
    [loadItems]
  );

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (!targetSpace) return toast("No space to save into yet", "error");
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (!images.length) return;
      for (const f of images) {
        const done = trackPending(f.name || "Image");
        try {
          const item = await addImageFile(f, targetSpace);
          afterAdd(item);
          await loadItems();
        } catch (e) {
          toast(`Failed: ${(e as Error).message}`, "error");
        } finally {
          done();
        }
      }
    },
    [targetSpace, toast, loadItems, afterAdd, trackPending]
  );

  const handleUrl = useCallback(
    async (url: string) => {
      if (!targetSpace) return toast("No space to save into yet", "error");
      if (!/^https?:\/\//i.test(url)) return toast("That doesn't look like a URL", "error");
      const done = trackPending(safeHost(url));
      try {
        const item = await addFromUrl(url, targetSpace);
        afterAdd(item);
        await loadItems();
      } catch (e) {
        toast(`Import failed: ${(e as Error).message}`, "error");
      } finally {
        done();
      }
    },
    [targetSpace, toast, loadItems, afterAdd, trackPending]
  );

  const handleCapture = useCallback(
    async (url: string) => {
      if (!targetSpace) return toast("No space to save into yet", "error");
      if (!/^https?:\/\//i.test(url)) return toast("That doesn't look like a URL", "error");
      const done = trackPending(`📸 ${safeHost(url)} — capturing…`);
      try {
        const item = await captureSite(url, targetSpace);
        afterAdd(item);
        await loadItems();
      } catch (e) {
        toast(`Capture failed: ${(e as Error).message}`, "error");
      } finally {
        done();
      }
    },
    [targetSpace, toast, loadItems, afterAdd, trackPending]
  );

  const handleNote = useCallback(
    async (text: string) => {
      if (!targetSpace) return toast("No space to save into yet", "error");
      await addNote(text, targetSpace);
      loadItems();
    },
    [targetSpace, loadItems, toast]
  );

  /** Instant delete with a 5s Undo window. The row is deleted immediately (so a refresh
   *  can't resurrect it); Undo re-inserts it. Files are cleared after the window closes. */
  async function softDelete(item: Item) {
    setItems((prev) => prev.filter((i) => i.id !== item.id));
    try {
      await deleteItemRow(item);
    } catch (e) {
      toast(`Delete failed: ${(e as Error).message}`, "error");
      loadItems();
      return;
    }
    const id = ++toastId.current;
    let undone = false;
    const timer = setTimeout(() => {
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
            undone = true;
            clearTimeout(timer);
            setToasts((ts) => ts.filter((x) => x.id !== id));
            try {
              await restoreItem(item);
            } catch (e) {
              toast(`Undo failed: ${(e as Error).message}`, "error");
            }
            loadItems();
          },
        },
      },
    ]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5200);
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
    loadItems();
  }

  async function runAiSearch() {
    if (!search.trim()) return;
    setAiBusy(true);
    try {
      const all = await fetchItems("all", "");
      const ids = await aiSearch(search.trim(), all);
      if (ids === null) {
        toast("AI search needs ANTHROPIC_API_KEY in .env.local", "error");
        return;
      }
      const byId = new Map(all.map((i) => [i.id, i]));
      const ranked = ids.map((id) => byId.get(id)).filter(Boolean) as Item[];
      setSelected("all");
      setItems(ranked);
      const paths = ranked.map((i) => i.thumb_path).filter(Boolean) as string[];
      if (paths.length) setUrls(await signedUrls(paths));
      toast(`${ranked.length} matches`);
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

  function onItemChanged(updated: Item | null) {
    if (updated) setOpen(updated);
    loadItems();
  }

  async function fileTo(item: Item, spaceId: string) {
    setFiling(null);
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

  const currentName =
    selected === "home" ? "Home" : selected === "all" ? "Everything" : currentSpace?.name ?? "";
  const showBoard = currentSpace?.view === "board";

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="hidden w-60 shrink-0 border-r border-white/5 bg-[#121216]/55 backdrop-blur-2xl backdrop-saturate-150 md:block">
        <Sidebar
          libraries={libraries}
          spaces={spaces}
          selected={selected}
          counts={counts}
          onSelect={(id) => {
            setSelected(id);
            setColorFilter(null);
          }}
          onChanged={loadStructure}
        />
      </aside>
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setSidebarOpen(false)} />
          <aside className="absolute left-0 top-0 h-full w-72 border-r border-white/10 bg-[#121216]/75 backdrop-blur-2xl backdrop-saturate-150">
            <Sidebar
              libraries={libraries}
              spaces={spaces}
              selected={selected}
              counts={counts}
              onSelect={(id) => {
                setSelected(id);
                setColorFilter(null);
                setSidebarOpen(false);
              }}
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
              {showBoard ? "⊞ Grid" : "⬚ Board"}
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
                {aiBusy ? "…" : "✨"}
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

        <div className={`flex-1 ${showBoard && selected !== "home" ? "overflow-hidden" : "no-scrollbar overflow-y-auto"}`}>
          {selected === "home" ? (
            <Feed
              spaces={spaces}
              inboxId={inbox?.id}
              onOpenItem={(i) => setOpen(i)}
              onSaved={() => loadItems()}
              toast={toast}
            />
          ) : showBoard ? (
            <Board
              items={visibleItems}
              urls={urls}
              onOpen={setOpen}
              stacks={stacks}
              stackThumbs={stackThumbs}
              onOpenStack={openStack}
            />
          ) : !ready ? (
            <SkeletonGrid />
          ) : (
            <>
              <Masonry
                items={visibleItems}
                urls={urls}
                onOpen={setOpen}
                onFile={currentSpace?.kind === "inbox" ? (i) => setFiling(i) : undefined}
                stacks={stacks}
                stackThumbs={stackThumbs}
                onOpenStack={openStack}
                selected={selIds}
                onToggleSelect={toggleSelect}
                onMarquee={(ids, additive) =>
                  setSelIds((prev) => new Set(additive ? [...prev, ...ids] : ids))
                }
                ghosts={pending}
              />
              {search.trim() && (
                <div className="px-3 pb-24">
                  <button
                    onClick={() => setSimilarQuery(search.trim())}
                    className="mx-auto block rounded-full border border-white/10 bg-white/[0.03] px-5 py-2.5 text-xs text-zinc-200 hover:border-white/30"
                  >
                    🌐 Search the web for “{search.trim()}”
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </main>

      <AddMenu onFiles={handleFiles} onUrl={handleUrl} onCapture={handleCapture} onNote={handleNote} openTick={addTick} />

      {/* Mobile bottom tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex items-stretch border-t border-white/10 bg-[#0f0f12]/65 pb-[env(safe-area-inset-bottom)] backdrop-blur-2xl backdrop-saturate-150 md:hidden">
        {(
          [
            { key: "home", icon: "✨", label: "Home", fn: () => { setSelected("home"); setColorFilter(null); } },
            { key: "all", icon: "▦", label: "All", fn: () => { setSelected("all"); setColorFilter(null); } },
            { key: "add", icon: "+", label: "Add", fn: () => setAddTick((t) => t + 1) },
            { key: "spaces", icon: "☰", label: "Spaces", fn: () => setSidebarOpen(true) },
          ] as const
        ).map((t) =>
          t.key === "add" ? (
            <button key={t.key} onClick={t.fn} className="flex flex-1 items-center justify-center py-1.5" title="Add to Mood">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-white text-xl leading-none text-black shadow-lg shadow-black/50 active:scale-95">
                +
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
              <span className="text-base leading-none">{t.icon}</span>
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
          siblings={visibleItems}
          urls={urls}
          onClose={() => setOpen(null)}
          onChanged={onItemChanged}
          onOpenItem={(i) => setOpen(i)}
          onWebSimilar={(q) => {
            setOpen(null);
            setSimilarQuery(q);
          }}
          onDelete={softDelete}
        />
      )}

      {filing && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" onClick={() => setFiling(null)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div
            className="relative z-10 w-full max-w-sm rounded-t-2xl border border-white/10 bg-[#17171c]/80 p-3 backdrop-blur-2xl sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-2 pb-2 text-xs uppercase tracking-wider text-zinc-500">File to…</div>
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {spaces.filter((s) => s.kind !== "inbox").map((s) => (
                <button
                  key={s.id}
                  onClick={() => fileTo(filing, s.id)}
                  className="w-full rounded-xl px-4 py-2.5 text-left text-sm text-zinc-200 hover:bg-white/10"
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {selIds.size > 0 && (
        <div className="rise-in fixed bottom-20 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-[#17171b]/70 px-4 py-2.5 shadow-xl backdrop-blur-2xl backdrop-saturate-150 md:bottom-6">
          <span className="text-xs text-zinc-400">{selIds.size} selected</span>
          <button
            onClick={makeStack}
            className="rounded-full bg-white px-4 py-1.5 text-xs font-medium text-black hover:bg-zinc-200"
          >
            🗂 Stack
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
            className="relative z-10 m-auto flex h-[90dvh] w-[min(1280px,96vw)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#101013]/80 shadow-2xl backdrop-blur-2xl"
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
                initialQuery={similarQuery}
                defaultSpaceId={targetSpace}
                spaces={spaces}
                inboxId={inbox?.id}
                onOpenItem={(i) => {
                  setSimilarQuery(null);
                  setOpen(i);
                }}
                onSaved={loadItems}
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
            className="relative z-10 m-auto flex max-h-[88dvh] w-[min(980px,96vw)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#101013]/80 shadow-2xl backdrop-blur-2xl"
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
                      className="absolute right-1.5 top-1.5 hidden rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white backdrop-blur hover:bg-white hover:text-black group-hover:block"
                    >
                      ↩ unstack
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
          <div className="rounded-2xl bg-[#17171c]/80 px-6 py-4 backdrop-blur-xl text-sm text-zinc-200 shadow-xl">
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
              t.kind === "error" ? "border border-red-400/20 bg-red-950/80 text-red-200 backdrop-blur-xl" : "border border-white/10 bg-[#1b1b20]/75 text-zinc-100 backdrop-blur-xl"
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
