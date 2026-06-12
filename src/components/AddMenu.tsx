"use client";

import { useEffect, useRef, useState } from "react";

import { PhotoIcon, LinkIcon, CameraIcon, PencilIcon, ColumnIcon, CheckSquareIcon } from "./icons";
import { useDialog } from "./useDialog";

interface Props {
  onFiles: (files: File[]) => void;
  onUrl: (url: string) => void;
  onCapture: (url: string) => void;
  onNote: (text: string) => void;
  /** When true (board view), "Quick note" creates an empty note to edit inline rather than a compose box. */
  noteInline?: boolean;
  onColumn?: (name: string) => void;
  onTodo?: (title: string) => void;
  /** Increment to open the menu from outside (mobile tab bar). */
  openTick?: number;
}

type Mode = "menu" | "url" | "capture" | "note" | "column" | "todo";

export default function AddMenu({ onFiles, onUrl, onCapture, onNote, noteInline, onColumn, onTodo, openTick }: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("menu");
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (openTick) setOpen(true);
  }, [openTick]);

  const panelRef = useDialog<HTMLDivElement>(() => close(), { active: open });

  function close() {
    setOpen(false);
    setMode("menu");
    setText("");
  }

  function submit() {
    const v = text.trim();
    if (!v) return;
    if (mode === "url") onUrl(v);
    if (mode === "capture") onCapture(v);
    if (mode === "note") onNote(v);
    if (mode === "column") onColumn?.(v);
    if (mode === "todo") onTodo?.(v);
    close();
  }

  const itemBtn = "flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm text-zinc-200 hover:bg-white/10";

  const placeholders: Partial<Record<Mode, string>> = {
    url: "https://…",
    capture: "https://site-to-screenshot.com",
    note: "Jot an idea…",
    column: "Column name…",
    todo: "List title…",
  };

  const labels: Partial<Record<Mode, string>> = {
    capture: "Capture",
    column: "Create column",
    todo: "Create list",
  };

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onFiles(files);
          e.target.value = "";
          close();
        }}
      />

      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-5 z-30 hidden h-14 w-14 place-items-center rounded-full bg-white text-2xl text-black shadow-lg shadow-black/50 transition-transform hover:scale-105 active:scale-95 md:grid"
        title="Add to Mood"
      >
        +
      </button>

      {open && (
        <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center" onClick={close}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Add to Mood"
            tabIndex={-1}
            className="relative z-10 w-full max-w-md glass-dark rounded-t-2xl p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:rounded-2xl outline-none"
            onClick={(e) => e.stopPropagation()}
          >
            {mode === "menu" && (
              <div className="space-y-1">
                <button className={itemBtn} onClick={() => fileRef.current?.click()}>
                  <PhotoIcon className="h-5 w-5 text-zinc-400" /> Photos / files
                </button>
                <button className={itemBtn} onClick={() => setMode("url")}>
                  <LinkIcon className="h-5 w-5 text-zinc-400" /><span>Paste a URL <span className="text-zinc-500">— save as a bookmark</span></span>
                </button>
                <button className={itemBtn} onClick={() => setMode("capture")}>
                  <CameraIcon className="h-5 w-5 text-zinc-400" /><span>Capture a site <span className="text-zinc-500">— full-page screenshot</span></span>
                </button>
                <button
                  className={itemBtn}
                  onClick={() => { if (noteInline) { onNote(""); close(); } else setMode("note"); }}
                >
                  <PencilIcon className="h-5 w-5 text-zinc-400" /> Quick note
                </button>
                {onColumn && (
                  <button className={itemBtn} onClick={() => setMode("column")}>
                    <ColumnIcon className="h-5 w-5 text-zinc-400" /><span>Column <span className="text-zinc-500">— vertical card list</span></span>
                  </button>
                )}
                {onTodo && (
                  <button className={itemBtn} onClick={() => setMode("todo")}>
                    <CheckSquareIcon className="h-5 w-5 text-zinc-400" /><span>To-do list <span className="text-zinc-500">— tasks with checkboxes</span></span>
                  </button>
                )}
              </div>
            )}
            {mode !== "menu" && (
              <div className="space-y-2 p-1">
                {mode === "note" ? (
                  <textarea
                    autoFocus
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={4}
                    placeholder="Jot an idea…"
                    className="w-full resize-none rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm outline-none focus:border-white/30"
                  />
                ) : (
                  <input
                    autoFocus
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && submit()}
                    placeholder={placeholders[mode] ?? ""}
                    className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm outline-none focus:border-white/30"
                  />
                )}
                <div className="flex justify-end gap-2">
                  <button onClick={close} className="rounded-xl px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200">
                    Cancel
                  </button>
                  <button onClick={submit} className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-black hover:bg-zinc-200">
                    {labels[mode] ?? "Add"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
