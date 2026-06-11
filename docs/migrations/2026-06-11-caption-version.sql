-- Caption prompt versioning: v1 = original one-sentence caption, v2 = structured
-- design-vocabulary caption. backfillCaptions re-captions anything below the current
-- version so the library converges on the richer captions (and re-embeds each item).
-- Run in Supabase SQL editor (or migration tool).

alter table if exists public.items
  add column if not exists caption_v int not null default 1;

create index if not exists items_caption_v_idx
  on public.items (user_id, caption_v)
  where thumb_path is not null;
