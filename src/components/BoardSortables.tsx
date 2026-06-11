"use client";

import { useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Item } from "@/lib/types";
import { cardSurface } from "@/lib/cardColors";

export interface TodoItem { id: string; text: string; done: boolean; }

function GripHandle({ listeners, attributes }: { listeners?: DraggableSyntheticListeners; attributes?: DraggableAttributes }) {
  return (
    <button
      {...attributes}
      {...listeners}
      onClick={(e) => e.stopPropagation()}
      className="grid h-5 w-4 shrink-0 cursor-grab touch-none place-items-center text-zinc-600 opacity-0 transition-opacity hover:text-zinc-300 group-hover/row:opacity-100 active:cursor-grabbing"
      title="Drag to reorder"
    >
      <svg viewBox="0 0 10 16" className="h-3.5 w-2.5" fill="currentColor">
        <circle cx="2" cy="3" r="1.2" /><circle cx="8" cy="3" r="1.2" />
        <circle cx="2" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" />
        <circle cx="2" cy="13" r="1.2" /><circle cx="8" cy="13" r="1.2" />
      </svg>
    </button>
  );
}

// ---- Column items ----------------------------------------------------------

function ColumnRow({ ci, thumb, onOpen, onRemove }: {
  ci: Item; thumb: string | null; onOpen: (i: Item) => void; onRemove: (i: Item) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: ci.id });
  const tint = ci.card_color ? cardSurface(ci.card_color) : "border-white/8 bg-white/[0.03]";
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group/row relative flex items-stretch gap-1 ${isDragging ? "z-10 opacity-80" : ""}`}
    >
      <div className="flex items-center pt-1.5"><GripHandle listeners={listeners} attributes={attributes} /></div>
      <button
        className={`min-w-0 flex-1 overflow-hidden rounded-xl border text-left hover:brightness-110 ${isDragging ? "border-violet-400/50 shadow-lg shadow-black/40" : tint}`}
        onClick={() => onOpen(ci)}
      >
        {thumb && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" className="h-20 w-full object-cover object-top" />
        )}
        <div className="px-2.5 py-2">
          <div className="truncate text-xs font-medium text-zinc-200">{ci.title ?? ci.source_domain ?? ci.type}</div>
          {ci.content && !thumb && (
            <div className="mt-0.5 line-clamp-2 text-[11px] text-zinc-400">{ci.content.replace(/<[^>]*>/g, " ").slice(0, 100)}</div>
          )}
        </div>
      </button>
      <button
        className="absolute right-1.5 top-1.5 hidden h-5 w-5 place-items-center rounded-full bg-black/70 text-zinc-400 backdrop-blur hover:text-white group-hover/row:grid"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onRemove(ci); }}
        title="Remove from column"
      >
        <svg className="h-2.5 w-2.5" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}

export function ColumnItemsSortable({ items, urls, onOpen, onRemove, onReorder }: {
  items: Item[];
  urls: Map<string, string>;
  onOpen: (i: Item) => void;
  onRemove: (i: Item) => void;
  onReorder: (orderedIds: string[]) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  function handleEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = items.map((i) => i.id);
    const next = arrayMove(ids, ids.indexOf(active.id as string), ids.indexOf(over.id as string));
    onReorder(next);
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleEnd}>
      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-2">
          {items.map((ci) => (
            <ColumnRow key={ci.id} ci={ci} thumb={ci.thumb_path ? urls.get(ci.thumb_path) ?? null : null} onOpen={onOpen} onRemove={onRemove} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

// ---- Todo items ------------------------------------------------------------

function TodoRow({ t, onToggle, onEdit, onDelete }: {
  t: TodoItem; onToggle: (id: string) => void; onEdit: (id: string, text: string) => void; onDelete: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: t.id });
  const [editing, setEditing] = useState(false);
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group/row flex items-start gap-1 rounded-lg px-1 py-1 hover:bg-white/5 ${isDragging ? "z-10 bg-white/10 opacity-90" : ""}`}
    >
      <div className="flex items-center pt-0.5"><GripHandle listeners={listeners} attributes={attributes} /></div>
      <input
        type="checkbox"
        checked={t.done}
        onChange={() => onToggle(t.id)}
        className="mt-0.5 shrink-0 cursor-pointer accent-violet-500"
      />
      {editing ? (
        <input
          autoFocus
          defaultValue={t.text}
          onBlur={(e) => { onEdit(t.id, e.currentTarget.value); setEditing(false); }}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setEditing(false); }}
          className="min-w-0 flex-1 rounded bg-white/10 px-1 text-xs text-zinc-100 outline-none"
        />
      ) : (
        <span
          onClick={() => setEditing(true)}
          className={`min-w-0 flex-1 cursor-text text-xs leading-snug ${t.done ? "text-zinc-600 line-through" : "text-zinc-300"}`}
        >
          {t.text}
        </span>
      )}
      <button
        className="hidden shrink-0 text-zinc-600 hover:text-zinc-300 group-hover/row:block"
        onClick={() => onDelete(t.id)}
        title="Delete task"
      >
        <svg className="h-3 w-3" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}

export function TodosSortable({ todos, onToggle, onEdit, onDelete, onReorder }: {
  todos: TodoItem[];
  onToggle: (id: string) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  function handleEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = todos.map((t) => t.id);
    const next = arrayMove(ids, ids.indexOf(active.id as string), ids.indexOf(over.id as string));
    onReorder(next);
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleEnd}>
      <SortableContext items={todos.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-0.5">
          {todos.map((t) => (
            <TodoRow key={t.id} t={t} onToggle={onToggle} onEdit={onEdit} onDelete={onDelete} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
