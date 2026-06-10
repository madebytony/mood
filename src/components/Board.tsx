"use client";

import { useEffect, useRef, useState } from "react";
import type { Item, Stack } from "@/lib/types";
import { updateItem, updateStack } from "@/lib/db";

interface Props {
  items: Item[];
  urls: Map<string, string>;
  onOpen: (item: Item) => void;
  stacks?: Stack[];
  stackThumbs?: Map<string, string[]>;
  onOpenStack?: (s: Stack) => void;
}

const CARD_W = 260;
const GAP = 24;

interface Pos {
  x: number;
  y: number;
  w: number;
}

function cardHeight(node: Item | Stack, w: number): number {
  if ("width" in node && node.width && node.height) return (node.height / node.width) * w;
  if (!("width" in node)) return w * 0.85; // stacks
  return ("type" in node && node.type === "note") ? 140 : w * 0.75;
}

export default function Board({ items, urls, onOpen, stacks = [], stackThumbs, onOpenStack }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const view = useRef({ x: 60, y: 60, k: 1 });
  const [positions, setPositions] = useState<Map<string, Pos>>(new Map());
  const [tidying, setTidying] = useState(false);
  const drag = useRef<{
    mode: "pan" | "card" | "pinch" | "resize" | null;
    key?: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
    startDist?: number;
    startK?: number;
    origW?: number;
  }>({ mode: null, startX: 0, startY: 0, origX: 0, origY: 0, moved: false });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const velSample = useRef<{ x: number; y: number; t: number } | null>(null);
  const vel = useRef({ vx: 0, vy: 0 });
  const momentumRaf = useRef(0);

  /** Flick-to-pan: keep gliding after pointer release, decaying each frame. */
  function startMomentum() {
    cancelAnimationFrame(momentumRaf.current);
    let { vx, vy } = vel.current; // px per frame (~16.7ms)
    if (Math.abs(vx) + Math.abs(vy) < 2) return;
    let last = performance.now();
    const step = (t: number) => {
      const f = Math.min(3, (t - last) / 16.7);
      last = t;
      view.current.x += vx * f;
      view.current.y += vy * f;
      vx *= Math.pow(0.93, f);
      vy *= Math.pow(0.93, f);
      applyView();
      if (Math.abs(vx) + Math.abs(vy) > 0.4) momentumRaf.current = requestAnimationFrame(step);
    };
    momentumRaf.current = requestAnimationFrame(step);
  }
  useEffect(() => () => cancelAnimationFrame(momentumRaf.current), []);

  type Node = { key: string; node: Item | Stack };
  const nodes: Node[] = [
    ...stacks.map((s) => ({ key: `stk:${s.id}`, node: s as Item | Stack })),
    ...items.map((i) => ({ key: i.id, node: i as Item | Stack })),
  ];

  function persistPos(key: string, patch: { board_x?: number; board_y?: number; board_w?: number }) {
    if (key.startsWith("stk:")) updateStack(key.slice(4), patch).catch(() => {});
    else updateItem(key, patch).catch(() => {});
  }

  function masonry(list: Node[], cols = 4): Map<string, Pos> {
    const heights = new Array(cols).fill(0);
    const out = new Map<string, Pos>();
    for (const { key, node } of list) {
      const c = heights.indexOf(Math.min(...heights));
      out.set(key, { x: c * (CARD_W + GAP), y: heights[c], w: CARD_W });
      heights[c] += cardHeight(node, CARD_W) + GAP;
    }
    return out;
  }

  useEffect(() => {
    const placed = new Map<string, Pos>();
    let maxX = 0;
    const unplaced: Node[] = [];
    for (const n of nodes) {
      const b = n.node;
      if (b.board_x != null && b.board_y != null) {
        placed.set(n.key, { x: b.board_x, y: b.board_y, w: b.board_w ?? CARD_W });
        maxX = Math.max(maxX, b.board_x + (b.board_w ?? CARD_W));
      } else {
        unplaced.push(n);
      }
    }
    const auto = masonry(unplaced);
    const offsetX = maxX > 0 ? maxX + GAP * 2 : 0;
    for (const [key, p] of auto) placed.set(key, { ...p, x: p.x + offsetX });
    setPositions(placed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, stacks]);

  function applyView() {
    const v = view.current;
    if (layer.current) layer.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
  }
  useEffect(applyView, []);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      cancelAnimationFrame(momentumRaf.current);
      const v = view.current;
      if (e.ctrlKey || e.metaKey) {
        const rect = el!.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const k2 = Math.min(2.5, Math.max(0.2, v.k * Math.exp(-e.deltaY * 0.01)));
        v.x = mx - ((mx - v.x) / v.k) * k2;
        v.y = my - ((my - v.y) / v.k) * k2;
        v.k = k2;
      } else {
        v.x -= e.deltaX;
        v.y -= e.deltaY;
      }
      applyView();
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  function clampW(w: number) {
    return Math.min(900, Math.max(140, w));
  }

  function onPointerDown(e: React.PointerEvent, key?: string) {
    cancelAnimationFrame(momentumRaf.current); // grab the canvas mid-glide
    vel.current = { vx: 0, vy: 0 };
    velSample.current = { x: e.clientX, y: e.clientY, t: performance.now() };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      drag.current = {
        mode: "pinch",
        startX: (a.x + b.x) / 2,
        startY: (a.y + b.y) / 2,
        origX: view.current.x,
        origY: view.current.y,
        moved: true,
        startDist: Math.hypot(a.x - b.x, a.y - b.y),
        startK: view.current.k,
      };
      return;
    }
    if (key) {
      const p = positions.get(key);
      if (!p) return;
      drag.current = { mode: "card", key, startX: e.clientX, startY: e.clientY, origX: p.x, origY: p.y, moved: false };
    } else {
      drag.current = { mode: "pan", startX: e.clientX, startY: e.clientY, origX: view.current.x, origY: view.current.y, moved: false };
    }
  }

  function onResizeDown(e: React.PointerEvent, key: string) {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const p = positions.get(key);
    if (!p) return;
    drag.current = { mode: "resize", key, startX: e.clientX, startY: e.clientY, origX: p.x, origY: p.y, moved: false, origW: p.w };
  }

  function nodeOf(key: string): Item | Stack | undefined {
    return nodes.find((n) => n.key === key)?.node;
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d.mode) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (d.mode === "pinch" && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const v = view.current;
      const k2 = Math.min(2.5, Math.max(0.2, (d.startK ?? 1) * (dist / (d.startDist ?? dist))));
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const rect = wrap.current!.getBoundingClientRect();
      const mx = cx - rect.left;
      const my = cy - rect.top;
      v.x = mx - ((mx - v.x) / v.k) * k2;
      v.y = my - ((my - v.y) / v.k) * k2;
      v.k = k2;
      applyView();
      return;
    }
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    if (d.mode === "pan") {
      view.current.x = d.origX + dx;
      view.current.y = d.origY + dy;
      const s = velSample.current;
      const now = performance.now();
      if (s && now - s.t > 0) {
        const dt = (now - s.t) / 16.7;
        vel.current = { vx: (e.clientX - s.x) / dt, vy: (e.clientY - s.y) / dt };
      }
      velSample.current = { x: e.clientX, y: e.clientY, t: now };
      applyView();
    } else if (d.mode === "card" && d.key) {
      const k = view.current.k;
      const el = document.getElementById(`card-${d.key}`);
      if (el) el.style.transform = `translate(${d.origX + dx / k}px, ${d.origY + dy / k}px)`;
    } else if (d.mode === "resize" && d.key) {
      const k = view.current.k;
      const nw = clampW((d.origW ?? CARD_W) + dx / k);
      const el = document.getElementById(`card-${d.key}`);
      const node = nodeOf(d.key);
      if (el && node) {
        el.style.width = `${nw}px`;
        el.style.height = `${cardHeight(node, nw)}px`;
      }
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    const d = drag.current;
    if (d.mode === "resize" && d.key) {
      const k = view.current.k;
      const nw = clampW((d.origW ?? CARD_W) + (e.clientX - d.startX) / k);
      const p = positions.get(d.key);
      if (p) {
        setPositions(new Map(positions).set(d.key, { ...p, w: nw }));
        persistPos(d.key, { board_w: nw });
      }
    } else if (d.mode === "card" && d.key) {
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      const k = view.current.k;
      if (d.moved) {
        const nx = d.origX + dx / k;
        const ny = d.origY + dy / k;
        const p = positions.get(d.key)!;
        setPositions(new Map(positions).set(d.key, { ...p, x: nx, y: ny }));
        persistPos(d.key, { board_x: nx, board_y: ny, board_w: p.w });
      } else {
        const node = nodeOf(d.key);
        if (node) {
          if (d.key.startsWith("stk:")) onOpenStack?.(node as Stack);
          else onOpen(node as Item);
        }
      }
    }
    if (d.mode === "pan" && d.moved && pointers.current.size === 0) startMomentum();
    drag.current = { mode: null, startX: 0, startY: 0, origX: 0, origY: 0, moved: false };
  }

  async function tidy() {
    setTidying(true);
    const ordered = [...nodes].sort((a, b) => {
      const pa = positions.get(a.key);
      const pb = positions.get(b.key);
      const ra = Math.round((pa?.y ?? 0) / 400);
      const rb = Math.round((pb?.y ?? 0) / 400);
      return ra - rb || (pa?.x ?? 0) - (pb?.x ?? 0);
    });
    const next = masonry(ordered);
    setPositions(next);
    await Promise.all(
      [...next.entries()].map(([key, p]) => {
        persistPos(key, { board_x: p.x, board_y: p.y, board_w: p.w });
        return Promise.resolve();
      })
    );
    setTimeout(() => setTidying(false), 400);
  }

  return (
    <div
      ref={wrap}
      className="relative h-full touch-none overflow-hidden bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.05)_1px,transparent_0)] [background-size:28px_28px]"
      onPointerDown={(e) => onPointerDown(e)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div ref={layer} className="absolute left-0 top-0 origin-top-left" style={{ transform: "translate(60px,60px)" }}>
        {nodes.map(({ key, node }) => {
          const p = positions.get(key);
          if (!p) return null;
          const h = cardHeight(node, p.w);
          const isStack = key.startsWith("stk:");
          const item = isStack ? null : (node as Item);
          const stack = isStack ? (node as Stack) : null;
          const thumb = item?.thumb_path ? urls.get(item.thumb_path) : null;
          const fan = stack ? stackThumbs?.get(stack.id) ?? [] : [];
          return (
            <div
              key={key}
              id={`card-${key}`}
              className={`group absolute left-0 top-0 cursor-grab overflow-hidden rounded-xl border bg-[#17171c] shadow-lg shadow-black/40 active:cursor-grabbing ${
                isStack ? "border-white/20" : "border-white/10"
              } ${tidying ? "transition-transform duration-300" : ""}`}
              style={{ width: p.w, height: h, transform: `translate(${p.x}px, ${p.y}px)` }}
              onPointerDown={(e) => {
                e.stopPropagation();
                onPointerDown(e, key);
              }}
            >
              {stack ? (
                <div className="relative h-full w-full p-3">
                  <div className="relative h-[calc(100%-1.6rem)] w-full">
                    {fan.length === 0 ? (
                      <div className="grid h-full w-full place-items-center rounded-lg bg-white/5 text-2xl">🗂</div>
                    ) : (
                      fan.map((t, i) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          key={i}
                          src={t}
                          alt=""
                          draggable={false}
                          className="absolute inset-0 h-full w-full select-none rounded-lg border border-white/10 object-cover object-top"
                          style={{ transform: `rotate(${(i - 1) * 5}deg)`, zIndex: i }}
                        />
                      ))
                    )}
                  </div>
                  <div className="mt-1.5 truncate text-center text-[11px] font-medium text-zinc-200">🗂 {stack.name}</div>
                </div>
              ) : thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={thumb} alt="" draggable={false} className="h-full w-full select-none object-cover object-top" />
              ) : (
                <div className="h-full w-full p-3 text-xs leading-relaxed text-zinc-300">
                  {(item?.content ?? item?.title ?? item?.source_domain ?? "").slice(0, 200)}
                </div>
              )}
              <div
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onResizeDown(e, key);
                }}
                title="Drag to resize"
                className="absolute bottom-1.5 right-1.5 hidden h-4 w-4 cursor-nwse-resize rounded-br border-b-2 border-r-2 border-white/70 group-hover:block"
              />
            </div>
          );
        })}
      </div>

      <div className="absolute bottom-20 left-1/2 z-10 flex -translate-x-1/2 gap-2 md:bottom-5">
        <button
          onClick={tidy}
          className="rounded-full border border-white/10 bg-[#1b1b21]/65 px-4 py-2 text-xs text-zinc-200 backdrop-blur-xl hover:border-white/30"
        >
          ✨ Tidy
        </button>
        <button
          onClick={() => {
            view.current = { x: 60, y: 60, k: 1 };
            applyView();
          }}
          className="rounded-full border border-white/10 bg-[#1b1b21]/65 px-4 py-2 text-xs text-zinc-200 backdrop-blur-xl hover:border-white/30"
        >
          Reset view
        </button>
      </div>
    </div>
  );
}
