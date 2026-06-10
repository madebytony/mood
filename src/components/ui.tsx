"use client";

import { useEffect, useRef, useState } from "react";

/* ---------- imperative dialogs (replaces prompt/confirm/alert) ---------- */

interface PromptOpts {
  title: string;
  placeholder?: string;
  initial?: string;
  confirmLabel?: string;
}
interface ConfirmOpts {
  title: string;
  body?: string;
  danger?: boolean;
  confirmLabel?: string;
}
interface NoticeOpts {
  title: string;
  body?: string;
}

type Req =
  | ({ kind: "prompt"; resolve: (v: string | null) => void } & PromptOpts)
  | ({ kind: "confirm"; resolve: (v: boolean) => void } & ConfirmOpts)
  | ({ kind: "notice"; resolve: () => void } & NoticeOpts);

let pushReq: ((r: Req) => void) | null = null;

export function ask(opts: PromptOpts): Promise<string | null> {
  return new Promise((resolve) => (pushReq ? pushReq({ kind: "prompt", resolve, ...opts }) : resolve(null)));
}
export function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => (pushReq ? pushReq({ kind: "confirm", resolve, ...opts }) : resolve(false)));
}
export function notice(opts: NoticeOpts): Promise<void> {
  return new Promise((resolve) => (pushReq ? pushReq({ kind: "notice", resolve, ...opts }) : resolve()));
}

export function DialogHost() {
  const [req, setReq] = useState<Req | null>(null);
  const [val, setVal] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    pushReq = (r) => {
      setVal(r.kind === "prompt" ? r.initial ?? "" : "");
      setReq(r);
    };
    return () => {
      pushReq = null;
    };
  }, []);

  useEffect(() => {
    if (req?.kind === "prompt") setTimeout(() => inputRef.current?.select(), 30);
  }, [req]);

  if (!req) return null;

  function finish(result?: unknown) {
    const r = req!;
    setReq(null);
    if (r.kind === "prompt") r.resolve((result as string | null) ?? null);
    else if (r.kind === "confirm") r.resolve(Boolean(result));
    else r.resolve();
  }
  const cancel = () => finish(req.kind === "confirm" ? false : null);
  const confirm = () => finish(req.kind === "prompt" ? val.trim() || null : true);

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center" onClick={cancel}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="card-in relative z-10 w-full max-w-sm rounded-t-2xl border border-white/10 bg-[#17171c]/80 p-5 shadow-2xl backdrop-blur-2xl pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:rounded-2xl sm:pb-5"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") confirm();
          if (e.key === "Escape") cancel();
        }}
      >
        <div className="text-sm font-medium text-zinc-100">{req.title}</div>
        {"body" in req && req.body && (
          <div className="mt-1.5 text-xs leading-relaxed text-zinc-500">{req.body}</div>
        )}
        {req.kind === "prompt" && (
          <input
            ref={inputRef}
            autoFocus
            value={val}
            onChange={(e) => setVal(e.target.value)}
            placeholder={req.placeholder}
            className="mt-3 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm outline-none placeholder:text-zinc-600 focus:border-white/30"
          />
        )}
        <div className="mt-4 flex justify-end gap-2">
          {req.kind !== "notice" && (
            <button onClick={cancel} className="rounded-xl px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200">
              Cancel
            </button>
          )}
          <button
            onClick={confirm}
            className={`rounded-xl px-4 py-2 text-sm font-medium ${
              req.kind === "confirm" && req.danger
                ? "bg-red-600 text-white hover:bg-red-500"
                : "bg-white text-black hover:bg-zinc-200"
            }`}
          >
            {("confirmLabel" in req && req.confirmLabel) ||
              (req.kind === "confirm" ? "Confirm" : req.kind === "prompt" ? "Save" : "OK")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- skeleton loading ---------- */

const HEIGHTS = [180, 240, 150, 300, 210, 260, 170, 230, 280, 160, 250, 200];

export function SkeletonGrid({ count = 12 }: { count?: number }) {
  return (
    <div className="columns-2 gap-3 px-3 pb-24 sm:columns-3 lg:columns-4 xl:columns-5 2xl:columns-6">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="mb-3 animate-pulse rounded-xl bg-white/[0.05]"
          style={{ breakInside: "avoid", height: HEIGHTS[i % HEIGHTS.length] }}
        />
      ))}
    </div>
  );
}
