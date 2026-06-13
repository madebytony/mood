-- Core-table Row Level Security — codify the app's ENTIRE authorization model.
--
-- Why this exists: the browser talks to Postgres directly with the public anon key
-- (src/lib/supabase.ts), and every read/write in src/lib/db.ts runs as that client. There is
-- no server-side authorization layer — RLS is the only thing standing between the anon key
-- (which ships in the JS bundle) and the whole database. Until now those policies lived only
-- in the Supabase dashboard, unversioned and unreviewable. This migration captures them in the
-- repo so the load-bearing wall is visible, diffable, and reproducible.
--
-- Safe to run repeatedly:
--   * `enable row level security` is idempotent.
--   * Each policy is dropped-if-exists then recreated, so this converges to a known-good state
--     whether RLS was previously off (wide open) or on with hand-made policies.
-- Single-owner app: every row's user_id equals the one account's auth.uid(), so enforcing these
-- policies changes nothing functionally — it just makes "only the owner can touch their rows"
-- true at the database, not merely by convention.

-- ---- items ----
alter table public.items enable row level security;
drop policy if exists items_owner on public.items;
create policy items_owner on public.items
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---- spaces ----
alter table public.spaces enable row level security;
drop policy if exists spaces_owner on public.spaces;
create policy spaces_owner on public.spaces
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---- libraries ----
alter table public.libraries enable row level security;
drop policy if exists libraries_owner on public.libraries;
create policy libraries_owner on public.libraries
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---- stacks ----
alter table public.stacks enable row level security;
drop policy if exists stacks_owner on public.stacks;
create policy stacks_owner on public.stacks
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---- seen_suggestions ----
alter table public.seen_suggestions enable row level security;
drop policy if exists seen_suggestions_owner on public.seen_suggestions;
create policy seen_suggestions_owner on public.seen_suggestions
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- NOTE on restoreItem (db.ts): Undo re-inserts a full client-supplied row INCLUDING user_id.
-- The `with check (auth.uid() = user_id)` above is what makes that safe — a client cannot insert
-- a row owned by another user, because the check rejects any user_id that isn't its own.

-- NOTE on Storage: the `media` bucket has its own RLS on storage.objects (signed-URL creation,
-- upload, and remove all run from the browser). Those policies are managed separately in the
-- Storage section of the dashboard; this migration does not touch them. Verify the bucket is
-- PRIVATE and its object policies are owner-scoped too.

-- Verify after running (every core table should report rowsecurity = true):
--   select relname, relrowsecurity
--   from pg_class
--   where relname in ('items','spaces','libraries','stacks','seen_suggestions','web_corpus','judge_verdicts');
