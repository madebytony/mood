"use client";

import type { Item, Stack } from "@/lib/types";
import { THUMB_W, THUMB_MAX_H, dominantHex } from "@/lib/media";

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
}

function StackCard({ stack, thumbs, onOpen }: { stack: Stack; thumbs: string[]; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="card-in block w-full rounded-xl border border-white/5 bg-white/[0.03] p-3 text-left transition-transform hover:scale-[1.01] hover:border-violet-500/40"
    >
      <div className="relative mx-auto aspect-[4/3] w-full">
        {thumbs.length === 0 ? (
          <div className="grid h-full w-full place-items-center rounded-lg bg-white/5 text-2xl">🗂</div>
        ) : (
          thumbs.map((t, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={t}
              alt=""
              className="absolute inset-0 h-full w-full rounded-lg border border-white/10 object-cover object-top shadow-lg shadow-black/40"
              style={{ transform: `rotate(${(i - 1) * 5}deg) translateY(${i * -3}px)`, zIndex: i }}
            />
          ))
        )}
      </div>
      <div className="mt-2.5 truncate px-1 text-xs font-medium text-zinc-200">🗂 {stack.name}</div>
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
    <div className={`group relative ${selected ? "rounded-xl ring-2 ring-violet-500" : ""}`}>
      <button
        onClick={() => onOpen(item)}
        className="card-in block w-full overflow-hidden rounded-xl border border-white/5 bg-white/[0.03] text-left transition-transform hover:scale-[1.01] hover:border-white/15"
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
          <div className="grid aspect-[4/3] w-full place-items-center text-3xl text-zinc-700">🔗</div>
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
              ? "block border-violet-300 bg-violet-600 text-white"
              : "hidden border-white/50 bg-black/50 text-white/0 backdrop-blur hover:text-white/80 group-hover:block"
          }`}
        >
          ✓
        </button>
      )}
      {onFile && (
        <button
          onClick={() => onFile(item)}
          className="absolute right-2 top-2 hidden rounded-full bg-black/60 px-3 py-1 text-[11px] text-white backdrop-blur hover:bg-violet-600 group-hover:block"
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
}: Props) {
  if (!items.length && !stacks.length) {
    return (
      <div className="grid h-64 place-items-center text-sm text-zinc-600">
        Nothing here yet — drop an image, paste a URL, or hit +
      </div>
    );
  }
  return (
    <div className="columns-2 gap-3 px-3 pb-24 sm:columns-3 lg:columns-4 xl:columns-5 2xl:columns-6">
      {stacks.map((s) => (
        <div key={`stk-${s.id}`} className="mb-3" style={{ breakInside: "avoid" }}>
          <StackCard stack={s} thumbs={stackThumbs?.get(s.id) ?? []} onOpen={() => onOpenStack?.(s)} />
        </div>
      ))}
      {items.map((item) => (
        <div key={item.id} className="mb-3" style={{ breakInside: "avoid" }}>
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
