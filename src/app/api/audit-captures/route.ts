import { createClient } from "@supabase/supabase-js";
import { bearer, isClipToken } from "../_lib/auth";
import { captureScreenshot, imageFlatStats, launchBrowser, looksFlat, screenshotRejected, thumShot, type FlatStats } from "../_lib/capture";
import { extFor, imageDims, sha1hex } from "../_lib/image";
import { assertPublicUrl } from "../_lib/ssrf";
import { clientIp, rateLimit, tooManyRequests } from "../_lib/ratelimit";

export const maxDuration = 300; // each re-capture is a full Puppeteer run; fix a small batch per call

/** Captions written off a poisoned screenshot describe the transient state, not the site. */
const BAD_CAPTION =
  /\b404\b|page not found|not found page|error page|page (?:could not|cannot|can't) be (?:found|loaded)|load(?:ing|er) (?:screen|spinner|state|page|animation|indicator|overlay|bar)|preload(?:er|ing)|splash screen|progress (?:bar|indicator)|cookie (?:consent|banner|notice|policy|wall)|consent (?:banner|dialog|overlay|modal)|captcha|access denied|security verification|verif(?:y|ication|ying)|cloudflare|just a moment|blank (?:page|screen|white|dark)/i;

function admin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

interface AuditItem {
  id: string;
  type: string;
  title: string | null;
  source_url: string | null;
  source_domain: string | null;
  storage_path: string | null;
  thumb_path: string | null;
  ai_caption: string | null;
}

interface Flagged {
  id: string;
  title: string | null;
  source_domain: string | null;
  source_url: string | null;
  reasons: string[];
  caption?: string;
  flat?: FlatStats;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchCandidates(db: any, domains: string[] | null, ids: string[] | null, limit: number): Promise<AuditItem[]> {
  let q = db
    .from("items")
    .select("id,type,title,source_url,source_domain,storage_path,thumb_path,ai_caption")
    .eq("type", "site")
    .not("source_url", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (ids?.length) q = q.in("id", ids);
  if (domains?.length) q = q.in("source_domain", domains);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as AuditItem[];
}

/** Flag captures that look like flat/loading screens or whose caption describes one.
 *  One shared browser does all the histogramming; pass null to skip the pixel check. */
async function flagItems(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  items: AuditItem[],
  checkPixels: boolean
): Promise<Flagged[]> {
  const flagged: Flagged[] = [];
  let browser = null;
  try {
    for (const it of items) {
      const reasons: string[] = [];
      let flat: FlatStats | undefined;
      if (it.ai_caption && BAD_CAPTION.test(it.ai_caption)) reasons.push("caption");
      const path = it.thumb_path ?? it.storage_path;
      if (checkPixels && path) {
        const { data: blob } = await db.storage.from("media").download(path);
        if (blob) {
          browser ??= await launchBrowser();
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const stats = await imageFlatStats(browser, bytes, blob.type || "image/jpeg");
          if (looksFlat(stats)) {
            reasons.push("flat");
            flat = stats ?? undefined;
          }
        }
      }
      if (reasons.length) {
        flagged.push({
          id: it.id,
          title: it.title,
          source_domain: it.source_domain,
          source_url: it.source_url,
          reasons,
          caption: it.ai_caption?.slice(0, 160),
          flat,
        });
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return flagged;
}

function params(req: Request) {
  const sp = new URL(req.url).searchParams;
  const domains = sp.get("domains")?.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean) ?? null;
  const limit = Math.min(parseInt(sp.get("limit") ?? "300") || 300, 1000);
  return { domains, limit };
}

/** GET /api/audit-captures?domains=aesop.com,umbrel.com&limit=300 — dry-run report. */
export async function GET(req: Request) {
  if (!isClipToken(bearer(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const rl = rateLimit(`audit:${clientIp(req)}`, 10, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfter);
  const db = admin();
  if (!db) return Response.json({ error: "service key missing" }, { status: 503 });
  try {
    const { domains, limit } = params(req);
    const items = await fetchCandidates(db, domains, null, limit);
    const flagged = await flagItems(db, items, true);
    return Response.json({ scanned: items.length, flagged });
  } catch (e) {
    console.error("audit GET failed:", e);
    return Response.json({ error: "audit failed" }, { status: 502 });
  }
}

/** POST /api/audit-captures { ids?: string[], domains?: string[], limit?: number }
 *  Re-captures flagged items (or exactly `ids` when given) with the hardened pipeline.
 *  Only swaps the image in when the new shot isn't itself flat; clears ai_caption,
 *  caption_v and embedding so the app's background pipeline re-captions + re-embeds. */
export async function POST(req: Request) {
  if (!isClipToken(bearer(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const rl = rateLimit(`audit-fix:${clientIp(req)}`, 5, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfter);
  const db = admin();
  if (!db) return Response.json({ error: "service key missing" }, { status: 503 });

  let body: { ids?: string[]; domains?: string[]; limit?: number } = {};
  try {
    body = await req.json();
  } catch {}

  const started = Date.now();
  const results: { id: string; url: string | null; ok: boolean; note: string }[] = [];
  let analyzer = null;
  try {
    const limit = Math.min(body.limit ?? 25, 100);
    const items = await fetchCandidates(db, body.domains ?? null, body.ids ?? null, body.ids?.length ?? 300);
    // explicit ids are trusted as-is; otherwise re-capture only what the audit flags
    const targets = body.ids?.length
      ? items
      : (await flagItems(db, items, true)).slice(0, limit).map((f) => items.find((i) => i.id === f.id)!).filter(Boolean);

    for (const it of targets.slice(0, limit)) {
      // leave ~50s headroom: a single capture can take that long, and a half-finished
      // batch with clean results beats a function timeout mid-upload
      if (Date.now() - started > (maxDuration - 50) * 1000) {
        results.push({ id: it.id, url: it.source_url, ok: false, note: "skipped: time budget" });
        continue;
      }
      if (!it.source_url) {
        results.push({ id: it.id, url: null, ok: false, note: "no source_url" });
        continue;
      }
      try {
        await assertPublicUrl(it.source_url);
        let shot = await captureScreenshot(it.source_url, false);
        analyzer ??= await launchBrowser();
        let stats = await imageFlatStats(analyzer, shot.bytes, shot.type);
        if (looksFlat(stats) && shot.engine === "chromium") {
          // bot walls that block headless Chrome often wave thum.io's renderer through
          const alt = await thumShot(it.source_url, false).catch(() => null);
          if (alt) {
            const altStats = await imageFlatStats(analyzer, alt.bytes, alt.type);
            if (!looksFlat(altStats)) {
              alt.fonts = shot.fonts;
              alt.tech = shot.tech;
              shot = alt;
              stats = altStats;
            }
          }
        }
        if (looksFlat(stats)) {
          results.push({ id: it.id, url: it.source_url, ok: false, note: `recapture still flat (top ${stats?.top.toFixed(2)})` });
          continue;
        }
        const rejected = await screenshotRejected(shot.bytes, shot.type);
        if (rejected) {
          results.push({ id: it.id, url: it.source_url, ok: false, note: `recapture rejected: looks like a ${rejected} page` });
          continue;
        }
        const ext = extFor(shot.type);
        const dims = imageDims(shot.bytes, shot.type);
        const hash = await sha1hex(shot.bytes);
        const path = `media/${hash}.${ext}`;
        const up = await db.storage.from("media").upload(path, shot.bytes, { upsert: true, contentType: shot.type });
        if (up.error) throw up.error;
        const { error } = await db
          .from("items")
          .update({
            storage_path: path,
            thumb_path: path,
            width: dims.w,
            height: dims.h,
            // JSON.stringify drops undefined keys, so an empty sniff keeps the existing values
            fonts: shot.fonts?.length ? shot.fonts : undefined,
            tech: shot.tech?.length ? shot.tech : undefined,
            dead_link: false,
            ai_caption: null,
            caption_v: 0, // below CAPTION_VERSION -> the app's background pass re-captions

            embedding: null,
          })
          .eq("id", it.id);
        if (error) throw error;
        // drop the poisoned image unless another item shares it (uploads dedupe by content hash)
        const old = it.storage_path;
        if (old && old !== path) {
          const [a, b] = await Promise.all([
            db.from("items").select("id", { count: "exact", head: true }).eq("storage_path", old),
            db.from("items").select("id", { count: "exact", head: true }).eq("thumb_path", old),
          ]);
          if (!a.count && !b.count) await db.storage.from("media").remove([old]).catch(() => {});
        }
        results.push({ id: it.id, url: it.source_url, ok: true, note: `recaptured via ${shot.engine} -> ${path}` });
      } catch (e) {
        const msg = (e as Error).message ?? "capture failed";
        // hard 404/410/5xx from the hardened capture: the page is gone, mark it instead of retrying forever
        if (/^page returned HTTP/.test(msg)) {
          await db.from("items").update({ dead_link: true }).eq("id", it.id);
        }
        results.push({ id: it.id, url: it.source_url, ok: false, note: msg });
      }
    }
    return Response.json({ fixed: results.filter((r) => r.ok).length, results });
  } catch (e) {
    console.error("audit POST failed:", e);
    return Response.json({ error: "audit fix failed", results }, { status: 502 });
  } finally {
    if (analyzer) await analyzer.close().catch(() => {});
  }
}
