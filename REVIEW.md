# Mood v2 — App Review

_Reviewed June 2026. All files read: `src/`, `extension/`, all API routes, all components, all lib utilities._

---

## 🔴 Actual Bugs

### 1. Masonry note cards render raw HTML markup as text

**File:** `src/components/Masonry.tsx`

```tsx
// current — shows "<p>Hello world</p>" literally in the card
<div className="px-4 py-5 text-sm leading-relaxed text-zinc-300">
  {(item.content ?? "").slice(0, 280)}
</div>
```

Rich-text notes created with the NoteEditor are stored as HTML (`<p>`, `<strong>`, etc.). The masonry grid card renders the raw `content` field as a React text node, so users see the HTML tags verbatim. The `noteToSafeHtml()` and `isHtmlNote()` utilities exist in `lib/noteHtml.ts` and are used everywhere else — just not here.

**Fix:**
```tsx
import { noteToSafeHtml, isHtmlNote } from "@/lib/noteHtml";

// In Card component:
} : item.type === "note" ? (
  <div
    className="note-preview px-4 py-5 text-sm leading-relaxed text-zinc-300 line-clamp-5"
    dangerouslySetInnerHTML={{ __html: noteToSafeHtml(item.content).slice(0, 600) }}
  />
```
Or strip tags first: `content.replace(/<[^>]*>/g, " ").slice(0, 280)`.

---

### 2. `apiFetch` sends `Bearer null` after session expiry

**File:** `src/lib/db.ts`

```ts
async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await authToken(); // returns string | null
  return fetch(path, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` }, // "Bearer null" 🐛
  });
}
```

If the session has expired, `authToken()` returns `null`, and the header becomes `Authorization: Bearer null`. All API calls silently get 401s back with no indication to the user that they need to re-authenticate. The auth gate never re-shows because the session state change isn't triggered.

**Fix:**
```ts
if (!token) throw new Error("Not authenticated");
```
Or redirect to sign-in. At minimum, fail loudly.

---

### 3. Quick Note in board view creates an empty note immediately

**File:** `src/app/page.tsx` + `src/components/AddMenu.tsx`

When `noteInline` is true (board view), clicking "Quick note" calls `onNote("")` immediately, which calls `addNote("", spaceId)` — creating a real DB row with title "Note" and empty content before the user has typed anything. If the user opens the menu and changes their mind, a blank note persists. There's no cancel path.

**Fix:** Don't call `onNote("")` until after the inline editor fires its first change, or show an empty editor overlay without persisting until the user types.

---

### 4. `redirect: "manual"` in `check-link` route is silently ignored

**File:** `src/app/api/check-link/route.ts`

```ts
const res = await safeFetch(url, {
  method,
  redirect: "manual", // ← no-op
  ...
});
```

`safeFetch`'s `SafeInit` type explicitly documents this field as ignored ("Following is always done by safeFetch with per-hop validation; this is ignored"). The intent was probably to avoid following redirects, but safeFetch always follows them (with its own SSRF re-validation per hop). Low impact since following redirects is actually correct for reachability checks, but the intent and behaviour diverge.

---

### 5. Board view doesn't respect type-mode tab filters

**File:** `src/app/page.tsx`

```tsx
// Grid correctly uses typedVisibleItems:
const masonryItems = currentFeedMode === "type" && selected !== "home" && !showBoard
  ? typedVisibleItems : visibleItems;

// Board always gets visibleItems — ignores the active tab:
<Board items={visibleItems} .../>
```

In a Type-mode library, switching to board view shows all items regardless of the active Foundries/Fonts/In Use tab. The tab selection is silently ignored.

---

### 6. Font review only accessible from grid, not from Home feed

**File:** `src/app/page.tsx`

```tsx
const typeScopeItems = useMemo(() => {
  if (selected === "home") return [] as Item[]; // ← always empty on Home
  ...
}, [items, selected, spaceCaptionKind]);
```

If you're on the Home feed, `fontReviewQueue` is always empty so the "Review fonts" button never appears. Users who primarily use the Home view won't see pending AI font guesses to approve.

---

## 🟡 UX Gaps

### 7. No library rename or delete

**File:** `src/components/Sidebar.tsx`

Spaces can be renamed (double-click) and deleted (× button on hover). Libraries have neither. Once created, a library can only be removed by going directly to Supabase. The sidebar has a "+ New library" button at the bottom but no management for existing ones. Right-click context menu or the same × / double-click pattern from spaces would fix this.

---

### 8. Non-image file drops are silently discarded

**File:** `src/app/page.tsx`

```ts
const images = files.filter((f) => f.type.startsWith("image/"));
if (!images.length) return; // ← silent
```

Drop a PDF, Word doc, SVG, or any non-image — nothing happens, no toast. Users can't tell if the drop failed or the app didn't register it. SVGs in particular (`image/svg+xml`) aren't caught by `startsWith("image/")` — wait, actually they are. But PDFs, videos, etc. disappear silently.

**Fix:** `if (!images.length) return toast("Only image files are supported", "error");`

---

### 9. URL input doesn't normalize bare domains

**File:** `src/components/AddMenu.tsx` → `src/app/page.tsx`

The URL input rejects anything that doesn't start with `https?://` with "That doesn't look like a URL." Typing `figma.com` or `www.behance.net` fails. A simple prefix normalization is standard in tools like this.

**Fix:** `if (!/^https?:\/\//i.test(url)) url = "https://" + url;`

---

### 10. Hard 500-item limit with no UI indicator

**File:** `src/lib/db.ts`

```ts
let q = supabase.from("items").select(ITEM_COLS).is("stack_id", null)
  .order("created_at", { ascending: false })
  .limit(500); // hardcoded
```

There's no pagination, infinite scroll, or any indicator that a library with 500+ items is being truncated. The user just silently loses access to older saves. As libraries grow, this becomes a real usability cliff.

---

### 11. AI fallback search only covers 250 items

**File:** `src/app/api/ai/search/route.ts`

```ts
const summaries = items.slice(0, 250)... // silently drops 251–500
```

The semantic (Voyage) search works library-wide via the DB. But the Gemini text-search fallback (when no Voyage key, or embeddings missing) fetches all items and then truncates to 250 before sending to the model. Items 251–500 are never considered.

---

### 12. `fetchSpaceCounts` loads up to 10,000 item rows to count them

**File:** `src/lib/db.ts`

```ts
const { data, error } = await supabase.from("items").select("space_id")
  .is("stack_id", null).limit(10000);
```

This pulls 10,000 rows (just `space_id`) every time the sidebar refreshes just to count items per space. A Postgres RPC or `select("space_id, count(*)")` with `.group()` would be dramatically cheaper and faster, especially as the library grows.

---

### 13. Stale `onAuthStateChange` listener in `db.ts`

**File:** `src/lib/db.ts`

```ts
supabase.auth.onAuthStateChange(() => urlCache.clear());
```

This module-level subscription is registered once on import but never unsubscribed. In development with hot module replacement, it accumulates duplicate listeners on each reload. In production it leaks across any re-import of the module.

---

### 14. Board positions auto-assigned for new items, but only on first render

**File:** `src/components/Board.tsx`

New items dropped into the board get an auto-placed position on first render and `persistPos()` is called immediately to write it to the DB. However, this means a freshly-added item's coordinates come from the layout algorithm at the moment the board renders — if the view is scrolled or zoomed differently between two sessions, new items land in visually odd places.

---

### 15. `handleNote("")` + board inline editor: empty note survives if user closes immediately

Covered in Bug #3 above, but worth noting the downstream: the board will auto-open the empty note in inline edit mode (`autoEditId`). If the user immediately presses Escape, the edit session ends but the empty note row persists in the DB with title "Note" and no content. There's no cleanup.

---

## 🟠 Security / Architecture Notes

### 16. `cachedUserId` in `clip/route.ts` is module-level

```ts
let cachedUserId: string | null = null;
```

Acknowledged in a comment as a single-user design decision, but module-level caches in serverless are shared across requests on the same warm instance. If this is ever used with multiple users (team plan etc.), it would serve the wrong user ID. Worth pinning this with a build-time assertion or a guard.

---

### 17. `meta/route.ts` HTML parsing is regex-based and fragile

The `metaTag()` regex only handles two attribute orderings: `property/name` before `content`, or after. Multi-line tags, extra attributes, or quote types outside `"` and `'` will silently return null. Titles with entities like `&nbsp;` or `&copy;` won't decode (the `decodeEntities` function only handles 6 entities). This leads to garbled or missing link card titles for some sites.

---

### 18. `isAuthed()` makes an outbound Supabase call on every authenticated API request

**File:** `src/app/api/_lib/auth.ts`

Every API request (caption, embed, meta, proxy-image, capture, check-link) makes a full HTTP round-trip to Supabase to validate the JWT. For a single-user app this is fine, but it adds ~80–150ms latency to every API call and burns Supabase bandwidth. JWT verification can be done locally using the Supabase JWT secret without any outbound call.

---

## 🟢 Minor / Low Impact

### 19. `decodeEntities()` handles only 6 HTML entities

**File:** `src/app/api/meta/route.ts`

`&nbsp;`, `&copy;`, `&eacute;`, and hundreds of other named entities aren't decoded. Page titles with these will have literal entity strings in link card titles (e.g., "H&amp;M" → shown correctly, but "Société" → `Soci&eacute;t&eacute;` if the site uses named entities).

---

### 20. Rate limiter is per-serverless-instance

**File:** `src/app/api/_lib/ratelimit.ts`

Commented and acknowledged. Under Vercel Fluid Compute with multiple concurrent instances, the effective rate limit is `limit × instances`. Fine for personal use; becomes meaningless under any real traffic.

---

### 21. `process.env.VERCEL` detection in `capture.ts` is fragile

The Puppeteer launch path detects Vercel by checking `process.env.VERCEL`. Vercel doesn't guarantee this env var will always exist in all runtimes. The fake Lambda env vars set inline (`AWS_LAMBDA_FUNCTION_NAME` etc.) work today but are a workaround against a specific undocumented Chromium behaviour.

---

### 22. `fontGuessConfidence()` uses hard-coded arbitrary values

```ts
if (provider === "ai") return 0.58;
if (provider) return 0.93;
return 0.72;
```

These numbers are invented, not empirically derived. The "58%" displayed in the Review Fonts panel implies more precision than exists.

---

### 23. Extension `popup.js` / `background.js` not reviewed for security

The Chrome extension in `/extension/` sends images and pages to `/api/clip` with the `MOOD_CLIP_TOKEN`. If the token leaks (e.g., via extension storage inspection), an attacker can clip arbitrary content into the account. The rate limit of 30/min/IP is the only backstop. Consider binding the token to a Supabase session instead.

---

## Summary Table

| # | Severity | Area | Issue |
|---|----------|------|-------|
| 1 | 🔴 Bug | Masonry | HTML notes show raw markup in grid |
| 2 | 🔴 Bug | Auth/API | `Bearer null` sent after session expiry |
| 3 | 🔴 Bug | Board/UX | Quick note creates empty DB row immediately |
| 4 | 🔴 Bug | API | `redirect: "manual"` no-op in check-link |
| 5 | 🔴 Bug | Board | Type tabs ignored in board view |
| 6 | 🔴 Bug | Type mode | Font review inaccessible from Home feed |
| 7 | 🟡 Gap | Sidebar | No library rename/delete |
| 8 | 🟡 Gap | Drop/Paste | Non-image files silently dropped |
| 9 | 🟡 Gap | Add URL | Bare domain URLs rejected without suggestion |
| 10 | 🟡 Gap | Scale | 500-item limit invisible to user |
| 11 | 🟡 Gap | AI Search | Fallback search covers only 250 items |
| 12 | 🟡 Perf | DB | Count query loads 10k rows |
| 13 | 🟡 Leak | DB | Auth listener never unsubscribed |
| 14 | 🟡 UX | Board | Auto-position uses first-render layout only |
| 16 | 🟠 Arch | Clip API | Module-level userId cache |
| 17 | 🟠 Arch | Meta API | Regex HTML parsing, incomplete entity decoding |
| 18 | 🟠 Perf | Auth | JWT validated via outbound HTTP on every request |
| 19 | 🟢 Minor | Meta | Limited entity decoding |
| 20 | 🟢 Minor | Ratelimit | Per-instance limit |
| 21 | 🟢 Minor | Capture | Vercel env detection fragile |
| 22 | 🟢 Minor | Type | Hard-coded font confidence values |
| 23 | 🟢 Minor | Extension | Clip token not bound to session |
