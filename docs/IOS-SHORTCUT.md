# "Send to Mood" — iOS Shortcut (one-time setup, ~3 minutes)

This gives you share-sheet saving on iPhone: share any image or page → pick a space → done.
You need the app deployed to Vercel first (the Shortcut needs a public URL).

Replace `https://YOUR-APP.vercel.app` and `YOUR_TOKEN` (the `MOOD_CLIP_TOKEN` value from `.env.local`) below.

1. Open **Shortcuts** on iPhone → **+** to create a new shortcut.
2. Tap the ⓘ info button → enable **Show in Share Sheet** → set accepted types to **Images, URLs, Safari web pages**.
3. Add these actions in order:

   1. **Get Contents of URL**
      - URL: `https://YOUR-APP.vercel.app/api/clip`
      - Method: **GET**
      - Headers: `Authorization` = `Bearer YOUR_TOKEN`
   2. **Get Dictionary from Input** (input: Contents of URL)
   3. **Get Dictionary Value** — Get **Value** for **spaces**
   4. **Choose from List** (input: Dictionary Value) — prompt: "Save to…"
      - This shows your spaces. (It displays raw entries; choosing works fine.)
   5. **Get Dictionary Value** — Get **Value** for **id** in **Chosen Item**
   6. **If** → **Shortcut Input** → **has any value** → (nothing needed, continue)
   7. **Get Contents of URL** (the actual save)
      - URL: `https://YOUR-APP.vercel.app/api/clip`
      - Method: **POST**
      - Headers: `Authorization` = `Bearer YOUR_TOKEN`
      - Request Body: **JSON**:
        - `kind` (Text): `image` if you shared an image, `page` if you shared a URL
          (simplest: make two shortcuts, "Image to Mood" with `image` + `url` = Shortcut Input,
           and "Page to Mood" with `page` + `url` = Shortcut Input)
        - `url` (Text): **Shortcut Input**
        - `space_id` (Text): the **Dictionary Value** from step 5
   8. **Show Notification** — "Saved to Mood ✓"

4. Name it **Send to Mood**, done. It now appears in every share sheet.

Tip: a simpler one-tap variant — skip steps 1–6 and POST with only `kind` + `url`.
Everything lands in your Inbox and you file it from the Inbox triage view later.
