"use client";

import { useEffect, useRef, useState } from "react";
import type { Item, Stack } from "@/lib/types";
import { saveBoardPositions, updateItem, updateStack, noteTitle, type BoardItemPos, type BoardStackPos } from "@/lib/db";
import { StackIcon, SparklesIcon, WarningIcon } from "./icons";
import { cardSurface, CARD_TINTS } from "@/lib/cardColors";
import { noteToSafeHtml, isHtmlNote, plainToHtml } from "@/lib/noteHtml";
import NoteEditor from "./NoteEditor";
import { ColumnItemsSortable, TodosSortable } from "./BoardSortables";

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
  /** Called when an item card is dropped onto a column. */
  onDropToColumn?: (item: Item, columnStackId: string) => void;
  /** Called when the × button on a column item is clicked to return it to the board. */
  onRemoveFromColumn?: (item: Item) => void;
  /** Called when column items are reordered; receives the column's stack id and new item-id order. */
  onReorderColumn?: (columnStackId: string, orderedIds: string[]) => void;
  /** A freshly-created note id to open directly in inline edit mode. */
  autoEditId?: string | null;
  /** Called once the autoEditId has been consumed so the parent can clear it. */
  onAutoEditConsumed?: () => void;
  /** Quick-add a note card into a column (the + at the column's foot). */
  onAddNoteToColumn?: (columnStackId: string, text: string) => void;
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
    const s = node as Stack;
    if (s.kind === "column") {
      if (s.collapsed) return 52;
      return Math.max(180, 60 + colCount * 72 + 48);
    }
    return w * 0.85;
  }
  const item = node as Item;
  if (item.collapsed) return 40;
  if (item.board_h != null) return item.board_h;
  if (item.type === "todo") {
    const todos = parseTodos(item.content);
    return Math.max(100, 52 + todos.length * 32 + 36);
  }
  if (item.type === "note") {
    const plainLen = (item.content ?? "").replace(/<[^>]*>/g, " ").length;
    return Math.max(100, 56 + plainLen * 0.55);
  }
  if (item.width && item.height) return (item.height / item.width) * w;
  return w * 0.75;
}

// ---- Context menu -----------------------------------------------------------
interface CtxMenu { key: string; x: number; y: number; }

export default function Board({
  items, urls, onOpen, stacks = [], stackThumbs, columnItems, onOpenStack,
  selected, onMarquee, onItemUpdate, onStackUpdate, onDropToColumn, onRemoveFromColumn, onReorderColumn,
  autoEditId, onAutoEditConsumed, onAddNoteToColumn,
}: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const view = useRef({ x: 60, y: 60, k: 1 });
  const [positions, setPositions] = useState<Map<string, Pos>>(new Map());
  // Mirror of `positions` for the layout effect to read without a stale closure.
  const positionsRef = useRef(positions);
  useEffect(() => { positionsRef.current = positions; }, [positions]);
  const [tidying, setTidying] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [band, setBand] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  // Local z-order overrides — updated optimistically before DB round-trip
  const [zOverrides, setZOverrides] = useState<Map<string, number>>(new Map());
  // Inline todo-add state: key → draft text
  const [todoInput, setTodoInput] = useState<Record<string, string>>({});
  // Inline column quick-add state: stack id → draft text
  const [colInput, setColInput] = useState<Record<string, string>>({});
  // Inline column-rename state
  const [renamingCol, setRenamingCol] = useState<string | null>(null);
  // Which note is in inline-edit mode (card key)
  const [editingNote, setEditingNote] = useState<string | null>(null);
  // Drag-lift visuals: the card currently being dragged, and the one briefly settling on release
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [settlingKey, setSettlingKey] = useState<string | null>(null);
  // Drop-to-column: track which column key is being hovered during a card drag
  const dropTargetRef = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const drag = useRef<{
    mode: "pan" | "card" | "pinch" | "resize" | "marquee" | null;
    key?: string;
    startX: number; startY: number; origX: number; origY: number; moved: boolean;
    startDist?: number; startK?: number; origW?: number; origH?: number;
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

  function toggleColumnCollapse(stack: Stack) {
    const patch = { collapsed: !stack.collapsed } as Partial<Stack>;
    updateStack(stack.id, patch).catch(() => {});
    onStackUpdate?.(stack.id, patch);
  }

  function commitColInput(stack: Stack) {
    const text = (colInput[stack.id] ?? "").trim();
    if (!text) { setColInput((c) => ({ ...c, [stack.id]: "" })); return; }
    onAddNoteToColumn?.(stack.id, text);
    setColInput((c) => ({ ...c, [stack.id]: "" }));
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
    saveTodos(item, todos);
    setTodoInput((t) => ({ ...t, [item.id]: "" }));
  }

  function saveTodos(item: Item, todos: TodoItem[]) {
    const patch = { content: JSON.stringify(todos) } as Partial<Item>;
    updateItem(item.id, patch).catch(() => {});
    onItemUpdate?.(item.id, patch);
  }
  function editTodo(item: Item, id: string, text: string) {
    const t = text.trim();
    const todos = parseTodos(item.content).flatMap((x) => x.id === id ? (t ? [{ ...x, text: t }] : []) : [x]);
    saveTodos(item, todos);
  }
  function deleteTodo(item: Item, id: string) {
    saveTodos(item, parseTodos(item.content).filter((x) => x.id !== id));
  }
  function reorderTodos(item: Item, orderedIds: string[]) {
    const map = new Map(parseTodos(item.content).map((t) => [t.id, t]));
    saveTodos(item, orderedIds.map((id) => map.get(id)!).filter(Boolean));
  }

  /** Set (or clear) a card's Milanote tint. Items only — stacks/columns keep the default surface. */
  function setCardColor(key: string, color: string | null) {
    if (key.startsWith("stk:")) return;
    updateItem(key, { card_color: color }).catch(() => {});
    onItemUpdate?.(key, { card_color: color });
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
    // Merge with what we already have so tidy/move/edit don't get clobbered when `items`
    // or `stacks` change identity. Only genuinely new keys get a fresh position.
    const prev = positionsRef.current;
    const placed = new Map(prev);
    const liveKeys = new Set(nodes.map((n) => n.key));
    for (const key of [...placed.keys()]) if (!liveKeys.has(key)) placed.delete(key);

    const isInitial = prev.size === 0;
    let maxX = 0;
    const unplaced: Node[] = [];
    for (const n of nodes) {
      if (placed.has(n.key)) { const p = placed.get(n.key)!; maxX = Math.max(maxX, p.x + p.w); continue; }
      const b = n.node;
      if (b.board_x != null && b.board_y != null) {
        placed.set(n.key, { x: b.board_x, y: b.board_y, w: b.board_w ?? CARD_W });
        maxX = Math.max(maxX, b.board_x + (b.board_w ?? CARD_W));
      } else { unplaced.push(n); }
    }
    if (unplaced.length) {
      // Bulk (first load, or a large batch) → masonry. A few new cards mid-session → drop into view.
      if (isInitial || unplaced.length > 4) {
        const auto = masonry(unplaced);
        const offsetX = maxX > 0 ? maxX + GAP * 2 : 0;
        for (const [key, p] of auto) placed.set(key, { ...p, x: p.x + offsetX });
      } else {
        const c = viewportCenterBoard();
        unplaced.forEach((n, i) => {
          const w = (n.node.board_w ?? CARD_W);
          const x = Math.round(c.x - w / 2 + i * 28), y = Math.round(c.y - 40 + i * 28);
          placed.set(n.key, { x, y, w });
          persistPos(n.key, { board_x: x, board_y: y, board_w: w }); // sticky across reloads
        });
      }
    }
    setPositions(placed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, stacks]);

  // Open a freshly-created note straight into inline edit mode.
  useEffect(() => {
    if (!autoEditId) return;
    if (items.some((i) => i.id === autoEditId && i.type === "note")) {
      setEditingNote(autoEditId);
      bringToFront(autoEditId);
      onAutoEditConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEditId, items]);

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
  function clampH(h: number) { return Math.min(1400, Math.max(60, h)); }

  /** Board-space coordinates of the current viewport centre (where new cards should land). */
  function viewportCenterBoard(): { x: number; y: number } {
    const el = wrap.current;
    const v = view.current;
    const cw = el?.clientWidth ?? 1200, ch = el?.clientHeight ?? 800;
    return { x: (cw / 2 - v.x) / v.k, y: (ch / 2 - v.y) / v.k };
  }

  /** Return the node key of a stack OR column whose bounding box contains (nx, ny), or null.
   *  Both store membership via the dropped item's stack_id, so a fan stack is a valid drop target too. */
  function findDropStack(nx: number, ny: number, dragKey: string): string | null {
    if (dragKey.startsWith("stk:")) return null; // stacks/columns can't be dropped into stacks
    for (const { key, node } of nodes) {
      if (!key.startsWith("stk:")) continue;
      const s = node as Stack;
      const p = positions.get(key);
      if (!p) continue;
      const h = cardHeight(s, p.w, columnItems?.get(s.id)?.length ?? 0);
      if (nx >= p.x && nx <= p.x + p.w && ny >= p.y && ny <= p.y + h) return key;
    }
    return null;
  }

  function clearDropTarget() {
    dropTargetRef.current = null;
    setDropTarget(null);
  }

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
      if (editingNote && editingNote !== key) setEditingNote(null);
      drag.current = { mode: "card", key, startX: e.clientX, startY: e.clientY, origX: p.x, origY: p.y, moved: false };
      setSettlingKey(null);
      setDraggingKey(key);
      bringToFront(key);
    } else if (onMarquee && (selectMode || e.shiftKey)) {
      const rect = wrap.current!.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      drag.current = { mode: "marquee", startX: x, startY: y, origX: 0, origY: 0, moved: false };
      setBand({ x1: x, y1: y, x2: x, y2: y });
    } else {
      if (editingNote) setEditingNote(null);
      drag.current = { mode: "pan", startX: e.clientX, startY: e.clientY, origX: view.current.x, origY: view.current.y, moved: false };
    }
  }

  function onResizeDown(e: React.PointerEvent, key: string) {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const p = positions.get(key);
    if (!p) return;
    const node = nodeOf(key);
    const colCount = key.startsWith("stk:") ? (columnItems?.get(key.slice(4))?.length ?? 0) : 0;
    const origH = node ? cardHeight(node, p.w, colCount) : 0;
    drag.current = { mode: "resize", key, startX: e.clientX, startY: e.clientY, origX: p.x, origY: p.y, moved: false, origW: p.w, origH };
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
      const nx = d.origX + dx / k, ny = d.origY + dy / k;
      const el = document.getElementById(`card-${d.key}`);
      if (el) el.style.transform = `translate(${nx}px, ${ny}px) scale(1.03)`;
      if (d.moved && !d.key.startsWith("stk:")) {
        const col = findDropStack(nx, ny, d.key);
        if (col !== dropTargetRef.current) { dropTargetRef.current = col; setDropTarget(col); }
      }
    } else if (d.mode === "resize" && d.key) {
      const k = view.current.k;
      const nw = clampW((d.origW ?? CARD_W) + dx / k);
      const el = document.getElementById(`card-${d.key}`);
      const node = nodeOf(d.key);
      if (el && node) {
        el.style.width = `${nw}px`;
        // Items get a free, draggable height; columns/stacks keep their derived height.
        if (!d.key.startsWith("stk:")) el.style.height = `${clampH((d.origH ?? 0) + dy / k)}px`;
      }
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
      const k = view.current.k;
      const nw = clampW((d.origW ?? CARD_W) + (e.clientX - d.startX) / k);
      const p = positions.get(d.key);
      if (p) { setPositions(new Map(positions).set(d.key, { ...p, w: nw })); }
      if (d.key.startsWith("stk:")) {
        persistPos(d.key, { board_w: nw });
      } else {
        // Items also persist a manual height so notes/cards stay the size the user dragged.
        const nh = clampH((d.origH ?? 0) + (e.clientY - d.startY) / k);
        updateItem(d.key, { board_w: nw, board_h: nh }).catch(() => {});
        onItemUpdate?.(d.key, { board_w: nw, board_h: nh });
      }
    } else if (d.mode === "card" && d.key) {
      const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
      const k = view.current.k;
      const dropped = d.key;
      setDraggingKey(null);
      if (d.moved) {
        const col = dropTargetRef.current;
        clearDropTarget();
        if (col && !dropped.startsWith("stk:")) {
          // Drop into column — snap card back then let parent remove it from the board
          const el = document.getElementById(`card-${dropped}`);
          if (el) el.style.transform = `translate(${d.origX}px, ${d.origY}px)`;
          const item = nodeOf(dropped) as Item;
          if (item) onDropToColumn?.(item, col.slice(4));
        } else {
          const nx = d.origX + dx / k, ny = d.origY + dy / k;
          const p = positions.get(dropped)!;
          setPositions(new Map(positions).set(dropped, { ...p, x: nx, y: ny }));
          persistPos(dropped, { board_x: nx, board_y: ny, board_w: p.w });
          // brief settle: animate scale-down/position into place
          setSettlingKey(dropped);
          setTimeout(() => setSettlingKey((s) => (s === dropped ? null : s)), 200);
        }
      } else {
        clearDropTarget();
        const node = nodeOf(dropped);
        if (node) {
          if (dropped.startsWith("stk:")) onOpenStack?.(node as Stack);
          else if ((node as Item).type === "note") setEditingNote(dropped);
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
          // Prefer full-res for image/site cards so larger cards stay crisp; thumb is the instant fallback.
          const fullImg = item?.storage_path ? urls.get(item.storage_path) : null;
          const cardImg = fullImg ?? thumb;
          const fan = (stack && !isColumn) ? (stackThumbs?.get(stack.id) ?? []) : [];
          const isCollapsed = item?.collapsed === true;
          const isTodo = item?.type === "todo";
          const isNote = item?.type === "note";

          return (
            <div
              key={key}
              id={`card-${key}`}
              className={`group absolute left-0 top-0 cursor-grab shadow-lg shadow-black/40 active:cursor-grabbing
                ${isColumn
                  ? "rounded-2xl border bg-[#17171c] transition-colors duration-150"
                  : stack
                  ? "rounded-xl border border-white/10 bg-[#17171c]"
                  : isNote
                  ? `rounded-xl border ${cardSurface(item!.card_color)}`
                  : `overflow-hidden rounded-xl border ${cardSurface(item!.card_color)}`}
                ${isColumn && dropTarget === key ? "border-violet-500/70 bg-violet-500/5 shadow-violet-500/20" : isColumn ? "border-white/15" : ""}
                ${stack && !isColumn && dropTarget === key ? "!border-violet-500/70 shadow-violet-500/20 ring-2 ring-violet-500/40" : ""}
                ${selected?.has(key) ? "ring-2 ring-white/80" : ""}
                ${draggingKey === key ? "!shadow-2xl !shadow-black/60" : ""}
                ${tidying || settlingKey === key ? "transition-[transform,box-shadow] duration-200 ease-out" : ""}
              `}
              style={{
                width: p.w,
                height: h,
                transform: `translate(${p.x}px, ${p.y}px)${draggingKey === key ? " scale(1.03)" : ""}`,
                zIndex: draggingKey === key ? 9999 : getZ(key),
                willChange: draggingKey === key ? "transform" : undefined,
              }}
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
                    <button
                      className="ml-1 shrink-0 text-zinc-500 hover:text-zinc-200"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); toggleColumnCollapse(stack); }}
                      title={stack.collapsed ? "Expand column" : "Minimise column"}
                    >
                      <svg className={`h-3.5 w-3.5 transition-transform ${stack.collapsed ? "-rotate-90" : ""}`} viewBox="0 0 14 14" fill="none"><path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </button>
                  </div>

                  {/* Column body (hidden when minimised) */}
                  {!stack.collapsed && (
                    <>
                      <div
                        className="flex-1 space-y-2 overflow-y-auto px-2 pb-2"
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        {colItems.length === 0 ? (
                          <div className={`grid h-16 place-items-center rounded-xl border border-dashed text-xs transition-colors duration-150 ${dropTarget === key ? "border-violet-500/50 text-violet-400" : "border-white/10 text-zinc-600"}`}>
                            {dropTarget === key ? "Release to add" : "Drop items here"}
                          </div>
                        ) : (
                          <ColumnItemsSortable
                            items={colItems}
                            urls={urls}
                            onOpen={onOpen}
                            onRemove={(ci) => onRemoveFromColumn?.(ci)}
                            onReorder={(ids) => onReorderColumn?.(stack.id, ids)}
                          />
                        )}
                      </div>
                      {/* Quick-add a note to the column */}
                      <div className="shrink-0 px-2 pb-2" onPointerDown={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-2 rounded-xl border border-dashed border-white/10 px-2.5 py-2 text-zinc-500 focus-within:border-white/25">
                          <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                          <input
                            value={colInput[stack.id] ?? ""}
                            onChange={(e) => setColInput((c) => ({ ...c, [stack.id]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitColInput(stack); } }}
                            placeholder="Add a note…"
                            className="w-full bg-transparent text-xs text-zinc-300 outline-none placeholder:text-zinc-600"
                          />
                        </div>
                      </div>
                    </>
                  )}
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
                        className={`absolute inset-0 h-full w-full select-none rounded-lg border border-white/10 object-cover object-top transition-transform duration-300 ease-out group-hover:[transform:var(--fan)] ${dropTarget === key ? "[transform:var(--fan)]" : "[transform:var(--rest)]"}`}
                        style={{ ["--rest" as string]: `rotate(${(i - 1) * 5}deg)`, ["--fan" as string]: `rotate(${(i - 1) * 12}deg) translateX(${(i - 1) * 14}px) scale(1.03)`, zIndex: i }}
                      />
                    ))}
                  </div>
                  <div className="mt-1.5 truncate text-center text-[11px] font-medium text-zinc-200">
                    <span className="flex items-center justify-center gap-1.5">
                      <StackIcon className="h-3.5 w-3.5" /> {dropTarget === key ? "Release to add" : stack.name}
                    </span>
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
                      className="flex-1 overflow-y-auto px-2 py-1.5"
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <TodosSortable
                        todos={todos}
                        onToggle={(id) => toggleTodo(item, id)}
                        onEdit={(id, text) => editTodo(item, id, text)}
                        onDelete={(id) => deleteTodo(item, id)}
                        onReorder={(ids) => reorderTodos(item, ids)}
                      />
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

              {/* ---- NOTE (rich text) ---- */}
              {item && !isCollapsed && isNote && (
                <div className="flex h-full flex-col p-3">
                  {editingNote === key ? (
                    <NoteEditor
                      html={isHtmlNote(item.content) ? item.content! : plainToHtml(item.content ?? "")}
                      autoFocus
                      cardColor={item.card_color}
                      onCardColor={(c) => setCardColor(key, c)}
                      onChange={(html) => {
                        const patch = { content: html, title: noteTitle(html) || "Note" } as Partial<Item>;
                        updateItem(key, patch).catch(() => {});
                        onItemUpdate?.(key, patch);
                      }}
                    />
                  ) : (
                    <div
                      className="note-prose note-readonly min-h-0 flex-1 overflow-hidden"
                      dangerouslySetInnerHTML={{ __html: noteToSafeHtml(item.content) }}
                    />
                  )}
                </div>
              )}

              {/* ---- IMAGE / SITE / LINK ---- */}
              {item && !isCollapsed && !isTodo && !isNote && (
                cardImg
                  ? <img src={cardImg} alt="" draggable={false} className="h-full w-full select-none object-cover object-top" />
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
          {!ctxMenu.key.startsWith("stk:") && (
            <div className="flex items-center gap-1.5 border-t border-white/10 px-3 py-2">
              {CARD_TINTS.map((t) => (
                <button
                  key={t.key}
                  title={t.label}
                  onClick={() => { setCardColor(ctxMenu.key, t.key); setCtxMenu(null); }}
                  className={`h-4 w-4 rounded-full ${t.swatch} opacity-80 hover:opacity-100`}
                />
              ))}
              <button
                title="No colour"
                onClick={() => { setCardColor(ctxMenu.key, null); setCtxMenu(null); }}
                className="grid h-4 w-4 place-items-center rounded-full border border-white/25 text-[10px] text-zinc-400 hover:text-white"
              >×</button>
            </div>
          )}
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
