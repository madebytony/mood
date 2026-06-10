# Mood v2 — full build (Phases 1–5)

Private Pinterest for best-in-class design. Next.js PWA + Supabase + Claude.

## What's inside

- **Home feed** — fresh design-led suggestions from leading galleries (siteinspire, httpster,
  minimal.gallery, godly, land-book, dark.design) ranked by Claude against your taste profile,
  blended with resurfaced gems from your own library. Search box = design brief
  ("brutalist e-commerce") → live web-searched, curated results. 👍/👎/Save feed your taste.
- **Capture**: drag/drop · paste (⌘V) · photo picker · URL → link card · **full-page site
  capture** (cookie banners dismissed, sticky headers frozen) · **Chrome extension** with
  Pinterest-style hover-to-save + right-click save + page capture · **iOS Shortcut** (docs/).
- **AI**: every image is auto-captioned + auto-tagged on import (Haiku, ~£0.001 each).
  ✨ button = AI search over meaning, not just words.
- **Board view**: toggle any space grid ⇄ board. Pan (drag), zoom (pinch / ⌘+scroll),
  drag cards anywhere, ✨ Tidy re-flows into clean columns. Positions sync.
- **Colour intelligence**: palette + light/dark extracted on import; colour swatch filter row;
  "More like this" rail on every item (tags + colours + source).
- **Inbox triage**: hover any Inbox card → "File →" → pick a space.

## Setup

1. `.env.local` — two keys to add:
   - `ANTHROPIC_API_KEY` — from console.anthropic.com (enables captions, AI search, Discover ranking; everything else works without it)
   - `SUPABASE_SERVICE_ROLE_KEY` — Supabase dashboard → Project Settings → API keys (needed only by the extension / iOS Shortcut endpoint)
2. Run: `bash start.command` (always safe to re-run; installs new deps automatically)

## Chrome extension

1. `chrome://extensions` → Developer mode → **Load unpacked** → select the `extension/` folder.
2. Click the extension icon → set app URL (`http://localhost:3000` or your Vercel URL)
   and paste your `MOOD_CLIP_TOKEN` from `.env.local`.
3. Hover any image on any page → **Save to Mood**. Right-click → save image / capture page.

## Deploy to Vercel

```bash
npx vercel
```

- Add ALL env vars from `.env.local` in Vercel project settings.
- Supabase dashboard → Authentication → URL Configuration: set Site URL + Redirect URL to your Vercel URL.
- `vercel.json` includes a daily cron ping that keeps the free Supabase project awake.
- iPhone: open the Vercel URL in Safari → Share → Add to Home Screen. Then set up docs/IOS-SHORTCUT.md.

## Not included (deliberately)

v1's image variations, offline write-queue, Figma bridge — see ../MOOD-V2-PLAN.md Phase 5 notes.
