"use client";

import { useState } from "react";
import QRCode from "qrcode";
import type { Library, Space } from "@/lib/types";
import { createLibrary, createSpace, renameSpace, deleteSpace } from "@/lib/db";
import { supabase, authToken } from "@/lib/supabase";
import { ask, confirmDialog, notice } from "./ui";

interface Props {
  libraries: Library[];
  spaces: Space[];
  selected: string | "all" | "home";
  counts: Map<string, number>;
  onSelect: (id: string | "all" | "home") => void;
  onChanged: () => void;
  onClose?: () => void;
}

export default function Sidebar({ libraries, spaces, selected, counts, onSelect, onChanged, onClose }: Props) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [qr, setQr] = useState<{ img: string; link: string } | null>(null);
  const [qrBusy, setQrBusy] = useState(false);

  async function phoneSignIn() {
    setQrBusy(true);
    try {
      let to = window.location.origin;
      if (/localhost|127\.0\.0\.1/.test(to)) {
        const v = await ask({
          title: "Where should your phone open?",
          initial: "https://mood-opal.vercel.app",
          placeholder: "https://…",
          confirmLabel: "Create link",
        });
        if (!v) return;
        to = v;
      }
      const token = await authToken();
      const res = await fetch(`/api/login-link?to=${encodeURIComponent(to)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const out = await res.json();
      if (!res.ok) {
        await notice({ title: "Couldn't create link", body: out.error ?? "Unknown error" });
        return;
      }
      const img = await QRCode.toDataURL(out.link, { width: 480, margin: 1 });
      setQr({ img, link: out.link });
    } finally {
      setQrBusy(false);
    }
  }

  async function addSpace(libraryId: string) {
    const name = await ask({ title: "New space", placeholder: "e.g. Client moodboard", confirmLabel: "Create" });
    if (!name) return;
    await createSpace(libraryId, name);
    onChanged();
  }

  async function addLibrary() {
    const name = await ask({ title: "New library", placeholder: "e.g. Personal", confirmLabel: "Create" });
    if (!name) return;
    await createLibrary(name);
    onChanged();
  }

  async function commitRename(id: string) {
    if (renameVal.trim()) await renameSpace(id, renameVal.trim());
    setRenaming(null);
    onChanged();
  }

  async function removeSpace(s: Space) {
    const ok = await confirmDialog({
      title: `Delete “${s.name}”?`,
      body: "Everything inside will be permanently deleted.",
      danger: true,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    await deleteSpace(s.id);
    if (selected === s.id) onSelect("all");
    onChanged();
  }

  const row = (active: boolean) =>
    `group flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
      active ? "bg-white/10 text-white" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
    }`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pb-2 pt-5">
        <div className="text-lg font-semibold tracking-tight">Mood</div>
        {onClose && (
          <button onClick={onClose} className="rounded-lg p-1 text-zinc-500 hover:text-zinc-200 md:hidden">
            ✕
          </button>
        )}
      </div>

      <div className="no-scrollbar flex-1 overflow-y-auto px-2 pb-4">
        <button className={row(selected === "home")} onClick={() => onSelect("home")}>
          <span>✨ Home</span>
          <span className="text-[10px] text-zinc-700">feed</span>
        </button>
        <button className={row(selected === "all")} onClick={() => onSelect("all")}>
          <span>Everything</span>
          <span className="text-xs text-zinc-600">{counts.get("all") ?? ""}</span>
        </button>

        {libraries.map((lib) => (
          <div key={lib.id} className="mt-4">
            <div className="flex items-center justify-between px-3 pb-1">
              <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">{lib.name}</span>
              <button
                onClick={() => addSpace(lib.id)}
                title="New space"
                className="rounded px-1 text-zinc-600 hover:text-zinc-300"
              >
                +
              </button>
            </div>
            {spaces
              .filter((s) => s.library_id === lib.id)
              .map((s) => (
                <div key={s.id} className={row(selected === s.id)}>
                  {renaming === s.id ? (
                    <input
                      autoFocus
                      value={renameVal}
                      onChange={(e) => setRenameVal(e.target.value)}
                      onBlur={() => commitRename(s.id)}
                      onKeyDown={(e) => e.key === "Enter" && commitRename(s.id)}
                      className="w-full bg-transparent text-sm outline-none"
                    />
                  ) : (
                    <button
                      className="flex-1 truncate text-left"
                      onClick={() => onSelect(s.id)}
                      onDoubleClick={() => {
                        setRenaming(s.id);
                        setRenameVal(s.name);
                      }}
                    >
                      {s.kind === "inbox" ? "📥 " : ""}
                      {s.name}
                    </button>
                  )}
                  <span className="flex items-center gap-1">
                    <span className="text-xs text-zinc-600">{counts.get(s.id) ?? ""}</span>
                    {s.kind !== "inbox" && (
                      <button
                        onClick={() => removeSpace(s)}
                        className="hidden rounded px-1 text-zinc-600 hover:text-red-400 group-hover:block"
                        title="Delete space"
                      >
                        ✕
                      </button>
                    )}
                  </span>
                </div>
              ))}
          </div>
        ))}

        <button
          onClick={addLibrary}
          className="mt-4 w-full rounded-lg px-3 py-1.5 text-left text-sm text-zinc-600 hover:bg-white/5 hover:text-zinc-300"
        >
          + New library
        </button>
      </div>

      <div className="border-t border-white/5 p-3">
        <button
          onClick={phoneSignIn}
          disabled={qrBusy}
          className="w-full rounded-lg px-3 py-1.5 text-left text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
        >
          {qrBusy ? "Creating link…" : "📱 Sign in on phone"}
        </button>
        <button
          onClick={() => supabase.auth.signOut()}
          className="w-full rounded-lg px-3 py-1.5 text-left text-xs text-zinc-600 hover:text-zinc-300"
        >
          Sign out
        </button>
      </div>

      {qr && (
        <div className="fixed inset-0 z-50 grid place-items-center" onClick={() => setQr(null)}>
          <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" />
          <div
            className="relative z-10 w-[min(360px,92vw)] rounded-2xl border border-white/10 bg-[#141418]/85 p-5 shadow-2xl backdrop-blur-2xl text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 text-sm font-medium text-zinc-200">Sign in on your phone</div>
            <div className="mb-3 text-[11px] text-zinc-500">
              Scan with the iPhone camera. One-time link, expires in about an hour.
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr.img} alt="Sign-in QR code" className="mx-auto w-full max-w-[260px] rounded-xl bg-white p-2" />
            <div className="mt-3 flex justify-center gap-2">
              <button
                onClick={() => navigator.clipboard.writeText(qr.link)}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 hover:border-white/25"
              >
                Copy link (AirDrop it instead)
              </button>
              <button onClick={() => setQr(null)} className="rounded-lg px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-200">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
