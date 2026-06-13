-- Watched studios: the living list of design agencies and type foundries whose
-- news / work / blog sections Mood monitors for new content. Replaces the static
-- FOUNDRIES / AGENCIES arrays in corpus.ts so the list can grow automatically.
--
-- Tiers:
--   'seed'       — hand-curated; always active regardless of appearance count
--   'discovered' — found via Are.na / hoverstat.es / Fonts In Use discovery;
--                  activated for content-watching once gallery_appearances >= 2
--
-- Run in Supabase SQL editor (or migration tool).

create table if not exists public.watched_studios (
  id                  uuid primary key default gen_random_uuid(),
  url                 text not null,
  domain              text not null unique,
  name                text,
  kind                text not null check (kind in ('agency', 'foundry')),
  tier                text not null default 'discovered' check (tier in ('seed', 'discovered')),

  -- Content paths to watch for new articles / case studies / releases.
  -- Null = not yet detected; auto-detection fills this on first scrape.
  content_paths       text[] default null,
  rss_url             text default null,

  -- Discovery signal: how many independent gallery sources have linked to this domain.
  -- Discovered studios are only activated once this reaches 2.
  gallery_appearances int not null default 1,

  -- Freshness tracking for the content watcher.
  last_checked_at     timestamptz default null,
  last_new_content_at timestamptz default null,

  created_at          timestamptz not null default now()
);

-- Fast lookup by domain (the primary dedup / upsert key)
create index if not exists watched_studios_domain_idx
  on public.watched_studios (domain);

-- Content-watcher queue: seeds + discovered-with-appearances, oldest-checked first
create index if not exists watched_studios_queue_idx
  on public.watched_studios (last_checked_at nulls first)
  where tier = 'seed' or gallery_appearances >= 2;

-- Kind filter for the directory UI
create index if not exists watched_studios_kind_idx
  on public.watched_studios (kind);

alter table public.watched_studios enable row level security;

drop policy if exists watched_studios_read on public.watched_studios;
create policy watched_studios_read
  on public.watched_studios for select to authenticated using (true);
-- writes: service role only (no insert/update/delete policies for authenticated)

-- ---------------------------------------------------------------------------
-- Helper: bump gallery_appearances without a read-modify-write race
-- ---------------------------------------------------------------------------
create or replace function public.increment_studio_appearances(p_domain text)
returns void language sql as $$
  update public.watched_studios
  set gallery_appearances = coalesce(gallery_appearances, 0) + 1
  where domain = p_domain;
$$;

-- ---------------------------------------------------------------------------
-- Seed data: the existing hand-curated FOUNDRIES + AGENCIES from corpus.ts.
-- content_paths filled where known; null means auto-detect on first scrape.
-- ---------------------------------------------------------------------------

-- Type foundries
insert into public.watched_studios (url, domain, name, kind, tier, content_paths, gallery_appearances)
values
  ('https://klim.co.nz',                'klim.co.nz',               'Klim Type Foundry',  'foundry', 'seed', '{/blog}',              10),
  ('https://abcdinamo.com',             'abcdinamo.com',             'ABC Dinamo',          'foundry', 'seed', '{/news}',              10),
  ('https://commercialtype.com',        'commercialtype.com',        'Commercial Type',     'foundry', 'seed', '{/news}',              10),
  ('https://www.grillitype.com',        'grillitype.com',            'Grilli Type',         'foundry', 'seed', '{/journal}',           10),
  ('https://www.colophon-foundry.org',  'colophon-foundry.org',      'Colophon Foundry',    'foundry', 'seed', '{/news}',              10),
  ('https://sharptype.co',             'sharptype.co',              'Sharp Type',          'foundry', 'seed', '{/news,/releases}',    10),
  ('https://pangrampangram.com',        'pangrampangram.com',        'Pangram Pangram',     'foundry', 'seed', '{/blog}',              10),
  ('https://blazetype.eu',              'blazetype.eu',              'Blaze Type',          'foundry', 'seed', '{/blog,/case-studies}',10),
  ('https://www.futurefonts.xyz',       'futurefonts.xyz',           'Future Fonts',        'foundry', 'seed', '{/updates}',           10),
  ('https://ohnotype.co',               'ohnotype.co',               'OH no Type Co',       'foundry', 'seed', '{/blog}',              10),
  ('https://optimo.ch',                 'optimo.ch',                 'Optimo',              'foundry', 'seed', null,                   10),
  ('https://www.typotheque.com',        'typotheque.com',            'Typotheque',          'foundry', 'seed', '{/news}',              10),
  ('https://lineto.com',                'lineto.com',                'Lineto',              'foundry', 'seed', '{/articles}',          10),
  ('https://www.dstype.com',            'dstype.com',                'DSType',              'foundry', 'seed', null,                   10),
  ('https://www.swisstypefaces.com',    'swisstypefaces.com',        'Swiss Typefaces',     'foundry', 'seed', '{/read}',              10),
  ('https://displaay.net',              'displaay.net',              'Displaay',            'foundry', 'seed', '{/news}',              10),
  ('https://mass-driver.com',           'mass-driver.com',           'Mass-Driver',         'foundry', 'seed', '{/journal}',           10),
  ('https://vj-type.com',               'vj-type.com',               'VJ Type',             'foundry', 'seed', null,                   10),
  ('https://www.205.tf',                '205.tf',                    '205TF',               'foundry', 'seed', '{/articles}',          10),
  ('https://www.atipofoundry.com',      'atipofoundry.com',          'Atipo Foundry',       'foundry', 'seed', null,                   10),
  ('https://www.typemates.com',         'typemates.com',             'TypeMates',           'foundry', 'seed', '{/news}',              10),
  ('https://fontwerk.com',              'fontwerk.com',              'Fontwerk',            'foundry', 'seed', '{/journal}',           10)
on conflict (domain) do update set
  content_paths = excluded.content_paths,
  rss_url = excluded.rss_url;

-- Design agencies
insert into public.watched_studios (url, domain, name, kind, tier, content_paths, gallery_appearances)
values
  ('https://www.pentagram.com',         'pentagram.com',             'Pentagram',           'agency',  'seed', '{/work,/news}',        10),
  ('https://koto.studio',               'koto.studio',               'Koto',                'agency',  'seed', '{/work,/journal}',     10),
  ('https://www.instrument.com',        'instrument.com',            'Instrument',          'agency',  'seed', '{/work}',              10),
  ('https://basicagency.com',           'basicagency.com',           'BASIC/DEPT',          'agency',  'seed', '{/work}',              10),
  ('https://work.co',                   'work.co',                   'Work & Co',           'agency',  'seed', '{/work}',              10),
  ('https://www.dixonbaxi.com',         'dixonbaxi.com',             'DixonBaxi',           'agency',  'seed', '{/work}',              10),
  ('https://www.metalab.com',           'metalab.com',               'MetaLab',             'agency',  'seed', '{/work,/journal}',     10),
  ('https://area17.com',                'area17.com',                'AREA 17',             'agency',  'seed', '{/work}',              10),
  ('https://locomotive.ca',             'locomotive.ca',             'Locomotive',          'agency',  'seed', '{/work}',              10),
  ('https://dogstudio.co',              'dogstudio.co',              'Dogstudio',           'agency',  'seed', '{/work}',              10),
  ('https://activetheory.net',          'activetheory.net',          'Active Theory',       'agency',  'seed', '{/work}',              10),
  ('https://resn.co.nz',                'resn.co.nz',                'Resn',                'agency',  'seed', '{/work}',              10),
  ('https://14islands.com',             '14islands.com',             '14islands',           'agency',  'seed', '{/work,/journal}',     10),
  ('https://humaan.com',                'humaan.com',                'Humaan',              'agency',  'seed', '{/work}',              10),
  ('https://buildinamsterdam.com',      'buildinamsterdam.com',      'Build in Amsterdam',  'agency',  'seed', '{/work}',              10),
  ('https://basement.studio',           'basement.studio',           'basement.studio',     'agency',  'seed', '{/work}',              10),
  ('https://phantom.land',              'phantom.land',              'PHANTOM',             'agency',  'seed', '{/work}',              10),
  ('https://unseen.co',                 'unseen.co',                 'Unseen Studio',       'agency',  'seed', '{/work}',              10),
  ('https://makemepulse.com',           'makemepulse.com',           'makemepulse',         'agency',  'seed', '{/work}',              10),
  ('https://hellomonday.com',           'hellomonday.com',           'Hello Monday',        'agency',  'seed', '{/work}',              10)
on conflict (domain) do update set
  content_paths = excluded.content_paths,
  rss_url = excluded.rss_url;
