"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  onFiles: (files: File[]) => void;
  onUrl: (url: string) => void;
  onCapture: (url: string) => void;
  onNote: (text: string) => void;
  /** Increment to open the menu from outside (mobile tab bar). */
  openTick?: number;
}

export default function AddMenu({ onFiles, onUrl, onCapture, onNote, openTick }: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"menu" | "url" | "capture" | "note">("menu");
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (openTick) setOpen(true);
  }, [openTick]);

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
    close();
  }

  const itemBtn = "w-full rounded-xl px-4 py-3 text-left text-sm text-zinc-200 hover:bg-white/10";

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
        className="fixed bottom-6 right-5 z-30 hidden h-14 w-14 place-items-center rounded-full bg-violet-600 text-2xl text-white shadow-lg shadow-violet-900/40 transition-transform hover:scale-105 active:scale-95 md:grid"
        title="Add to Mood"
      >
        +
      </button>

      {open && (
        <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center" onClick={close}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div
            className="relative z-10 w-full max-w-md rounded-t-2xl border border-white/10 bg-[#17171c] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {mode === "menu" && (
              <div className="space-y-1">
                <button className={itemBtn} onClick={() => fileRef.current?.click()}>
                  🖼️ &nbsp;Photos / files
                </button>
                <button className={itemBtn} onClick={() => setMode("url")}>
                  🔗 &nbsp;Paste a URL <span className="text-zinc-500">— image or link card</span>
                </button>
                <button className={itemBtn} onClick={() => setMode("capture")}>
                  📸 &nbsp;Capture a site <span className="text-zinc-500">— full-page screenshot</span>
                </button>
                <button className={itemBtn} onClick={() => setMode("note")}>
                  ✏️ &nbsp;Quick note
                </button>
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
                    className="w-full resize-none rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm outline-none focus:border-violet-500/50"
                  />
                ) : (
                  <input
                    autoFocus
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && submit()}
                    placeholder={mode === "capture" ? "https://site-to-screenshot.com" : "https://…"}
                    className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm outline-none focus:border-violet-500/50"
                  />
                )}
                <div className="flex justify-end gap-2">
                  <button onClick={close} className="rounded-xl px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200">
                    Cancel
                  </button>
                  <button onClick={submit} className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500">
                    {mode === "capture" ? "Capture" : "Add"}
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
