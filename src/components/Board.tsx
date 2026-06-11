"use client";

import { useEffect, useRef, useState } from "react";
import type { Item, Stack } from "@/lib/types";
import { saveBoardPositions, updateItem, updateStack, type BoardItemPos, type BoardStackPos } from "@/lib/db";
import { StackIcon, SparklesIcon, WarningIcon } from "./icons";

interface Props {
  items: Item[];
  urls: Map<string, string>;
  onOpen: (item: Item) => void;
  stacks?: Stack[];
  stackThumbs?: Map<string, string[]>;
  /** Full items inside column-type stacks, keyed by stack_id. */
  columnItems?: Map<string, Item[]>;
  onOpenStack?: (s: Stack) => void;
  selected?: Set<string>;
  onMarquee?: (ids: string[], additive: boolean) => void;
  /** Called after local optimistic update so parent state stays in sync. */
  onItemUpdate?: (id: string, patch: Partial<Item>) => void;
  onStackUpdate?: (id: string, patch: Partial<Stack>) => void;
}

const CARD_W = 260;
const GAP = 56;

interface Pos { x: number; y: number; w: number; }

interface TodoItem { id: string; text: string; done: boolean; }
function parseTodos(c: string | null): TodoItem[] {
  try { return JSON.parse(c ?? "[]"); } catch { return []; }
}

function cardHeight(node: Item | Stack, w: number, colCount = 0): number {
  if (!("width" in node)) {
    if ((node as Stack).kind === "column") return Math.max(180, 60 + colCount * 72 + 48);
    return w * 0.85;
  }
  const item = node as Item;
  if (item.collapsed) return 40;
  if (item.type === "todo") {
    const todos = parseTodos(item.content);
    return Math.max(100, 52 + todos.length * 32 + 36);
  }
  if (item.type === "note") return Math.max(100, 56 + (item.content?.length ?? 0) * 0.4);
  if (item.width && item.height) return (item.height / item.width) * w;
  return w * 0.75;
}

// ---- Markdown inline renderer ------------------------------------------------
function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith("*") && p.endsWith("*")) return <em key={i}>{p.slice(1, -1)}</em>;
    return <span key={i}>{p}</span>;
  });
}

function MarkdownContent({ text }: { text: string }) {
  const lines = (text ?? "").split("\n");
  return (
    <div className="space-y-0.5 text-xs leading-relaxed text-zinc-300">
      {lines.map((line, i) => {
        if (/^#{1,2}\s/.test(line)) {
          const t = line.replace(/^#+\s/, "");
          return <p key={i} className="font-semibold text-zinc-100">{renderInline(t)}</p>;
        }
        if (/^[-*]\s/.test(line)) {
          return (
            <div key={i} className="flex gap-1.5">
              <span className="mt-0.5 shrink-0 text-zinc-500">•</span>
              <span>{renderInline(line.slice(2))}</span>
            </div>
          );
        }
        if (!line.trim()) return <div key={i} className="h-1.5" />;
        return <p key={i}>{renderInline(line)}</p>;
      })}
    </div>
  );
}

// ---- Context menu -----------------------------------------------------------
interface CtxMenu { key: string; x: number; y: number; }

export default function Board({
  items, urls, onOpen, stacks = [], stackThumbs, columnItems, onOpenStack,
  selected, onMarquee, onItemUpdate, onStackUpdate,
}: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const view = useRef({ x: 60, y: 60, k: 1 });
  const [positions, setPositions] = useState<Map<string, Pos>>(new Map());
  const [tidying, setTidying] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [band, setBand] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  // Local z-order overrides — updated optimistically before DB round-trip
  const [zOverrides, setZOverrides] = useState<Map<string, number>>(new Map());
  // Inline todo-add state: key → draft text
  const [todoInput, setTodoInput] = useState<Record<string, string>>({});
  // Inline column-rename state
  const [renamingCol, setRenamingCol] = useState<string | null>(null);

  const drag = useRef<{
    mode: "pan" | "card" | "pinch" | "resize" | "marquee" | null;
    key?: string;
    startX: number; startY: number; origX: number; origY: number; moved: boolean;
    startDist?: number; startK?: number; origW?: number;
  }>({ mode: null, startX: 0, startY: 0, origX: 0, origY: 0, moved: false });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const velSample = useRef<{ x: number; y: number; t: number } | null>(null);
  const vel = useRef({ vx: 0, vy: 0 });
  const momentumRaf = useRef(0);

  function startMomentum() {
    cancelAnimationFrame(momentumRaf.current);
    let { vx, vy } = vel.current;
    if (Math.abs(vx) + Math.abs(vy) < 2) return;
    let last = performance.now();
    const step = (t: number) => {
      const f = Math.min(3, (t - last) / 16.7); last = t;
      view.current.x += vx * f; view.current.y += vy * f;
      vx *= Math.pow(0.93, f); vy *= Math.pow(0.93, f);
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

  function getZ(key: string): number {
    if (zOverrides.has(key)) return zOverrides.get(key)!;
    const n = nodes.find((x) => x.key === key)?.node;
    return (n as { board_z?: number | null } | undefined)?.board_z ?? 0;
  }

  function bringToFront(key: string) {
    const maxZ = Math.max(0, ...nodes.map((n) => getZ(n.key)));
    const z = maxZ + 1;
    setZOverrides((m) => new Map(m).set(key, z));
    if (key.startsWith("stk:")) { updateStack(key.slice(4), { board_z: z }).catch(() => {}); onStackUpdate?.(key.slice(4), { board_z: z }); }
    else { updateItem(key, { board_z: z }).catch(() => {}); onItemUpdate?.(key, { board_z: z }); }
  }

  function sendToBack(key: string) {
    const minZ = Math.min(0, ...nodes.map((n) => getZ(n.key)));
    const z = minZ - 1;
    setZOverrides((m) => new Map(m).set(key, z));
    if (key.startsWith("stk:")) { updateStack(key.slice(4), { board_z: z }).catch(() => {}); onStackUpdate?.(key.slice(4), { board_z: z }); }
    else { updateItem(key, { board_z: z }).catch(() => {}); onItemUpdate?.(key, { board_z: z }); }
  }

  function toggleCollapse(item: Item) {
    const patch = { collapsed: !item.collapsed } as Partial<Item>;
    updateItem(item.id, patch).catch(() => {});
    onItemUpdate?.(item.id, patch);
  }

  function toggleTodo(item: Item, todoId: string) {
    const todos = parseTodos(item.content).map((t) => t.id === todoId ? { ...t, done: !t.done } : t);
    const patch = { content: JSON.stringify(todos) } as Partial<Item>;
    updateItem(item.id, patch).catch(() => {});
    onItemUpdate?.(item.id, patch);
  }

  function commitTodoInput(item: Item) {
    const text = (todoInput[item.id] ?? "").trim();
    if (!text) { setTodoInput((t) => ({ ...t, [item.id]: "" })); return; }
    const todos = [...parseTodos(item.content), { id: crypto.randomUUID(), text, done: false }];
    const patch = { content: JSON.stringify(todos) } as Partial<Item>;
    updateItem(item.id, patch).catch(() => {});
    onItemUpdate?.(item.id, patch);
    setTodoInput((t) => ({ ...t, [item.id]: "" }));
  }

  function persistPos(key: string, patch: { board_x?: number; board_y?: number; board_w?: number }) {
    if (key.startsWith("stk:")) updateStack(key.slice(4), patch).catch(() => {});
    else updateItem(key, patch).catch(() => {});
  }

  function masonry(list: Node[], cols = 4): Map<string, Pos> {
    const heights = new Array(cols).fill(0);
    const out = new Map<string, Pos>();
    for (const { key, node } of list) {
      const c = heights.indexOf(Math.min(...heights));
      const colCount = key.startsWith("stk:") ? (columnItems?.get((node as Stack).id)?.length ?? 0) : 0;
      out.set(key, { x: c * (CARD_W + GAP), y: heights[c], w: CARD_W });
      heights[c] += cardHeight(node, CARD_W, colCount) + GAP;
    }
    return out;
  }

  function idsInBand(b: { x1: number; y1: number; x2: number; y2: number }): string[] {
    const left = Math.min(b.x1, b.x2), right = Math.max(b.x1, b.x2);
    const top = Math.min(b.y1, b.y2), bottom = Math.max(b.y1, b.y2);
    const v = view.current;
    return nodes
      .filter(({ key, node }) => {
        if (key.startsWith("stk:")) return false;
        const p = positions.get(key);
        if (!p) return false;
        const cx = v.x + p.x * v.k, cy = v.y + p.y * v.k;
        const cw = p.w * v.k, ch = cardHeight(node, p.w) * v.k;
        return cx < right && cx + cw > left && cy < bottom && cy + ch > top;
      })
      .map(({ key }) => key);
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
      } else { unplaced.push(n); }
    }
    const auto = masonry(unplaced);
    const offsetX = maxX > 0 ? maxX + GAP * 2 : 0;
    for (const [key, p] of auto) placed.set(key, { ...p, x: p.x + offsetX });
    setPositions(placed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, stacks]);

  function applyView() {
    if (layer.current) {
      const v = view.current;
      layer.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
    }
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
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const k2 = Math.min(2.5, Math.max(0.2, v.k * Math.exp(-e.deltaY * 0.01)));
        v.x = mx - ((mx - v.x) / v.k) * k2; v.y = my - ((my - v.y) / v.k) * k2; v.k = k2;
      } else { v.x -= e.deltaX; v.y -= e.deltaY; }
      applyView();
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  function clampW(w: number) { return Math.min(900, Math.max(140, w)); }

  function onPointerDown(e: React.PointerEvent, key?: string) {
    cancelAnimationFrame(momentumRaf.current);
    vel.current = { vx: 0, vy: 0 };
    velSample.current = { x: e.clientX, y: e.clientY, t: performance.now() };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      drag.current = { mode: "pinch", startX: (a.x + b.x) / 2, startY: (a.y + b.y) / 2, origX: view.current.x, origY: view.current.y, moved: true, startDist: Math.hypot(a.x - b.x, a.y - b.y), startK: view.current.k };
      return;
    }
    if (key) {
      const p = positions.get(key);
      if (!p) return;
      drag.current = { mode: "card", key, startX: e.clientX, startY: e.clientY, origX: p.x, origY: p.y, moved: false };
    } else if (onMarquee && (selectMode || e.shiftKey)) {
      const rect = wrap.current!.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      drag.current = { mode: "marquee", startX: x, startY: y, origX: 0, origY: 0, moved: false };
      setBand({ x1: x, y1: y, x2: x, y2: y });
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
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const rect = wrap.current!.getBoundingClientRect();
      v.x = (cx - rect.left) - (((cx - rect.left) - v.x) / v.k) * k2;
      v.y = (cy - rect.top) - (((cy - rect.top) - v.y) / v.k) * k2;
      v.k = k2; applyView(); return;
    }
    if (d.mode === "marquee") {
      const rect = wrap.current!.getBoundingClientRect();
      setBand((b) => (b ? { ...b, x2: e.clientX - rect.left, y2: e.clientY - rect.top } : b));
      return;
    }
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    if (d.mode === "pan") {
      view.current.x = d.origX + dx; view.current.y = d.origY + dy;
      const s = velSample.current; const now = performance.now();
      if (s && now - s.t > 0) { const dt = (now - s.t) / 16.7; vel.current = { vx: (e.clientX - s.x) / dt, vy: (e.clientY - s.y) / dt }; }
      velSample.current = { x: e.clientX, y: e.clientY, t: now }; applyView();
    } else if (d.mode === "card" && d.key) {
      const k = view.current.k;
      const el = document.getElementById(`card-${d.key}`);
      if (el) el.style.transform = `translate(${d.origX + dx / k}px, ${d.origY + dy / k}px)`;
    } else if (d.mode === "resize" && d.key) {
      const k = view.current.k;
      const nw = clampW((d.origW ?? CARD_W) + dx / k);
      const el = document.getElementById(`card-${d.key}`);
      const node = nodeOf(d.key);
      const colCount = d.key.startsWith("stk:") ? (columnItems?.get(d.key.slice(4))?.length ?? 0) : 0;
      if (el && node) { el.style.width = `${nw}px`; el.style.height = `${cardHeight(node, nw, colCount)}px`; }
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    const d = drag.current;
    if (d.mode === "marquee") {
      const b = band; setBand(null);
      drag.current = { mode: null, startX: 0, startY: 0, origX: 0, origY: 0, moved: false };
      if (b && (Math.abs(b.x2 - b.x1) > 4 || Math.abs(b.y2 - b.y1) > 4)) onMarquee?.(idsInBand(b), e.shiftKey);
      return;
    }
    if (d.mode === "resize" && d.key) {
      const nw = clampW((d.origW ?? CARD_W) + (e.clientX - d.startX) / view.current.k);
      const p = positions.get(d.key);
      if (p) { setPositions(new Map(positions).set(d.key, { ...p, w: nw })); persistPos(d.key, { board_w: nw }); }
    } else if (d.mode === "card" && d.key) {
      const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
      const k = view.current.k;
      if (d.moved) {
        const nx = d.origX + dx / k, ny = d.origY + dy / k;
        const p = positions.get(d.key)!;
        setPositions(new Map(positions).set(d.key, { ...p, x: nx, y: ny }));
        persistPos(d.key, { board_x: nx, board_y: ny, board_w: p.w });
      } else {
        const node = nodeOf(d.key);
        if (node) {
          bringToFront(d.key);
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
      const pa = positions.get(a.key), pb = positions.get(b.key);
      const ra = Math.round((pa?.y ?? 0) / 400), rb = Math.round((pb?.y ?? 0) / 400);
      return ra - rb || (pa?.x ?? 0) - (pb?.x ?? 0);
    });
    const next = masonry(ordered);
    setPositions(next);
    const itemRows: BoardItemPos[] = [], stackRows: BoardStackPos[] = [];
    for (const { key, node } of nodes) {
      const p = next.get(key); if (!p) continue;
      if (key.startsWith("stk:")) {
        const s = node as Stack;
        stackRows.push({ id: s.id, user_id: s.user_id, space_id: s.space_id, name: s.name, created_at: s.created_at, board_x: p.x, board_y: p.y, board_w: p.w });
      } else {
        const it = node as Item;
        itemRows.push({ id: it.id, user_id: it.user_id, space_id: it.space_id, type: it.type, created_at: it.created_at, board_x: p.x, board_y: p.y, board_w: p.w });
      }
    }
    await saveBoardPositions(itemRows, stackRows).catch(() => {});
    setTimeout(() => setTidying(false), 400);
  }

  // Sort by z-order for render — lower z behind, higher z in front
  const sortedNodes = [...nodes].sort((a, b) => getZ(a.key) - getZ(b.key));

  return (
    <div
      ref={wrap}
      className={`relative h-full touch-none overflow-hidden bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.05)_1px,transparent_0)] [background-size:28px_28px] ${selectMode ? "cursor-crosshair" : ""}`}
      onPointerDown={(e) => onPointerDown(e)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={() => setCtxMenu(null)}
    >
      <div ref={layer} className="absolute left-0 top-0 origin-top-left" style={{ transform: "translate(60px,60px)" }}>
        {sortedNodes.map(({ key, node }) => {
          const p = positions.get(key);
          if (!p) return null;
          const isStack = key.startsWith("stk:");
          const item = isStack ? null : (node as Item);
          const stack = isStack ? (node as Stack) : null;
          const isColumn = stack?.kind === "column";
          const colItems = isColumn ? (columnItems?.get(stack!.id) ?? []) : [];
          const h = cardHeight(node, p.w, colItems.length);
          const thumb = item?.thumb_path ? urls.get(item.thumb_path) : null;
          const fan = (stack && !isColumn) ? (stackThumbs?.get(stack.id) ?? []) : [];
          const isCollapsed = item?.collapsed === true;
          const isTodo = item?.type === "todo";
          const isNote = item?.type === "note";

          return (
            <div
              key={key}
              id={`card-${key}`}
              className={`group absolute left-0 top-0 cursor-grab bg-[#17171c] shadow-lg shadow-black/40 active:cursor-grabbing
                ${isColumn
                  ? "rounded-2xl border border-white/15"
                  : stack
                  ? "rounded-xl border border-white/10"
                  : "overflow-hidden rounded-xl border border-white/10"}
                ${selected?.has(key) ? "ring-2 ring-white/80" : ""}
                ${tidying ? "transition-transform duration-300" : ""}
              `}
              style={{ width: p.w, height: h, transform: `translate(${p.x}px, ${p.y}px)`, zIndex: getZ(key) }}
              onPointerDown={(e) => { e.stopPropagation(); onPointerDown(e, key); }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ key, x: e.clientX, y: e.clientY }); }}
            >
              {/* ---- COLUMN ---- */}
              {isColumn && stack && (
                <div className="flex h-full flex-col">
                  {/* Column header */}
                  <div className="flex shrink-0 items-center justify-between px-3 pt-3 pb-2">
                    {renamingCol === stack.id ? (
                      <input
                        autoFocus
                        defaultValue={stack.name}
                        className="flex-1 rounded-lg bg-white/10 px-2 py-0.5 text-sm font-semibold text-zinc-100 outline-none"
                        onBlur={(e) => {
                          const name = e.currentTarget.value.trim() || stack.name;
                          updateStack(stack.id, { name }).catch(() => {});
                          onStackUpdate?.(stack.id, { name });
                          setRenamingCol(null);
                        }}
                        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setRenamingCol(null); }}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <button
                        className="flex-1 truncate text-left text-sm font-semibold text-zinc-100"
                        onPointerDown={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => { e.stopPropagation(); setRenamingCol(stack.id); }}
                      >
                        {stack.name}
                      </button>
                    )}
                    <span className="ml-2 shrink-0 rounded-full bg-white/8 px-1.5 py-0.5 text-[10px] text-zinc-500">{colItems.length}</span>
                  </div>

                  {/* Column body */}
                  <div
                    className="flex-1 space-y-2 overflow-y-auto px-2 pb-2"
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    {colItems.length === 0 && (
                      <div className="grid h-16 place-items-center rounded-xl border border-dashed border-white/10 text-xs text-zinc-600">
                        Drop items here
                      </div>
                    )}
                    {colItems.map((ci) => {
                      const ciThumb = ci.thumb_path ? urls.get(ci.thumb_path) : null;
                      return (
                        <button
                          key={ci.id}
                          className="w-full overflow-hidden rounded-xl border border-white/8 bg-white/[0.03] text-left hover:bg-white/[0.06]"
                          onClick={() => onOpen(ci)}
                        >
                          {ciThumb && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={ciThumb} alt="" className="h-20 w-full object-cover object-top" />
                          )}
                          <div className="px-2.5 py-2">
                            <div className="truncate text-xs font-medium text-zinc-200">
                              {ci.title ?? ci.source_domain ?? ci.type}
                            </div>
                            {ci.content && !ciThumb && (
                              <div className="mt-0.5 line-clamp-2 text-[11px] text-zinc-500">{ci.content.slice(0, 100)}</div>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ---- STACK (fan) ---- */}
              {stack && !isColumn && (
                <div className="relative h-full w-full p-3">
                  <div className="relative h-[calc(100%-1.6rem)] w-full">
                    {fan.length === 0 ? (
                      <div className="grid h-full w-full place-items-center rounded-lg bg-white/5">
                        <StackIcon className="h-8 w-8 text-zinc-600" />
                      </div>
                    ) : fan.map((t, i) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={t} src={t} alt="" draggable={false}
                        className="absolute inset-0 h-full w-full select-none rounded-lg border border-white/10 object-cover object-top transition-transform duration-300 ease-out [transform:var(--rest)] group-hover:[transform:var(--fan)]"
                        style={{ ["--rest" as string]: `rotate(${(i - 1) * 5}deg)`, ["--fan" as string]: `rotate(${(i - 1) * 12}deg) translateX(${(i - 1) * 14}px) scale(1.03)`, zIndex: i }}
                      />
                    ))}
                  </div>
                  <div className="mt-1.5 truncate text-center text-[11px] font-medium text-zinc-200">
                    <span className="flex items-center justify-center gap-1.5"><StackIcon className="h-3.5 w-3.5" /> {stack.name}</span>
                  </div>
                </div>
              )}

              {/* ---- COLLAPSED item ---- */}
              {item && isCollapsed && (
                <div className="flex h-full items-center gap-2 px-3">
                  <span className="flex-1 truncate text-xs font-medium text-zinc-300">
                    {item.title ?? item.source_domain ?? item.type}
                  </span>
                  <button
                    className="shrink-0 text-zinc-600 hover:text-zinc-300"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); toggleCollapse(item); }}
                    title="Expand"
                  >
                    <svg className="h-3.5 w-3.5" viewBox="0 0 14 14" fill="none"><path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </button>
                </div>
              )}

              {/* ---- TODO ---- */}
              {item && !isCollapsed && isTodo && (() => {
                const todos = parseTodos(item.content);
                const done = todos.filter((t) => t.done).length;
                return (
                  <div className="flex h-full flex-col">
                    <div className="flex shrink-0 items-center gap-2 border-b border-white/8 px-3 py-2.5">
                      <span className="flex-1 truncate text-xs font-semibold text-zinc-100">{item.title ?? "Tasks"}</span>
                      <span className="text-[10px] text-zinc-600">{done}/{todos.length}</span>
                    </div>
                    <div
                      className="flex-1 space-y-0.5 overflow-y-auto px-2 py-1.5"
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      {todos.map((t) => (
                        <label key={t.id} className="flex cursor-pointer items-start gap-2 rounded-lg px-1 py-1 hover:bg-white/5">
                          <input
                            type="checkbox"
                            checked={t.done}
                            onChange={() => toggleTodo(item, t.id)}
                            className="mt-0.5 shrink-0 cursor-pointer accent-violet-500"
                          />
                          <span className={`text-xs leading-snug ${t.done ? "text-zinc-600 line-through" : "text-zinc-300"}`}>{t.text}</span>
                        </label>
                      ))}
                    </div>
                    <div className="shrink-0 border-t border-white/8 px-2 py-1.5" onPointerDown={(e) => e.stopPropagation()}>
                      <input
                        value={todoInput[item.id] ?? ""}
                        onChange={(e) => setTodoInput((t) => ({ ...t, [item.id]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitTodoInput(item); } }}
                        placeholder="Add task…"
                        className="w-full rounded-lg bg-transparent px-1 py-0.5 text-xs text-zinc-400 outline-none placeholder:text-zinc-700 focus:text-zinc-200"
                      />
                    </div>
                  </div>
                );
              })()}

              {/* ---- NOTE (markdown) ---- */}
              {item && !isCollapsed && isNote && (
                <div className="flex h-full flex-col overflow-hidden p-3">
                  {item.title && (
                    <div className="mb-1.5 shrink-0 truncate text-xs font-semibold text-zinc-100">{item.title}</div>
                  )}
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <MarkdownContent text={item.content ?? ""} />
                  </div>
                </div>
              )}

              {/* ---- IMAGE / SITE / LINK ---- */}
              {item && !isCollapsed && !isTodo && !isNote && (
                thumb
                  ? <img src={thumb} alt="" draggable={false} className="h-full w-full select-none object-cover object-top" />
                  : <div className="h-full w-full p-3 text-xs leading-relaxed text-zinc-300">{(item.content ?? item.title ?? item.source_domain ?? "").slice(0, 200)}</div>
              )}

              {/* ---- Overlays (collapse button, dead-link badge, resize handle) ---- */}
              {item && !isCollapsed && (
                <button
                  className="absolute right-1.5 top-1.5 hidden h-5 w-5 place-items-center rounded-full bg-black/60 text-zinc-400 backdrop-blur hover:text-white group-hover:grid"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); toggleCollapse(item); }}
                  title="Minimise"
                >
                  <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none"><path d="M2 8l4-4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
              )}

              {item?.dead_link && (
                <div title="Link may be dead" className="absolute left-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-amber-500/90 text-black shadow">
                  <WarningIcon className="h-3.5 w-3.5" />
                </div>
              )}

              {!isColumn && (
                <div
                  onPointerDown={(e) => { e.stopPropagation(); onResizeDown(e, key); }}
                  title="Drag to resize"
                  className="absolute bottom-1.5 right-1.5 hidden h-4 w-4 cursor-nwse-resize rounded-br border-b-2 border-r-2 border-white/70 group-hover:block"
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Rubber-band selection */}
      {band && (
        <div
          className="pointer-events-none absolute z-20 rounded border border-white/70 bg-white/10"
          style={{ left: Math.min(band.x1, band.x2), top: Math.min(band.y1, band.y2), width: Math.abs(band.x2 - band.x1), height: Math.abs(band.y2 - band.y1) }}
        />
      )}

      {/* Context menu */}
      {ctxMenu && (
        <div
          className="fixed z-50 min-w-[140px] overflow-hidden rounded-xl border border-white/10 bg-[#1e1e26] py-1 shadow-xl"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button className="w-full px-3 py-2 text-left text-xs text-zinc-200 hover:bg-white/10"
            onClick={() => { bringToFront(ctxMenu.key); setCtxMenu(null); }}>
            Bring to front
          </button>
          <button className="w-full px-3 py-2 text-left text-xs text-zinc-200 hover:bg-white/10"
            onClick={() => { sendToBack(ctxMenu.key); setCtxMenu(null); }}>
            Send to back
          </button>
        </div>
      )}

      {/* Board toolbar */}
      <div className="absolute bottom-20 left-1/2 z-10 flex -translate-x-1/2 gap-2 md:bottom-5">
        {onMarquee && (
          <button
            onClick={() => setSelectMode((m) => !m)}
            title="Drag empty space to select (or hold Shift)"
            className={`rounded-full border px-4 py-2 text-xs backdrop-blur-xl ${
              selectMode ? "border-white/40 bg-white/15 text-white" : "border-white/10 bg-[#1b1b21]/65 text-zinc-200 hover:border-white/30"
            }`}
          >
            {selectMode ? "Select ✓" : "Select"}
          </button>
        )}
        <button onClick={tidy} className="rounded-full border border-white/10 bg-[#1b1b21]/65 px-4 py-2 text-xs text-zinc-200 backdrop-blur-xl hover:border-white/30">
          <span className="flex items-center gap-1.5"><SparklesIcon className="h-3.5 w-3.5" /> Tidy</span>
        </button>
        <button
          onClick={() => { view.current = { x: 60, y: 60, k: 1 }; applyView(); }}
          className="rounded-full border border-white/10 bg-[#1b1b21]/65 px-4 py-2 text-xs text-zinc-200 backdrop-blur-xl hover:border-white/30"
        >
          Reset view
        </button>
      </div>
    </div>
  );
}
