-- Hygiene bookkeeping: when each row was last liveness/image-checked, so passes rotate
-- through the corpus oldest-first instead of re-checking the same rows.
-- Run in Supabase SQL editor (or migration tool).

alter table public.web_corpus add column if not exists checked_at timestamptz;
create index if not exists web_corpus_checked_idx on public.web_corpus (checked_at nulls first);
