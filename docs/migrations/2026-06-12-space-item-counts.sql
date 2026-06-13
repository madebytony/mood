-- Grouped per-space item counts, server-side.
--
-- Replaces the client pulling up to 10,000 `space_id` rows on every sidebar refresh just to tally
-- them in JS (db.ts fetchSpaceCounts). This returns one row per space with the count already done
-- in Postgres. `security invoker` so the caller's RLS applies — a user only ever counts their own
-- rows (matches the owner policy in 2026-06-12-rls-core.sql).
--
-- Mirrors the app's sidebar semantics exactly: unstacked items only (stack_id is null).

create or replace function public.space_item_counts()
returns table (space_id uuid, n bigint)
language sql
stable
security invoker
as $$
  select space_id, count(*)::bigint
  from public.items
  where stack_id is null and space_id is not null
  group by space_id;
$$;
