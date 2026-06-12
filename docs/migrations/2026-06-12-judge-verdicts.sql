-- Judge rulings are signal, not exhaust: persist every verdict so (a) "Find more" never
-- re-judges a candidate already ruled out for this reference, (b) score distributions can
-- calibrate retrieval floors, (c) high scorers become co-curation signal later.
-- Run in Supabase SQL editor (or migration tool).

create table if not exists public.judge_verdicts (
  id uuid primary key default gen_random_uuid(),
  ref_key text not null,            -- "item:<uuid>" or "space:<uuid>"
  domain text not null,
  url text,
  score int not null,               -- composite 0-10 (palette-gated)
  axes jsonb,                       -- {palette, typography, layout, mood} raw axis scores
  why text,
  created_at timestamptz not null default now(),
  unique (ref_key, domain)
);

create index if not exists judge_verdicts_ref_idx on public.judge_verdicts (ref_key, score);

alter table public.judge_verdicts enable row level security;
drop policy if exists judge_verdicts_read on public.judge_verdicts;
create policy judge_verdicts_read on public.judge_verdicts for select to authenticated using (true);
-- writes: service role only
