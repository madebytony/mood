-- Persist design/type mode on libraries.
-- Run in Supabase SQL editor (or migration tool) before using DB-backed mode toggles.

alter table if exists public.libraries
  add column if not exists mode text not null default 'default';

-- Normalize any unexpected/null values before enforcing constraints.
update public.libraries
set mode = 'default'
where mode is null
   or mode not in ('default', 'type');

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'libraries_mode_check'
  ) then
    alter table public.libraries
      add constraint libraries_mode_check
      check (mode in ('default', 'type'));
  end if;
end $$;

create index if not exists libraries_user_mode_idx
  on public.libraries (user_id, mode);

-- Backfill likely-typography libraries so existing setups keep current behavior.
update public.libraries
set mode = 'type'
where mode = 'default'
  and name ~* '(type|typography|font|foundry)';
