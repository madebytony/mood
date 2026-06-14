"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authToken } from "@/lib/supabase";
import { addFromUrl } from "@/lib/db";
import type { Space } from "@/lib/types";
import { useDialog } from "./useDialog";
import { HeartIcon, ExternalLinkIcon, XIcon, SearchIcon, PlusIcon, CheckSquareIcon, InboxIcon, BookmarkIcon, ChevronLeftIcon, ChevronRightIcon } from "./icons";

/* ---------- types ---------- */

export interface StudioEntry {
  id: string;
  url: string;
  domain: string;
  name: string | null;
  kind: "agency" | "foundry";
  tier: string;
  image: string | null;
  blurb: string | null;
  hearted: boolean;
}

interface WorkItem {
  url: string;
  title: string | null;
  image: string | null;
}

interface StudioDetail {
  studio: StudioEntry & {
    content_paths: string[] | null;
    rss_url: string | null;
    gallery_appearances: number;
  };
  work: WorkItem[];
}

/* ---------- helpers ---------- */

async function apiFetch(path: string, opts?: RequestInit) {
  const token = await authToken();
  return fetch(path, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts?.headers ?? {}) },
  });
}

const PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 4 3'%3E%3Crect width='4' height='3' fill='%2318181b'/%3E%3C/svg%3E";

/* ---------- WorkItemCard ---------- */

function WorkItemCard({
  item,
  spaces,
  toast,
  onPreview,
}: {
  item: WorkItem;
  spaces: Space[];
  toast: (msg: string, kind?: "info" | "error") => void;
  onPreview: (item: WorkItem) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState<string | null>(null); // spaceId being saved
  const [savedSpaces, setSavedSpaces] = useState<Set<string>>(new Set());
  const pickerRef = useRef<HTMLDivElement>(null);

  const bookmarks = spaces.find((s) => s.kind === "bookmarks");
  const otherSpaces = spaces.filter((s) => s.kind !== "bookmarks");

  // Close picker on outside click
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pickerOpen]);

  async function saveToSpace(spaceId: string, spaceName: string) {
    if (saving || savedSpaces.has(spaceId)) return;
    setPickerOpen(false);
    setSaving(spaceId);
    try {
      await addFromUrl(item.url, spaceId);
      setSavedSpaces((prev) => new Set([...prev, spaceId]));
      toast(`Saved to ${spaceName}`);
    } catch (e) {
      toast(`Couldn't save: ${(e as Error).message}`, "error");
    } finally {
      setSaving(null);
    }
  }

  const isSavingBookmark = saving === bookmarks?.id;
  const bookmarkSaved = bookmarks ? savedSpaces.has(bookmarks.id) : false;

  return (
    <div className="group relative rounded-xl bg-zinc-900 ring-1 ring-white/8 transition-all hover:ring-white/20">
      {/* image + title — click opens project preview */}
      <button onClick={() => onPreview(item)} className="block w-full text-left">
        <div className="aspect-[4/3] overflow-hidden rounded-t-xl">
          {item.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.image}
              alt={item.title ?? ""}
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
              onError={(e) => { (e.target as HTMLImageElement).src = PLACEHOLDER; }}
            />
          ) : (
            <div className="flex h-full items-center justify-center bg-zinc-800 text-zinc-700 text-xs">
              No image
            </div>
          )}
        </div>
        {item.title && (
          <div className="p-2.5">
            <p className="line-clamp-2 text-xs leading-snug text-zinc-300 group-hover:text-white">
              {item.title}
            </p>
          </div>
        )}
      </button>

      {/* action buttons — visible on hover */}
      <div className="absolute right-2 top-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {/* quick bookmark */}
        {bookmarks && (
          <button
            onClick={(e) => { e.preventDefault(); saveToSpace(bookmarks.id, bookmarks.name); }}
            disabled={!!saving || bookmarkSaved}
            title={bookmarkSaved ? "Bookmarked" : "Save to Bookmarks"}
            className={`grid h-7 w-7 place-items-center rounded-full backdrop-blur-sm transition-colors ${
              bookmarkSaved
                ? "bg-amber-500/30 text-amber-300"
                : isSavingBookmark
                ? "bg-black/60 text-zinc-400"
                : "bg-black/60 text-zinc-300 hover:text-amber-300"
            }`}
          >
            {isSavingBookmark ? (
              <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" className="opacity-25" />
                <path fill="currentColor" className="opacity-75" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : bookmarkSaved ? (
              <CheckSquareIcon className="h-3.5 w-3.5" />
            ) : (
              <BookmarkIcon className="h-3.5 w-3.5" />
            )}
          </button>
        )}

        {/* save to any space */}
        <div ref={pickerRef} className="relative">
          <button
            onClick={(e) => { e.preventDefault(); setPickerOpen((o) => !o); }}
            disabled={!!saving}
            title="Save to space…"
            className="grid h-7 w-7 place-items-center rounded-full bg-black/60 backdrop-blur-sm text-zinc-300 hover:text-white transition-colors disabled:opacity-50"
          >
            <PlusIcon className="h-3.5 w-3.5" />
          </button>

          {pickerOpen && spaces.length > 0 && (
            <div className="absolute right-0 top-8 z-50 w-48 overflow-hidden rounded-xl border border-white/10 bg-[#1c1c22]/98 shadow-2xl backdrop-blur-xl">
              <p className="px-3 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                Save to
              </p>
              {[...(bookmarks ? [bookmarks] : []), ...otherSpaces].map((space) => {
                const isSaving = saving === space.id;
                const isSaved = savedSpaces.has(space.id);
                return (
                  <button
                    key={space.id}
                    onClick={() => saveToSpace(space.id, space.name)}
                    disabled={isSaving || isSaved}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-300 hover:bg-white/8 hover:text-white disabled:opacity-60 transition-colors"
                  >
                    {space.kind === "inbox" && <InboxIcon className="h-3.5 w-3.5 shrink-0 text-zinc-500" />}
                    {space.kind === "bookmarks" && <BookmarkIcon className="h-3.5 w-3.5 shrink-0 text-zinc-500" />}
                    {space.kind === "normal" && <div className="h-3.5 w-3.5 shrink-0 rounded-sm border border-zinc-700" />}
                    <span className="flex-1 truncate">{space.name}</span>
                    {isSaving && (
                      <svg className="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-400" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" className="opacity-25" />
                        <path fill="currentColor" className="opacity-75" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    )}
                    {isSaved && <CheckSquareIcon className="h-3.5 w-3.5 shrink-0 text-emerald-400" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- StudioPanel ---------- */

function StudioPanel({
  domain,
  studios,
  spaces,
  onClose,
  onToggleHeart,
  toast,
}: {
  domain: string;
  studios: StudioEntry[];
  spaces: Space[];
  onClose: () => void;
  onToggleHeart: (domain: string, next: boolean) => void;
  toast: (msg: string, kind?: "info" | "error") => void;
}) {
  const [detail, setDetail] = useState<StudioDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const panelRef = useDialog<HTMLDivElement>(onClose, { escape: true });
  const [previewItem, setPreviewItem] = useState<WorkItem | null>(null);
  const [previewImages, setPreviewImages] = useState<string[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewIdx, setPreviewIdx] = useState(0);
  const [previewSaving, setPreviewSaving] = useState(false);
  const [previewSaved, setPreviewSaved] = useState(false);

  const studio = studios.find((s) => s.domain === domain);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setDetail(null);
    apiFetch(`/api/directory/${encodeURIComponent(domain)}`)
      .then((r) => r.json())
      .then((d) => { if (alive) { setDetail(d); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [domain]);

  // Fetch project preview images when a work item is selected
  useEffect(() => {
    if (!previewItem) return;
    setPreviewIdx(0);
    setPreviewImages(null);
    setPreviewSaved(false);
    setPreviewLoading(true);
    let alive = true;
    apiFetch(`/api/project-preview?url=${encodeURIComponent(previewItem.url)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!alive || !data) return;
        const imgs: string[] = data.images ?? [];
        if (imgs.length > 0) setPreviewImages(imgs);
      })
      .catch(() => {})
      .finally(() => { if (alive) setPreviewLoading(false); });
    return () => { alive = false; };
  }, [previewItem]);

  if (!studio) return null;

  const work = detail?.work ?? [];
  const hasWork = work.length > 0;

  return (
    <div className="fixed inset-0 z-40 flex" onClick={onClose}>
      {/* backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* panel — slides in from right */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={studio.name ?? studio.domain}
        tabIndex={-1}
        className="panel-in no-scrollbar relative z-10 ml-auto flex h-dvh w-full flex-col overflow-y-auto bg-[#141418]/90 backdrop-blur-2xl outline-none md:w-[480px] md:border-l md:border-white/10 md:shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* close */}
        <button
          onClick={onClose}
          className="absolute right-4 top-4 z-20 grid h-8 w-8 place-items-center rounded-full bg-white/10 text-zinc-300 hover:bg-white/20"
        >
          <XIcon className="h-4 w-4" />
        </button>

        {/* hero image */}
        <div className="relative h-52 w-full shrink-0 overflow-hidden bg-zinc-900 md:h-64">
          {studio.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={studio.image}
              alt=""
              className="h-full w-full object-cover"
              onError={(e) => { (e.target as HTMLImageElement).src = PLACEHOLDER; }}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-zinc-700 text-sm">
              {studio.domain}
            </div>
          )}
          {/* gradient overlay so text is readable */}
          <div className="absolute inset-0 bg-gradient-to-t from-[#141418]/80 via-transparent to-transparent" />
        </div>

        {/* studio info */}
        <div className="px-6 pb-4 pt-4">
          <div className="mb-1 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-white">{studio.name ?? studio.domain}</h2>
              <p className="mt-0.5 text-sm text-zinc-500">{studio.domain}</p>
            </div>
            <span className={`mt-1 shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
              studio.kind === "foundry"
                ? "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30"
                : "bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30"
            }`}>
              {studio.kind === "foundry" ? "Foundry" : "Agency"}
            </span>
          </div>

          {studio.blurb && (
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">{studio.blurb}</p>
          )}

          {/* actions */}
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={() => onToggleHeart(studio.domain, !studio.hearted)}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors ${
                studio.hearted
                  ? "border-rose-500/40 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25"
                  : "border-white/10 bg-white/5 text-zinc-400 hover:border-white/20 hover:text-zinc-200"
              }`}
            >
              <HeartIcon
                className={`h-4 w-4 ${studio.hearted ? "fill-rose-400 stroke-rose-400" : ""}`}
              />
              {studio.hearted ? "Hearted" : "Heart"}
            </button>
            <a
              href={studio.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-400 transition-colors hover:border-white/20 hover:text-zinc-200"
            >
              <ExternalLinkIcon className="h-4 w-4" />
              Visit site
            </a>
          </div>
        </div>

        <div className="mx-6 h-px bg-white/8" />

        {/* recent work */}
        <div className="flex-1 px-6 py-5">
          <h3 className="mb-4 text-xs font-semibold uppercase tracking-widest text-zinc-500">
            Recent work
          </h3>

          {loading && (
            <div className="grid grid-cols-2 gap-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="aspect-[4/3] animate-pulse rounded-xl bg-white/5" />
              ))}
            </div>
          )}

          {!loading && !hasWork && (
            <p className="text-sm text-zinc-600">
              No scraped content yet — check back after the next nightly harvest.
            </p>
          )}

          {!loading && hasWork && (
            <div className="grid grid-cols-2 gap-3">
              {work.map((item) => (
                <WorkItemCard key={item.url} item={item} spaces={spaces} toast={toast} onPreview={setPreviewItem} />
              ))}
            </div>
          )}
        </div>

        {/* Project preview overlay */}
        {previewItem && (
          <div className="absolute inset-0 z-30 flex flex-col bg-[#141418]/95 backdrop-blur-sm">
            {/* header */}
            <div className="flex items-center justify-between gap-2 border-b border-white/5 px-4 py-3 shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <button onClick={() => setPreviewItem(null)} className="min-h-[44px] px-2 text-xs text-zinc-400 hover:text-zinc-200 md:min-h-0 md:text-[11px]">
                  ← Back
                </button>
                {previewImages && previewImages.length > 1 && (
                  <span className="text-[11px] text-zinc-600">
                    {previewIdx + 1} / {previewImages.length}
                  </span>
                )}
                {previewLoading && (
                  <span className="text-[11px] text-zinc-500 animate-pulse">Loading...</span>
                )}
              </div>
              <span className="text-xs text-zinc-400 truncate">{previewItem.title}</span>
            </div>

            {/* image */}
            <div className="relative flex-1 grid place-items-center overflow-hidden">
              {previewImages && previewIdx > 0 && (
                <button
                  onClick={() => setPreviewIdx(previewIdx - 1)}
                  className="absolute left-3 top-1/2 z-20 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white backdrop-blur hover:bg-black/70"
                >
                  <ChevronLeftIcon className="h-5 w-5" />
                </button>
              )}
              {previewImages && previewIdx < previewImages.length - 1 && (
                <button
                  onClick={() => setPreviewIdx(previewIdx + 1)}
                  className="absolute right-3 top-1/2 z-20 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white backdrop-blur hover:bg-black/70"
                >
                  <ChevronRightIcon className="h-5 w-5" />
                </button>
              )}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                key={previewImages?.[previewIdx] ?? previewItem.image ?? "ph"}
                src={previewImages?.[previewIdx] ?? previewItem.image ?? PLACEHOLDER}
                data-url={previewImages?.[previewIdx] ?? previewItem.image ?? ""}
                alt={previewItem.title ?? ""}
                className="max-h-full w-full object-contain"
                onError={(e) => {
                  const el = e.target as HTMLImageElement;
                  const origUrl = el.getAttribute("data-url");
                  if (origUrl && !el.src.includes("/api/proxy-image")) {
                    el.src = `/api/proxy-image?url=${encodeURIComponent(origUrl)}`;
                  } else {
                    el.style.display = "none";
                  }
                }}
              />
            </div>

            {/* thumbnail strip */}
            {previewImages && previewImages.length > 1 && (
              <div className="no-scrollbar flex gap-1.5 overflow-x-auto border-t border-white/5 p-2 shrink-0">
                {previewImages.map((src, i) => (
                  <button
                    key={src}
                    onClick={() => setPreviewIdx(i)}
                    className={`h-12 w-16 shrink-0 overflow-hidden rounded-md border transition-colors ${
                      i === previewIdx ? "border-white/40" : "border-white/10 hover:border-white/25"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={src}
                      data-url={src}
                      alt=""
                      className="h-full w-full object-cover"
                      onError={(e) => {
                        const el = e.target as HTMLImageElement;
                        const origUrl = el.getAttribute("data-url");
                        if (origUrl && !el.src.includes("/api/proxy-image")) {
                          el.src = `/api/proxy-image?url=${encodeURIComponent(origUrl)}`;
                        }
                      }}
                    />
                  </button>
                ))}
              </div>
            )}

            {/* actions */}
            <div className="flex items-center gap-3 border-t border-white/5 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shrink-0">
              <a
                href={previewItem.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-black hover:bg-zinc-200 md:px-3 md:py-2 md:text-xs"
              >
                <ExternalLinkIcon className="h-4 w-4 md:h-3.5 md:w-3.5" /> Visit site
              </a>
              {(() => {
                const bm = spaces.find((s) => s.kind === "bookmarks");
                if (!bm) return null;
                return (
                  <button
                    onClick={async () => {
                      if (previewSaving || previewSaved) return;
                      setPreviewSaving(true);
                      try {
                        await addFromUrl(previewItem.url, bm.id);
                        setPreviewSaved(true);
                        toast(`Saved to ${bm.name}`);
                      } catch (err) {
                        toast(`Couldn't save: ${(err as Error).message}`, "error");
                      } finally {
                        setPreviewSaving(false);
                      }
                    }}
                    disabled={previewSaving || previewSaved}
                    className={`flex items-center gap-1.5 rounded-lg border px-4 py-2.5 text-sm transition-colors md:px-3 md:py-2 md:text-xs ${
                      previewSaved
                        ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                        : "border-white/10 bg-white/5 text-zinc-300 hover:border-white/25"
                    }`}
                  >
                    {previewSaved ? (
                      <><CheckSquareIcon className="h-3.5 w-3.5" /> Saved</>
                    ) : previewSaving ? (
                      <>
                        <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" className="opacity-25" />
                          <path fill="currentColor" className="opacity-75" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Saving...
                      </>
                    ) : (
                      <><BookmarkIcon className="h-3.5 w-3.5" /> Save to Bookmarks</>
                    )}
                  </button>
                );
              })()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Directory ---------- */

type Filter = "all" | "agencies" | "foundries";

interface Props {
  spaces: Space[];
  toast: (msg: string, kind?: "info" | "error") => void;
}

export default function Directory({ spaces, toast }: Props) {
  const [studios, setStudios] = useState<StudioEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [panelDomain, setPanelDomain] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/api/directory");
      if (!res.ok) throw new Error(await res.text());
      setStudios(await res.json());
    } catch (e) {
      toast(`Directory failed to load: ${(e as Error).message}`, "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const toggleHeart = useCallback(async (domain: string, next: boolean) => {
    // Optimistic update
    setStudios((prev) => prev.map((s) => s.domain === domain ? { ...s, hearted: next } : s));
    try {
      const res = await apiFetch("/api/directory", {
        method: "POST",
        body: JSON.stringify({ domain, hearted: next }),
      });
      if (!res.ok) throw new Error(await res.text());
    } catch {
      // Revert on failure
      setStudios((prev) => prev.map((s) => s.domain === domain ? { ...s, hearted: !next } : s));
      toast("Couldn't update heart", "error");
    }
  }, [toast]);

  const visible = studios.filter((s) => {
    if (filter === "agencies" && s.kind !== "agency") return false;
    if (filter === "foundries" && s.kind !== "foundry") return false;
    if (search) {
      const q = search.toLowerCase();
      if (!(s.name?.toLowerCase().includes(q) || s.domain.includes(q))) return false;
    }
    return true;
  });

  // Sort: hearted first, then alphabetically
  const sorted = [...visible].sort((a, b) => {
    if (a.hearted !== b.hearted) return a.hearted ? -1 : 1;
    return (a.name ?? a.domain).localeCompare(b.name ?? b.domain);
  });

  const filterBtn = (f: Filter, label: string) =>
    `rounded-lg px-3 py-1.5 text-sm transition-colors ${
      filter === f
        ? "bg-white/10 text-white"
        : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
    }`;

  return (
    <div className="flex h-full flex-col">
      {/* filter bar */}
      <div className="shrink-0 border-b border-white/8 px-6 py-3 flex items-center gap-2">
        <div className="flex gap-1 rounded-xl bg-white/5 p-1">
          <button className={filterBtn("all", "All")} onClick={() => setFilter("all")}>All</button>
          <button className={filterBtn("agencies", "Agencies")} onClick={() => setFilter("agencies")}>Agencies</button>
          <button className={filterBtn("foundries", "Foundries")} onClick={() => setFilter("foundries")}>Foundries</button>
        </div>
        <div className="relative ml-auto">
          <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" />
          <input
            ref={searchRef}
            type="text"
            placeholder="Search studios…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-44 rounded-lg border border-white/10 bg-white/5 py-1.5 pl-9 pr-3 text-sm text-zinc-300 placeholder-zinc-600 outline-none focus:border-white/25 focus:text-white"
          />
        </div>
      </div>

      {/* grid */}
      <div className="no-scrollbar flex-1 overflow-y-auto px-6 py-6">
        {loading && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {Array.from({ length: 20 }).map((_, i) => (
              <div key={i} className="aspect-[4/3] animate-pulse rounded-2xl bg-white/5" />
            ))}
          </div>
        )}

        {!loading && sorted.length === 0 && (
          <p className="mt-16 text-center text-sm text-zinc-600">No studios match your filter.</p>
        )}

        {!loading && sorted.length > 0 && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {sorted.map((studio) => (
              <StudioCard
                key={studio.domain}
                studio={studio}
                onOpen={() => setPanelDomain(studio.domain)}
                onToggleHeart={toggleHeart}
              />
            ))}
          </div>
        )}
      </div>

      {/* studio detail panel */}
      {panelDomain && (
        <StudioPanel
          domain={panelDomain}
          studios={studios}
          spaces={spaces}
          onClose={() => setPanelDomain(null)}
          onToggleHeart={toggleHeart}
          toast={toast}
        />
      )}
    </div>
  );
}

/* ---------- StudioCard ---------- */

function StudioCard({
  studio,
  onOpen,
  onToggleHeart,
}: {
  studio: StudioEntry;
  onOpen: () => void;
  onToggleHeart: (domain: string, next: boolean) => void;
}) {
  return (
    <div className="group relative overflow-hidden rounded-2xl bg-zinc-900 ring-1 ring-white/8 transition-all hover:ring-white/20">
      {/* image */}
      <button className="w-full text-left" onClick={onOpen}>
        <div className="aspect-[4/3] overflow-hidden bg-zinc-900">
          {studio.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={studio.image}
              alt={studio.name ?? studio.domain}
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
              onError={(e) => {
                (e.target as HTMLImageElement).src = PLACEHOLDER;
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-zinc-700 text-xs">
              {studio.domain}
            </div>
          )}
          {/* overlay gradient */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
        </div>

        {/* info */}
        <div className="p-3">
          <div className="flex items-start justify-between gap-1">
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium text-zinc-200 group-hover:text-white">
                {studio.name ?? studio.domain}
              </p>
              <p className="mt-0.5 truncate text-[11px] text-zinc-600">{studio.domain}</p>
            </div>
            <span className={`mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
              studio.kind === "foundry"
                ? "bg-amber-500/15 text-amber-400"
                : "bg-sky-500/15 text-sky-400"
            }`}>
              {studio.kind === "foundry" ? "Type" : "Agency"}
            </span>
          </div>
        </div>
      </button>

      {/* heart button — shown on hover */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggleHeart(studio.domain, !studio.hearted); }}
        className={`absolute right-2.5 top-2.5 grid h-8 w-8 place-items-center rounded-full backdrop-blur-sm transition-all ${
          studio.hearted
            ? "bg-rose-500/30 text-rose-300 opacity-100"
            : "bg-black/50 text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-rose-300"
        }`}
        title={studio.hearted ? "Remove heart" : "Heart this studio"}
      >
        <HeartIcon
          className={`h-4 w-4 ${studio.hearted ? "fill-rose-400 stroke-rose-400" : ""}`}
        />
      </button>
    </div>
  );
}
