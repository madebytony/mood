import { createClient } from "@supabase/supabase-js";
import { bearer } from "../_lib/auth";

/**
 * Mint a one-time sign-in link for your phone — no email needed.
 * Requires BOTH a real signed-in session (not the clip token) and the
 * service-role key on the server.
 */
export async function GET(req: Request) {
  const token = bearer(req);
  if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });

  // verify a real user session (deliberately NOT accepting the clip token here)
  const u = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });
  if (!u.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { email } = await u.json();
  if (!email) return Response.json({ error: "no email on session" }, { status: 400 });

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    return Response.json({ error: "SUPABASE_SERVICE_ROLE_KEY not configured" }, { status: 503 });
  }
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const sp = new URL(req.url).searchParams;
  const to = sp.get("to");
  const redirectTo = to && /^https?:\/\//.test(to) ? to : new URL(req.url).origin;

  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo },
  });
  if (error || !data?.properties?.action_link) {
    return Response.json({ error: error?.message ?? "could not generate link" }, { status: 502 });
  }
  return Response.json({ link: data.properties.action_link });
}
