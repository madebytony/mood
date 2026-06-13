"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authToken } from "@/lib/supabase";
import { useDialog } from "./useDialog";
import { HeartIcon, ExternalLinkIcon, XIcon, SearchIcon } from "./icons";

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

/* ---------- StudioPanel ---------- */

function StudioPanel({
  domain,
  studios,
  onClose,
  onToggleHeart,
}: {
  domain: string;
  studios: StudioEntry[];
  onClose: () => void;
  onToggleHeart: (domain: string, next: boolean) => void;
}) {
  const [detail, setDetail] = useState<StudioDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const panelRef = useDialog<HTMLDivElement>(onClose, { escape: true });

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
                <a
                  key={item.url}
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group relative overflow-hidden rounded-xl bg-zinc-900 ring-1 ring-white/8 transition-all hover:ring-white/20"
                >
                  <div className="aspect-[4/3] overflow-hidden">
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
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- Directory ---------- */

type Filter = "all" | "agencies" | "foundries";

interface Props {
  toast: (msg: string, kind?: "info" | "error") => void;
}

export default function Directory({ toast }: Props) {
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
      {/* header */}
      <div className="shrink-0 border-b border-white/8 px-6 pb-4 pt-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Directory</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Curated agencies and type foundries
        </p>

        <div className="mt-4 flex items-center gap-2">
          {/* filter tabs */}
          <div className="flex gap-1 rounded-xl bg-white/5 p-1">
            <button className={filterBtn("all", "All")} onClick={() => setFilter("all")}>All</button>
            <button className={filterBtn("agencies", "Agencies")} onClick={() => setFilter("agencies")}>Agencies</button>
            <button className={filterBtn("foundries", "Foundries")} onClick={() => setFilter("foundries")}>Foundries</button>
          </div>

          {/* search */}
          <div className="relative ml-auto">
            <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-48 rounded-lg border border-white/10 bg-white/5 py-2 pl-9 pr-3 text-sm text-zinc-300 placeholder-zinc-600 outline-none focus:border-white/25 focus:text-white"
            />
          </div>
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
          onClose={() => setPanelDomain(null)}
          onToggleHeart={toggleHeart}
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
