"use client";

import { useRef, useState } from "react";
import type { Item, Stack } from "@/lib/types";
import { THUMB_W, THUMB_MAX_H, dominantHex } from "@/lib/media";
import { StackIcon, LinkIcon, WarningIcon } from "./icons";

interface Props {
  items: Item[];
  urls: Map<string, string>;
  onOpen: (item: Item) => void;
  onFile?: (item: Item) => void; // Inbox triage
  stacks?: Stack[];
  stackThumbs?: Map<string, string[]>;
  onOpenStack?: (s: Stack) => void;
  selected?: Set<string>;
  onToggleSelect?: (id: string) => void;
  /** Rubber-band selection (desktop): replaces selection, or merges when shift is held. */
  onMarquee?: (ids: string[], additive: boolean) => void;
  ghosts?: { id: number; label: string }[];
}

function StackCard({ stack, thumbs, onOpen }: { stack: Stack; thumbs: string[]; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="group card-in block w-full rounded-xl border border-white/5 bg-white/[0.03] p-3 text-left transition-transform hover:scale-[1.01] hover:border-white/30"
    >
      <div className="relative mx-auto aspect-[4/3] w-full">
        {thumbs.length === 0 ? (
          <div className="grid h-full w-full place-items-center rounded-lg bg-white/5"><StackIcon className="h-8 w-8 text-zinc-600" /></div>
        ) : (
          thumbs.map((t, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={t}
              alt=""
              className="absolute inset-0 h-full w-full rounded-lg border border-white/10 object-cover object-top shadow-lg shadow-black/40 transition-transform duration-300 ease-out [transform:var(--rest)] group-hover:[transform:var(--fan)]"
              style={{
                ["--rest" as string]: `rotate(${(i - 1) * 5}deg) translateY(${i * -3}px)`,
                ["--fan" as string]: `rotate(${(i - 1) * 12}deg) translate(${(i - 1) * 18}px, ${i * -7}px) scale(1.04)`,
                zIndex: i,
              }}
            />
          ))
        )}
      </div>
      <div className="mt-2.5 truncate px-1 text-xs font-medium text-zinc-200"><span className="flex items-center gap-1.5"><StackIcon className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{stack.name}</span></span></div>
    </button>
  );
}

function Card({
  item,
  urls,
  onOpen,
  onFile,
  selected,
  onToggleSelect,
}: {
  item: Item;
  urls: Map<string, string>;
  onOpen: (i: Item) => void;
  onFile?: (i: Item) => void;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}) {
  const thumb = item.thumb_path ? urls.get(item.thumb_path) : null;
  const ratio =
    item.width && item.height ? Math.min(item.height / item.width, THUMB_MAX_H / THUMB_W) : null;

  return (
    <div className={`group relative ${selected ? "rounded-xl ring-2 ring-white/80" : ""}`}>
      <button
        onClick={() => onOpen(item)}
        className="card-in lift block w-full overflow-hidden rounded-xl border border-white/5 bg-white/[0.03] text-left hover:border-white/15"
      >
        {thumb ? (
          <div
            className="relative w-full"
            style={{ ...(ratio ? { aspectRatio: `${1 / ratio}` } : {}), backgroundColor: dominantHex(item.colors) }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumb}
              alt={item.title ?? ""}
              loading="lazy"
              className="h-full w-full object-cover object-top opacity-0 transition-opacity duration-500"
              onLoad={(e) => e.currentTarget.classList.remove("opacity-0")}
            />
          </div>
        ) : item.type === "note" ? (
          <div className="px-4 py-5 text-sm leading-relaxed text-zinc-300">{(item.content ?? "").slice(0, 280)}</div>
        ) : (
          <div className="grid aspect-[4/3] w-full place-items-center text-zinc-700"><LinkIcon className="h-7 w-7" /></div>
        )}

        {(item.type === "link" || item.type === "site") && (
          <div className="px-3 py-2.5">
            <div className="truncate text-xs font-medium text-zinc-300">{item.title ?? item.source_url}</div>
            <div className="mt-0.5 truncate text-[11px] text-zinc-600">{item.source_domain}</div>
          </div>
        )}
      </button>
      {item.type === "image" && item.source_domain && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 hidden rounded-b-xl bg-gradient-to-t from-black/70 to-transparent px-3 pb-2 pt-6 text-[11px] text-zinc-300 group-hover:block">
          {item.source_domain}
        </div>
      )}
      {onToggleSelect && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect(item.id);
          }}
          title="Select"
          className={`absolute left-2 top-2 z-10 h-6 w-6 rounded-full border text-[12px] leading-none ${
            selected
              ? "pop-in block border-white/80 bg-white text-black"
              : "hidden border-white/50 bg-black/50 text-white/0 backdrop-blur hover:text-white/80 group-hover:block pointer-coarse:block pointer-coarse:text-white/60"
          }`}
        >
          ✓
        </button>
      )}
      {item.dead_link && (
        <div
          title="Link may be dead — source didn't respond"
          className="pointer-events-none absolute bottom-2 right-2 z-10 grid h-5 w-5 place-items-center rounded-full bg-amber-500/90 text-black shadow"
        >
          <WarningIcon className="h-3.5 w-3.5" />
        </div>
      )}
      {onFile && (
        <button
          onClick={() => onFile(item)}
          className="absolute right-2 top-2 hidden rounded-full bg-black/60 px-3 py-1 text-[11px] text-white backdrop-blur hover:bg-white hover:text-black group-hover:block pointer-coarse:block"
        >
          File →
        </button>
      )}
    </div>
  );
}

export default function Masonry({
  items,
  urls,
  onOpen,
  onFile,
  stacks = [],
  stackThumbs,
  onOpenStack,
  selected,
  onToggleSelect,
  onMarquee,
  ghosts = [],
}: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [band, setBand] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const bandStart = useRef<{ x: number; y: number; shift: boolean } | null>(null);

  function bandRect(b: { x1: number; y1: number; x2: number; y2: number }) {
    return {
      left: Math.min(b.x1, b.x2),
      top: Math.min(b.y1, b.y2),
      width: Math.abs(b.x2 - b.x1),
      height: Math.abs(b.y2 - b.y1),
    };
  }

  function idsInBand(b: { x1: number; y1: number; x2: number; y2: number }): string[] {
    const r = bandRect(b);
    const out: string[] = [];
    gridRef.current?.querySelectorAll<HTMLElement>("[data-mid]").forEach((el) => {
      const c = el.getBoundingClientRect();
      if (c.left < r.left + r.width && c.left + c.width > r.left && c.top < r.top + r.height && c.top + c.height > r.top) {
        out.push(el.dataset.mid!);
      }
    });
    return out;
  }

  function onBandDown(e: React.PointerEvent) {
    if (!onMarquee || e.pointerType !== "mouse" || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-mid], button, a, img")) return; // only empty space
    bandStart.current = { x: e.clientX, y: e.clientY, shift: e.shiftKey };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function onBandMove(e: React.PointerEvent) {
    const s = bandStart.current;
    if (!s) return;
    if (!band && Math.abs(e.clientX - s.x) + Math.abs(e.clientY - s.y) < 6) return;
    e.preventDefault();
    setBand({ x1: s.x, y1: s.y, x2: e.clientX, y2: e.clientY });
  }
  function onBandUp() {
    const s = bandStart.current;
    bandStart.current = null;
    if (!band) return;
    onMarquee?.(idsInBand(band), s?.shift ?? false);
    setBand(null);
  }

  if (!items.length && !stacks.length && !ghosts.length) {
    return (
      <div className="grid h-64 place-items-center text-sm text-zinc-600">
        Nothing here yet — drop an image, paste a URL, or hit +
      </div>
    );
  }
  return (
    <div
      ref={gridRef}
      onPointerDown={onBandDown}
      onPointerMove={onBandMove}
      onPointerUp={onBandUp}
      onPointerCancel={onBandUp}
      className={`columns-2 gap-3 px-3 pb-24 sm:columns-3 lg:columns-4 xl:columns-5 2xl:columns-6 ${band ? "select-none" : ""}`}
    >
      {band && (
        <div
          className="pointer-events-none fixed z-30 rounded border border-white/60 bg-white/10"
          style={bandRect(band)}
        />
      )}
      {ghosts.map((g) => (
        <div key={`g-${g.id}`} className="mb-3" style={{ breakInside: "avoid" }}>
          <div className="card-in animate-pulse rounded-xl border border-white/20 bg-white/[0.05]">
            <div className="grid h-48 w-full place-items-center px-3 text-center">
              <span className="line-clamp-3 break-all text-[11px] text-zinc-500">{g.label}</span>
            </div>
          </div>
        </div>
      ))}
      {stacks.map((s) => (
        <div key={`stk-${s.id}`} className="mb-3" style={{ breakInside: "avoid" }}>
          <StackCard stack={s} thumbs={stackThumbs?.get(s.id) ?? []} onOpen={() => onOpenStack?.(s)} />
        </div>
      ))}
      {items.map((item) => (
        <div key={item.id} data-mid={item.id} className="mb-3" style={{ breakInside: "avoid" }}>
          <Card
            item={item}
            urls={urls}
            onOpen={onOpen}
            onFile={onFile}
            selected={selected?.has(item.id)}
            onToggleSelect={onToggleSelect}
          />
        </div>
      ))}
    </div>
  );
}
