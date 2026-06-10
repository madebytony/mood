"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready) {
    return <div className="h-dvh grid place-items-center text-zinc-500">Loading…</div>;
  }

  if (session) return <>{children}</>;

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (error) setErr(error.message);
    else setSent(true);
  }

  return (
    <div className="h-dvh grid place-items-center px-6">
      <div className="card-in w-full max-w-sm rounded-3xl border border-white/10 bg-white/[0.04] p-8 shadow-2xl shadow-black/50 backdrop-blur-2xl backdrop-saturate-150">
        <div className="mb-8 text-center">
          <div className="text-3xl font-semibold tracking-tight">Mood</div>
          <div className="mt-2 text-sm text-zinc-500">
            Design inspiration, everywhere.
          </div>
        </div>
        {sent ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center text-sm text-zinc-300">
            Magic link sent — check your inbox, then open the link on this device.
          </div>
        ) : (
          <form onSubmit={sendLink} className="space-y-3">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm outline-none placeholder:text-zinc-600 focus:border-white/30"
            />
            <button
              disabled={busy}
              className="w-full rounded-xl bg-white px-4 py-3 text-sm font-medium text-black hover:bg-zinc-200 disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send magic link"}
            </button>
            {err && <div className="text-center text-xs text-red-400">{err}</div>}
          </form>
        )}
      </div>
    </div>
  );
}
