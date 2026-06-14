"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Item, Space } from "@/lib/types";
import { addFromUrl, discover, logDiscoveryEvent, markSeen, resurface, type DiscoverFilters, type DiscoveryMode, type Suggestion } from "@/lib/db";
import { LAB_SWATCHES, FACET_VOCABULARY } from "@/lib/facets";
import { signedUrls } from "@/lib/db";
import { COLOR_HEX, COLOR_NAMES } from "@/lib/media";
import { SkeletonGrid } from "./ui";
import { ThumbUpIcon, ThumbDownIcon, RefreshIcon, ArrowDownIcon, InboxIcon, BookmarkIcon } from "./icons";

interface Props {
  spaces: Space[];
  inboxId: string | undefined;
  /** Bookmark a URL (auto-creates Bookmarks space on first use). */
  onBookmark?: (url: string) => Promise<void>;
  onOpenItem: (item: Item) => void;
  onSaved: () => void;
  toast: (msg: string, kind?: "info" | "error") => void;
  /** Embedded inside a space: no search bar, no library gems, saves go straight to defaultSpaceId. */
  compact?: boolean;
  initialQuery?: string;
  /** Reference image URL for multimodal "more like this" web-similar searches. */
  initialImage?: string | null;
  defaultSpaceId?: string;
  mode?: "type";
  /** Scope the taste profile to one board's items instead of the whole library. */
  tasteSpaceId?: string;
  /** "More like this item": corpus retrieval queries with this item's own vector. */
  similarToItemId?: string | null;
  /** Show palette LAB swatch picker + facet chips even in compact mode (brief builder). */
  briefControls?: boolean;
}

type FeedCard = { kind: "suggestion"; s: Suggestion } | { kind: "library"; item: Item };
type TypeTab = "foundries" | "fonts" | "inuse";

/** Screenshot fallback for results without an og:image. WordPress mShots is genuinely free
 *  (thum.io's free tier returns a "sign up for a paid account" watermark). mShots returns a small
 *  grey placeholder while it generates the capture, so we retry once to pull the finished shot. */
const shot = (u: string) => `https://s.wordpress.com/mshots/v1/${encodeURIComponent(u)}?w=600&h=750`;

export default function Feed({ spaces, inboxId, onBookmark, onOpenItem, onSaved, toast, compact = false, initialQuery, initialImage, defaultSpaceId, mode, tasteSpaceId, similarToItemId, briefControls = false }: Props) {
  const [cards, setCards] = useState<FeedCard[]>([]);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [query, setQuery] = useState("");
  const [typeTab, setTypeTab] = useState<TypeTab>("foundries");
  // Home-feed lanes (awwwards-collections style): everything / site design / type foundries,
  // plus a palette filter served by the corpus's extracted colours.
  const [lane, setLane] = useState<"all" | "site" | "type">("all");
  const [paletteFilter, setPaletteFilter] = useState<string | null>(null);
  const [labFilter, setLabFilter] = useState<[number, number, number] | null>(null);
  const [facetFilters, setFacetFilters] = useState<Record<string, string[]>>({});
  const [discoveryMode, setDiscoveryMode] = useState<DiscoveryMode>("foryou");
  const [steer, setSteer] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [picking, setPicking] = useState<Suggestion | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [bookmarking, setBookmarking] = useState<string | null>(null);
  // Suggestion URLs whose image (og + screenshot fallback) both failed — hide rather than
  // show a broken tile. (Valid-but-poor images, e.g. logos/loading screens, need the server-side
  // quality gate — see DISCOVERY-V3-PLAN §8.)
  const [deadImg, setDeadImg] = useState<Set<string>>(new Set());
  const shown = useRef(new Set<string>());      // everything already offered this session
  const seeds = useRef<string[]>([]);            // descriptors of what you engaged with
  const inflightQ = useRef<string | null>(null); // dedupe double-fired identical loads (StrictMode)
  const loadSeq = useRef(0);                     // drop responses superseded by a newer load

  const isFoundryItem = (item: Item) => (item.type === "site" || item.type === "link") && !!item.source_domain;
  const isFontItem = (item: Item) => (item.fonts?.length ?? 0) > 0;
  const isInUseItem = (item: Item) => item.type === "image" || item.type === "site";

  const filteredCards = useMemo(() => {
    if (mode !== "type") return cards;
    return cards.filter((card) => {
      if (typeTab === "foundries") {
        return card.kind === "suggestion" || isFoundryItem(card.item);
      }
      if (typeTab === "fonts") {
        return card.kind === "library" && isFontItem(card.item);
      }
      return card.kind === "library" && isInUseItem(card.item);
    });
  }, [cards, mode, typeTab]);

  useEffect(() => {
    if (mode !== "type") setTypeTab("foundries");
  }, [mode]);

  function engage(s: Suggestion) {
    const words = (s.title ?? s.domain).replace(/[|–—·•].*/, "").trim();
    if (words) {
      seeds.current = [...seeds.current.filter((w) => w !== words), words].slice(-3);
    }
  }

  const load = useCallback(
    async (q: string | null, append = false) => {
      // An identical load is already running (e.g. effect double-fire) — let it finish alone;
      // a second racing request would non-deterministically overwrite the first's results.
      if (!append && inflightQ.current === (q ?? "")) return;
      inflightQ.current = q ?? "";
      const seq = ++loadSeq.current;
      setLoading(true);
      try {
        if (!append) shown.current = new Set();
        let didPartial = false; // tracks whether progressive display rendered anything
        const hasBriefFilters = briefControls && (labFilter !== null || Object.keys(facetFilters).length > 0);
        const filters: DiscoverFilters | undefined =
          !compact || hasBriefFilters
            ? {
                ...(lane !== "all" ? { kind: lane } : {}),
                ...(paletteFilter ? { color: paletteFilter } : {}),
                ...(labFilter ? { colorLab: labFilter } : {}),
                ...(Object.keys(facetFilters).length ? { facets: facetFilters } : {}),
              }
            : undefined;
        const [suggestions, gems] = await Promise.all([
          discover(q, [...shown.current], mode, initialImage, tasteSpaceId, similarToItemId, filters, discoveryMode,
            // Progressive display: show corpus/streamed results immediately while the full
            // pipeline runs. First batch replaces old cards; subsequent batches accumulate.
            (partial) => {
              if (seq !== loadSeq.current) return; // superseded
              const fresh = partial.filter((s) => !shown.current.has(s.url));
              if (!fresh.length) return;
              for (const s of fresh) shown.current.add(s.url);
              const mixed = fresh.map((s): FeedCard => ({ kind: "suggestion", s }));
              const isFirst = !didPartial;
              didPartial = true;
              setCards((prev) => (append || !isFirst ? [...prev, ...mixed] : mixed));
            },
          ),
          Promise.resolve([] as Item[]),
        ]);
        if (seq !== loadSeq.current) return; // superseded by a newer load
        // belt-and-braces: never show a card twice this session, even if the server re-offers it
        const fresh = suggestions.filter((s) => !shown.current.has(s.url));
        for (const s of fresh) shown.current.add(s.url);
        // Log impressions for the learning loop + mark as seen so they don't repeat
        const model = `clip-v2/${discoveryMode}`;
        for (const s of fresh) {
          logDiscoveryEvent(s.url, "impression", { lane: discoveryMode, model }).catch(() => {});
          markSeen(s.url, "seen").catch(() => {});
        }
        const mixed = fresh.map((s): FeedCard => ({ kind: "suggestion", s }));
        // If progressive display already rendered results and nothing new remains,
        // don't wipe the cards that are already showing.
        if (mixed.length || !didPartial) {
          setCards((prev) => (append || didPartial ? [...prev, ...mixed] : mixed));
        }
      } catch (e) {
        if (seq === loadSeq.current) toast((e as Error).message, "error");
      } finally {
        if (inflightQ.current === (q ?? "")) inflightQ.current = null;
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [toast, compact, briefControls, mode, initialImage, tasteSpaceId, similarToItemId, lane, paletteFilter, labFilter, facetFilters, discoveryMode]
  );

  useEffect(() => {
    if (!compact) load(null);
  }, [load, compact]);

  useEffect(() => {
    if (compact) load(initialQuery?.trim() || null);
  }, [compact, initialQuery, load]);

  useEffect(() => {
    if (compact) return; // only the Home instance listens
    function onDiscover(e: Event) {
      const q = (e as CustomEvent<string>).detail;
      setQuery(q);
      load(q);
    }
    window.addEventListener("mood-discover", onDiscover);
    return () => window.removeEventListener("mood-discover", onDiscover);
  }, [load, compact]);

  async function save(s: Suggestion, spaceId: string) {
    engage(s);
    setPicking(null);
    setSaving(s.url);
    try {
      await addFromUrl(s.url, spaceId);
      await markSeen(s.url, "saved");
      setCards((c) => c.filter((x) => x.kind !== "suggestion" || x.s.url !== s.url));
      toast("Saved ✓");
      onSaved();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setSaving(null);
    }
  }

  async function dismiss(s: Suggestion) {
    setCards((c) => c.filter((x) => x.kind !== "suggestion" || x.s.url !== s.url));
    const model = `clip-v2/${discoveryMode}`;
    await Promise.all([
      markSeen(s.url, "disliked").catch(() => {}),
      logDiscoveryEvent(s.url, "dislike", { lane: discoveryMode, model }).catch(() => {}),
    ]);
  }

  async function like(s: Suggestion) {
    engage(s);
    const model = `clip-v2/${discoveryMode}`;
    await Promise.all([
      markSeen(s.url, "liked").catch(() => {}),
      logDiscoveryEvent(s.url, "like", { lane: discoveryMode, model }).catch(() => {}),
    ]);
    toast("Noted — Find More will lean this way");
  }

  async function bookmark(s: Suggestion) {
    if (!onBookmark || bookmarking) return;
    setBookmarking(s.url);
    try {
      await onBookmark(s.url);
      toast("Bookmarked");
    } catch {
      toast("Couldn't bookmark", "error");
    } finally {
      setBookmarking(null);
    }
  }

  /** Pinterest loop: next batch blends your base query with what you've engaged with.
   *  In compact (web-similar) mode the search bar is hidden so `query` is always ""; use
   *  `initialQuery` as the persistent base so "Find more" keeps the original reference intent. */
  function findMore() {
    const base = compact ? (initialQuery?.trim() ?? "") : query.trim();
    // When the user provides a steer, use it as the primary query — the original brief
    // becomes secondary context so Gemini focuses on the new direction.
    const s = steer.trim();
    const q = s
      ? `${s}. (Reference context: ${base})`.trim()
      : [base, ...seeds.current].filter(Boolean).join(" ").trim() || null;
    load(q, true);
  }

  const chip = "rounded-full bg-black/55 px-2.5 py-1 text-[11px] text-white backdrop-blur hover:bg-white hover:text-black";

  return (
    <div className={compact ? "" : "px-3 pb-24"}>
      {!compact && (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          load(query.trim() || null);
        }}
        className="mx-auto mb-1.5 flex max-w-xl gap-2 pt-1"
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Describe what you're hunting for… e.g. brutalist e-commerce, editorial type"
          className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs outline-none placeholder:text-zinc-600 focus:border-white/30"
        />
        <button className="shrink-0 rounded-xl bg-white px-3 py-2 text-xs font-medium text-black hover:bg-zinc-200">
          {loading ? "…" : "Discover"}
        </button>
      </form>
      )}

      {briefControls && (
        <div className="mx-auto mb-2 flex max-w-xl items-center gap-2">
          <form
            className="flex flex-1 gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const s = steer.trim();
              if (!s) return;
              const base = compact ? (initialQuery?.trim() ?? "") : query.trim();
              // Fresh search steered by user input, original brief as context
              load(`${s}. (Reference context: ${base})`.trim(), false);
            }}
          >
            <input
              value={steer}
              onChange={(e) => setSteer(e.target.value)}
              placeholder="Steer… e.g. more ui app layouts"
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] outline-none placeholder:text-zinc-600 focus:border-white/30"
            />
            {steer.trim() && (
              <button type="submit" className="shrink-0 rounded-lg bg-white px-2.5 py-1.5 text-[10px] font-medium text-black hover:bg-zinc-200">
                Go
              </button>
            )}
          </form>
          <div className="relative">
            <button
              onClick={() => setFiltersOpen(!filtersOpen)}
              className={`rounded-lg border px-2.5 py-1.5 text-[10px] transition-colors ${
                filtersOpen || labFilter || Object.keys(facetFilters).length
                  ? "border-white/30 text-zinc-200"
                  : "border-white/10 text-zinc-500 hover:border-white/20 hover:text-zinc-300"
              }`}
            >
              Filters{(labFilter || Object.keys(facetFilters).length) ? ` (${(labFilter ? 1 : 0) + Object.values(facetFilters).flat().length})` : ""}
            </button>
            {filtersOpen && (
              <div className="absolute right-0 top-full z-20 mt-1.5 w-80 rounded-xl border border-white/10 bg-[#1a1a22]/95 p-3 shadow-2xl backdrop-blur-xl">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[9px] uppercase tracking-wider text-zinc-600">Colour</span>
                    {LAB_SWATCHES.map((s) => (
                      <button
                        key={s.name}
                        title={s.name}
                        onClick={() => setLabFilter(labFilter && labFilter.every((v, i) => v === s.lab[i]) ? null : s.lab as [number, number, number])}
                        className={`h-4 w-4 shrink-0 rounded-full border transition-transform ${
                          labFilter && labFilter.every((v, i) => v === s.lab[i])
                            ? "scale-125 border-white"
                            : "border-white/20 hover:scale-110"
                        }`}
                        style={{ background: s.hex }}
                      />
                    ))}
                    {labFilter && (
                      <button onClick={() => setLabFilter(null)} className="text-[9px] text-zinc-500 hover:text-zinc-300">✕</button>
                    )}
                  </div>
                  {Object.entries(FACET_VOCABULARY).map(([facetKey, labels]) => (
                    <div key={facetKey} className="flex flex-wrap items-center gap-1">
                      <span className="text-[9px] uppercase tracking-wider text-zinc-600 capitalize">{facetKey}</span>
                      {labels.map((label) => {
                        const active = (facetFilters[facetKey] ?? []).includes(label);
                        return (
                          <button
                            key={label}
                            onClick={() => {
                              setFacetFilters((prev) => {
                                const cur = prev[facetKey] ?? [];
                                const next = active ? cur.filter((x) => x !== label) : [...cur, label];
                                if (!next.length) {
                                  const { [facetKey]: _, ...rest } = prev;
                                  void _;
                                  return rest;
                                }
                                return { ...prev, [facetKey]: next };
                              });
                            }}
                            className={`rounded-full border px-1.5 py-px text-[9px] transition-colors ${
                              active
                                ? "border-white bg-white text-black"
                                : "border-white/10 text-zinc-500 hover:border-white/30 hover:text-zinc-300"
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {!compact && (
        <div className="mx-auto mb-2 flex max-w-xl items-center gap-1.5">
          <div className="flex gap-0.5 rounded-lg border border-white/10 bg-white/[0.03] p-0.5">
            {([
              { id: "foryou",   label: "For You" },
              { id: "fresh",    label: "Fresh" },
              { id: "trending", label: "Rising" },
              { id: "explore",  label: "Explore" },
            ] as const).map((m) => (
              <button
                key={m.id}
                onClick={() => setDiscoveryMode(m.id)}
                className={`rounded-md px-2 py-0.5 text-[10px] transition-colors ${
                  discoveryMode === m.id
                    ? "bg-white text-black"
                    : "text-zinc-400 hover:bg-white/10 hover:text-white"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <span className="h-3.5 w-px bg-white/10" />
          {([
            { id: "all", label: "All" },
            { id: "site", label: "Sites" },
            { id: "type", label: "Type" },
          ] as const).map((l) => (
            <button
              key={l.id}
              onClick={() => setLane(l.id)}
              className={`rounded-full border px-2 py-0.5 text-[10px] ${
                lane === l.id
                  ? "border-white bg-white text-black"
                  : "border-white/10 text-zinc-400 hover:border-white/30 hover:text-zinc-200"
              }`}
            >
              {l.label}
            </button>
          ))}
          <span className="h-3.5 w-px bg-white/10" />
          {COLOR_NAMES.map((c) => (
            <button
              key={c}
              onClick={() => setPaletteFilter(paletteFilter === c ? null : c)}
              title={`${c} palette`}
              className={`h-3.5 w-3.5 shrink-0 rounded-full border transition-transform ${
                paletteFilter === c ? "scale-125 border-white" : "border-white/20 hover:scale-110"
              }`}
              style={{ background: COLOR_HEX[c] }}
            />
          ))}
        </div>
      )}

      {mode === "type" && (
        <div className="mx-auto mb-3 flex w-full max-w-xl gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1">
          {([
            { id: "foundries", label: "Foundries" },
            { id: "fonts", label: "Fonts" },
            { id: "inuse", label: "In Use" },
          ] as const).map((t) => (
            <button
              key={t.id}
              onClick={() => setTypeTab(t.id)}
              className={`flex-1 rounded-lg px-3 py-1.5 text-xs ${
                typeTab === t.id
                  ? "bg-white text-black"
                  : "text-zinc-300 hover:bg-white/10 hover:text-white"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {loading && !filteredCards.length && (
        <div>
          <div className="pb-3 text-center text-xs text-zinc-600">Curating fresh inspiration…</div>
          <SkeletonGrid count={10} />
        </div>
      )}
      {loading && filteredCards.length > 0 && (
        <div className="pb-2 text-center text-xs text-zinc-600">Refining matches…</div>
      )}

      {!loading && !cards.length && (compact || query.trim() || lane !== "all" || paletteFilter) && (
        <div className="py-10 text-center text-xs text-zinc-600">
          {paletteFilter
            ? "Nothing in the index matches that palette yet — it grows with every harvest and search."
            : "No strong matches found — try rewording or broadening the brief."}
        </div>
      )}

      {!loading && mode === "type" && !filteredCards.length && cards.length > 0 && (
        <div className="pb-3 text-center text-xs text-zinc-600">
          {typeTab === "foundries" && "No foundry cards in this batch yet. Try Find more."}
          {typeTab === "fonts" && "No font-tagged items yet. Save more specimens or review AI font guesses."}
          {typeTab === "inuse" && "No in-use items yet. Save screenshots or captures to build this lane."}
        </div>
      )}

      {/* Rising lane has its own honest empty state — it stays empty rather than
          quietly serving For You results when there isn't enough activity yet. */}
      {!loading && discoveryMode === "trending" && mode !== "type" && !query.trim() && !filteredCards.length && (
        <div className="mx-auto max-w-sm py-12 text-center text-xs leading-relaxed text-zinc-600">
          <div className="mb-1 text-zinc-400">Rising is warming up</div>
          As sites get saved, opened, and liked, the fastest climbers from the last two weeks
          surface here. There isn’t enough activity yet — try <span className="text-zinc-400">For You</span> or
          {" "}<span className="text-zinc-400">Fresh</span> in the meantime.
        </div>
      )}

      <div className="columns-2 gap-3 sm:columns-3 lg:columns-4 xl:columns-5">
        {filteredCards
          .filter((card) => card.kind !== "suggestion" || !deadImg.has(card.s.url))
          .map((card) =>
          card.kind === "suggestion" ? (
            <div
              key={`s-${card.s.url}`}
              className="card-in group relative mb-3 overflow-hidden rounded-xl border border-white/5 bg-white/[0.03]"
              style={{ breakInside: "avoid" }}
            >
              <a href={card.s.url} target="_blank" rel="noreferrer" className="block" onClick={() => engage(card.s)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={card.s.image ?? shot(card.s.url)}
                  alt=""
                  loading="lazy"
                  className="aspect-[4/5] w-full bg-white/[0.04] object-cover object-top opacity-0 transition-opacity duration-500"
                  onLoad={(e) => {
                    const el = e.currentTarget;
                    // mShots serves a ~400px grey placeholder while generating — retry once for the real shot.
                    if (el.src.includes("mshots") && el.naturalWidth > 0 && el.naturalWidth < 600 && !el.dataset.retry) {
                      el.dataset.retry = "1";
                      setTimeout(() => { el.src = `${shot(card.s.url)}&retry=1`; }, 2800);
                      return;
                    }
                    el.classList.remove("opacity-0");
                  }}
                  onError={(e) => {
                    const el = e.currentTarget;
                    if (!el.dataset.fb && card.s.image) {
                      // og:image failed — fall back to a screenshot
                      el.dataset.fb = "1";
                      el.src = shot(card.s.url);
                    } else {
                      // both og:image and the screenshot failed — drop the card, don't show a broken tile
                      setDeadImg((d) => (d.has(card.s.url) ? d : new Set(d).add(card.s.url)));
                    }
                  }}
                />
                <div className="px-3 py-2.5">
                  <div className="truncate text-xs font-medium text-zinc-200">{card.s.title ?? card.s.domain}</div>
                  <div className="mt-0.5 truncate text-[11px] text-zinc-600">
                    {card.s.domain} · via {card.s.source}
                  </div>
                  {card.s.blurb && <div className="mt-1 text-[11px] leading-snug text-zinc-500">{card.s.blurb}</div>}
                </div>
              </a>
              <div className="absolute right-2 top-2 hidden gap-1.5 group-hover:flex pointer-coarse:flex">
                <button
                  className={chip}
                  onClick={() => (defaultSpaceId ? save(card.s, defaultSpaceId) : setPicking(card.s))}
                  disabled={saving === card.s.url}
                >
                  {saving === card.s.url ? "Saving…" : "Save"}
                </button>
                <button className={chip} title="More like this" onClick={() => like(card.s)}>
                  <ThumbUpIcon className="h-3.5 w-3.5" />
                </button>
                <button className={chip} title="Not for me" onClick={() => dismiss(card.s)}>
                  <ThumbDownIcon className="h-3.5 w-3.5" />
                </button>
                {onBookmark && (
                  <button
                    className={chip}
                    title="Save to Bookmarks"
                    onClick={() => bookmark(card.s)}
                    disabled={bookmarking === card.s.url}
                  >
                    <BookmarkIcon className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          ) : (
            <button
              key={`l-${card.item.id}`}
              onClick={() => onOpenItem(card.item)}
              className="card-in group relative mb-3 block w-full overflow-hidden rounded-xl border border-white/15 bg-white/[0.03] text-left"
              style={{ breakInside: "avoid" }}
            >
              {card.item.thumb_path && urls.get(card.item.thumb_path) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={urls.get(card.item.thumb_path)} alt="" loading="lazy" className="aspect-[4/5] w-full object-cover object-top" />
              ) : (
                <div className="px-4 py-5 text-sm text-zinc-300">{(card.item.content ?? card.item.title ?? "").slice(0, 200)}</div>
              )}
              <div className="px-3 py-2 text-[11px] text-zinc-200/80"><span className="flex items-center gap-1.5"><RefreshIcon className="h-3 w-3" /> From your library — been a while</span></div>
            </button>
          )
        )}
      </div>

      {filteredCards.length > 0 && (
        <div className="flex justify-center pb-6 pt-4">
          <button
            onClick={findMore}
            disabled={loading}
            className="rounded-full border border-white/10 bg-white/[0.03] px-6 py-2.5 text-sm text-zinc-200 hover:border-white/30 disabled:opacity-50"
          >
            {loading ? "Curating…" : <span className="flex items-center gap-2"><ArrowDownIcon className="h-3.5 w-3.5" />{seeds.current.length ? "Find more like what I'm into" : "Find more"}</span>}
          </button>
        </div>
      )}

      {picking && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" onClick={() => setPicking(null)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div
            className="relative z-10 w-full max-w-sm glass-dark rounded-t-2xl p-3 sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-2 pb-2 text-xs uppercase tracking-wider text-zinc-500">Save to…</div>
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {[...spaces].sort((a, b) => (a.kind === "inbox" ? -1 : b.kind === "inbox" ? 1 : 0)).map((s) => (
                <button
                  key={s.id}
                  onClick={() => save(picking, s.id)}
                  className="w-full rounded-xl px-4 py-2.5 text-left text-sm text-zinc-200 hover:bg-white/10"
                >
                  <span className="flex items-center gap-1.5">
                    {s.kind === "inbox" && <InboxIcon className="h-3.5 w-3.5 text-zinc-500" />}
                    {s.name}
                  </span>
                </button>
              ))}
              {inboxId == null && <div className="px-4 py-2 text-xs text-zinc-600">No spaces yet</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
