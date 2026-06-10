"use client";

import { useEffect, useRef, useState } from "react";
import type { Item, Space } from "@/lib/types";
import { matchToItem, signedUrls, touchViewed, updateItem } from "@/lib/db";
import { notice } from "./ui";
import { SparklesIcon, XIcon, ChevronLeftIcon, ChevronRightIcon } from "./icons";

interface Props {
  item: Item;
  spaces: Space[];
  allItems: Item[];
  /** Ordered list the lightbox arrows/swipe move through (the currently visible grid). */
  siblings?: Item[];
  urls: Map<string, string>;
  onClose: () => void;
  onChanged: (item: Item | null) => void;
  onOpenItem: (item: Item) => void;
  onWebSimilar: (query: string) => void;
  onDelete: (item: Item) => void;
}

function related(item: Item, all: Item[]): Item[] {
  return all
    .filter((i) => i.id !== item.id)
    .map((i) => {
      let score = 0;
      for (const t of i.tags ?? []) if (item.tags?.includes(t)) score += 2;
      // tone tokens (dark/light) are near-universal — they'd relate everything to everything
      for (const c of i.colors ?? []) if (c !== "dark" && c !== "light" && item.colors?.includes(c)) score += 1;
      if (i.source_domain && i.source_domain === item.source_domain) score += 2;
      return { i, score };
    })
    .filter((r) => r.score > 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((r) => r.i);
}

export default function Detail({ item, spaces, allItems, siblings, urls, onClose, onChanged, onOpenItem, onWebSimilar, onDelete }: Props) {
  const [fullUrl, setFullUrl] = useState<string | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const [title, setTitle] = useState(item.title ?? "");
  const [tags, setTags] = useState(item.tags.join(", "));
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const tall = !!(item.width && item.height && item.height / item.width > 1.6);
  const scrollMode = tall ? !zoomed : zoomed; // tall pages default to full-width scroll

  const [rel, setRel] = useState<Item[]>([]);
  const [relUrls, setRelUrls] = useState<Map<string, string>>(new Map());

  const idx = siblings ? siblings.findIndex((s) => s.id === item.id) : -1;
  const prevItem = idx > 0 ? siblings![idx - 1] : null;
  const nextItem = idx >= 0 && idx < siblings!.length - 1 ? siblings![idx + 1] : null;

  useEffect(() => {
    setTitle(item.title ?? "");
    setTags(item.tags.join(", "));
    setFullUrl(null);
    setZoomed(false);
    const path = item.storage_path ?? item.thumb_path;
    if (path) signedUrls([path]).then((m) => setFullUrl(m.get(path) ?? null));
    touchViewed(item.id).catch(() => {});
  }, [item]);

  // True visual similarity (library-wide kNN); falls back to tag/colour overlap pre-embedding.
  useEffect(() => {
    let alive = true;
    setRel([]);
    matchToItem(item.id, 10)
      .then(async (matches) => {
        const good = matches.filter((m) => (m.similarity ?? 0) >= 0.45);
        const result = good.length ? good : related(item, allItems);
        if (!alive) return;
        setRel(result);
        const paths = result.map((r) => r.thumb_path).filter(Boolean) as string[];
        if (paths.length) {
          const m = await signedUrls(paths);
          if (alive) setRelUrls(m);
        }
      })
      .catch(() => {
        if (alive) setRel(related(item, allItems));
      });
    return () => {
      alive = false;
    };
  }, [item, allItems]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowLeft" && prevItem) onOpenItem(prevItem);
      if (e.key === "ArrowRight" && nextItem) onOpenItem(nextItem);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, prevItem, nextItem, onOpenItem]);

  function onTouchStart(e: React.TouchEvent) {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  function onTouchEnd(e: React.TouchEvent) {
    const s = touchStart.current;
    touchStart.current = null;
    if (!s) return;
    const dx = e.changedTouches[0].clientX - s.x;
    const dy = e.changedTouches[0].clientY - s.y;
    if (Math.abs(dx) > 70 && Math.abs(dx) > 1.8 * Math.abs(dy)) {
      if (dx < 0 && nextItem) onOpenItem(nextItem);
      else if (dx > 0 && prevItem) onOpenItem(prevItem);
    }
  }

  async function save() {
    setBusy(true);
    const updated = await updateItem(item.id, {
      title: title.trim() || null,
      tags: tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean),
    });
    setBusy(false);
    onChanged(updated);
  }

  async function move(spaceId: string) {
    const updated = await updateItem(item.id, { space_id: spaceId });
    onChanged(updated);
  }

  function remove() {
    onClose();
    onDelete(item); // instant, with an Undo toast — no interrogation
  }

  async function copyImage() {
    if (!fullUrl) return;
    try {
      const blob = await fetch(fullUrl).then((r) => r.blob());
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext("2d")!.drawImage(bmp, 0, 0);
      const png: Blob = await new Promise((res, rej) =>
        canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png")
      );
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      notice({ title: "Copy failed", body: "Try downloading instead." });
    }
  }

  const input =
    "w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-white/30";
  const btn =
    "rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-300 hover:border-white/25 disabled:opacity-50";

  return (
    <div className="fixed inset-0 z-40 flex" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        className="card-in no-scrollbar relative z-10 m-auto flex h-dvh w-screen flex-col overflow-y-auto bg-[#141418]/85 backdrop-blur-2xl md:h-auto md:shadow-2xl md:max-h-[94dvh] md:w-[min(1200px,96vw)] md:flex-row md:overflow-hidden md:rounded-2xl md:border md:border-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="fixed right-3 top-3 z-30 grid h-9 w-9 place-items-center rounded-full bg-black/60 text-white backdrop-blur md:hidden"
        >
          <XIcon className="h-4 w-4" />
        </button>
        <div
          className="group/nav relative flex shrink-0 flex-col bg-black/40 md:min-h-[60dvh] md:flex-1 md:shrink md:overflow-hidden"
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          {prevItem && (
            <button
              onClick={() => onOpenItem(prevItem)}
              title="Previous (←)"
              className="absolute left-3 top-1/2 z-20 hidden h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-lg text-white opacity-0 backdrop-blur transition-opacity hover:bg-black/70 group-hover/nav:opacity-100 md:grid"
            >
              <ChevronLeftIcon className="h-5 w-5" />
            </button>
          )}
          {nextItem && (
            <button
              onClick={() => onOpenItem(nextItem)}
              title="Next (→)"
              className="absolute right-3 top-1/2 z-20 hidden h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-lg text-white opacity-0 backdrop-blur transition-opacity hover:bg-black/70 group-hover/nav:opacity-100 md:grid"
            >
              <ChevronRightIcon className="h-5 w-5" />
            </button>
          )}
          <div className={`md:flex-1 ${scrollMode ? "md:overflow-y-auto" : "md:grid md:place-items-center md:overflow-hidden"}`}>
            {fullUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={fullUrl}
                alt=""
                onClick={() => setZoomed((z) => !z)}
                title={scrollMode ? "Click to fit" : "Click to view full width"}
                className={
                  scrollMode
                    ? "w-full md:cursor-zoom-out"
                    : "w-full md:max-h-[72dvh] md:cursor-zoom-in md:object-contain"
                }
              />
            ) : item.type === "note" ? (
              <div className="max-w-prose whitespace-pre-wrap p-8 text-sm leading-relaxed text-zinc-200">{item.content}</div>
            ) : (
              <div className="text-zinc-700">No preview</div>
            )}
          </div>

          {(rel.length > 0 || item.title || item.tags.length > 0) && (
            <div className="border-t border-white/5 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] uppercase tracking-wider text-zinc-600">More like this</span>
                {(() => {
                  const q = [
                    item.ai_caption ?? item.title,
                    ...(item.tags ?? []).slice(0, 3),
                    ...(item.colors ?? []).filter((c) => c !== "dark" && c !== "light").slice(0, 2),
                  ]
                    .filter(Boolean)
                    .join(" ")
                    .slice(0, 220);
                  return q ? (
                    <button onClick={() => onWebSimilar(q)} className="text-[11px] text-zinc-200 hover:underline">
                      Search the web for similar →
                    </button>
                  ) : null;
                })()}
              </div>
              {rel.length > 0 ? (
                <div className="no-scrollbar flex gap-2 overflow-x-auto">
                  {rel.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => onOpenItem(r)}
                      className="h-20 w-28 shrink-0 overflow-hidden rounded-lg border border-white/10 hover:border-white/30"
                    >
                      {r.thumb_path && (relUrls.get(r.thumb_path) ?? urls.get(r.thumb_path)) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={relUrls.get(r.thumb_path) ?? urls.get(r.thumb_path)}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="grid h-full w-full place-items-center bg-white/5 text-[10px] text-zinc-500 px-1">
                          {(r.title ?? r.source_domain ?? "note").slice(0, 24)}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-zinc-700">Nothing related in your library yet.</div>
              )}
            </div>
          )}
        </div>

        <div className="no-scrollbar w-full shrink-0 space-y-4 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] md:w-80 md:overflow-y-auto">
          <div className="flex items-start justify-between">
            <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-500">
              {item.type}
            </span>
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200"><XIcon className="h-4 w-4" /></button>
          </div>

          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-wider text-zinc-600">Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={save} className={input} />
          </div>

          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-wider text-zinc-600">
              Tags <span className="normal-case">(comma separated)</span>
            </label>
            <input value={tags} onChange={(e) => setTags(e.target.value)} onBlur={save} className={input} />
          </div>

          {item.ai_caption && (
            <div className="rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-xs leading-relaxed text-zinc-400">
              <span className="flex gap-2"><SparklesIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{item.ai_caption}</span></span>
            </div>
          )}

          {item.fonts?.length > 0 && (
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wider text-zinc-600">Fonts on this site</label>
              <div className="flex flex-wrap gap-1.5">
                {item.fonts.map((f) => {
                  const [name, provider] = f.split("@");
                  const enc = encodeURIComponent(name);
                  const href =
                    provider === "google"
                      ? `https://fonts.google.com/specimen/${name.trim().replace(/ /g, "+")}`
                      : provider === "adobe"
                      ? `https://fonts.adobe.com/search?query=${enc}`
                      : provider === "fontshare"
                      ? `https://www.fontshare.com/search?q=${enc}`
                      : provider === "myfonts"
                      ? `https://www.myfonts.com/search?query=${enc}`
                      : `https://www.google.com/search?q=${encodeURIComponent(`"${name}" typeface font`)}`;
                  const label =
                    provider === "google" ? "Google Fonts" :
                    provider === "adobe" ? "Adobe Fonts" :
                    provider === "fontshare" ? "Fontshare" :
                    provider === "myfonts" ? "MyFonts" : "Search the web";
                  return (
                    <a
                      key={f}
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      title={`Open in ${label}`}
                      className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-zinc-300 hover:border-white/30 hover:text-white"
                    >
                      <span className="mr-1 font-serif italic text-zinc-500">Aa</span>
                      {name}
                      <span className="ml-1 text-zinc-600">↗</span>
                    </a>
                  );
                })}
              </div>
            </div>
          )}

          {item.tech?.length > 0 && (
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wider text-zinc-600">Built with</label>
              <div className="flex flex-wrap gap-1.5">
                {item.tech.map((t) => (
                  <span
                    key={t}
                    className="rounded-full border border-teal-500/20 bg-teal-500/[0.06] px-2.5 py-1 text-[11px] text-teal-200/90"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          {item.colors?.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {item.colors.map((c) => (
                <span key={c} className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-zinc-400">
                  {c}
                </span>
              ))}
            </div>
          )}

          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-wider text-zinc-600">Space</label>
            <select value={item.space_id} onChange={(e) => move(e.target.value)} className={input}>
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          {item.source_url && (
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wider text-zinc-600">Source</label>
              <a href={item.source_url} target="_blank" rel="noreferrer" className="block truncate text-sm text-zinc-200 hover:underline">
                {item.source_domain ?? item.source_url}
              </a>
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-2">
            {fullUrl && (
              <>
                <button onClick={copyImage} className={btn}>{copied ? "Copied ✓" : "Copy image"}</button>
                <a href={fullUrl} download target="_blank" rel="noreferrer" className={btn}>Download</a>
              </>
            )}
            {item.source_url && (
              <button onClick={() => navigator.clipboard.writeText(item.source_url!)} className={btn}>Copy link</button>
            )}
            <button onClick={remove} disabled={busy} className={`${btn} text-red-400 hover:border-red-400/40`}>Delete</button>
          </div>

          <div className="pt-2 text-[11px] text-zinc-700">
            Added {new Date(item.created_at).toLocaleDateString()}
            {item.width && item.height ? ` · ${item.width}×${item.height}` : ""}
            {idx >= 0 && siblings ? ` · ${idx + 1} of ${siblings.length}` : ""}
          </div>
        </div>
      </div>
    </div>
  );
}
