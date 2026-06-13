-- Phase 4: quality gates, model attribution, eval harness
-- Applied 2026-06-13 via Supabase MCP.
-- ============================================================================

-- quality_score: 0-10 heuristic set during backfill (no Gemini needed)
-- 0-3 = junk; 4+ = allowed in browse feed
alter table public.web_corpus
  add column if not exists quality_score smallint;

create index if not exists web_corpus_quality_idx
  on public.web_corpus (quality_score)
  where quality_score is not null;

-- match_corpus_v2: now gates on quality_score >= 4 (junk filtered from browse feed)
create or replace function public.match_corpus_v2(
  p_query vector(512),
  p_count int default 30,
  p_exclude text[] default '{}',
  p_kind text default null,
  p_color text default null,
  p_exclude_urls text[] default '{}'
)
returns table (
  url text, domain text, title text, image text, blurb text,
  tags text[], colors text[], source text, kind text,
  multi_entry boolean, similarity float
)
language sql stable as $$
  select c.url, c.domain, c.title, c.image, c.blurb, c.tags, c.colors,
         c.source, c.kind, c.multi_entry,
         1 - (c.embedding_v2 <=> p_query) as similarity
  from public.web_corpus c
  where c.embedding_v2 is not null
    and not (c.url = any(p_exclude_urls))
    and (c.multi_entry or not (c.domain = any(p_exclude)))
    and (p_kind is null or c.kind = p_kind)
    and (p_color is null or p_color = any(c.colors))
    and (c.quality_score is null or c.quality_score >= 4)
  order by c.embedding_v2 <=> p_query
  limit p_count
$$;

-- fresh_corpus_v2: same quality gate
create or replace function public.fresh_corpus_v2(
  p_count int default 30,
  p_exclude text[] default '{}',
  p_kind text default null,
  p_color text default null,
  p_exclude_urls text[] default '{}'
)
returns table (
  url text, domain text, title text, image text, blurb text,
  tags text[], colors text[], source text, kind text,
  multi_entry boolean, similarity float
)
language sql stable as $$
  select c.url, c.domain, c.title, c.image, c.blurb, c.tags, c.colors,
         c.source, c.kind, c.multi_entry,
         0.0::float as similarity
  from public.web_corpus c
  where c.embedding_v2 is not null
    and not (c.url = any(p_exclude_urls))
    and (c.multi_entry or not (c.domain = any(p_exclude)))
    and (p_kind is null or c.kind = p_kind)
    and (p_color is null or p_color = any(c.colors))
    and (c.quality_score is null or c.quality_score >= 4)
  order by c.first_seen_at desc
  limit p_count
$$;

-- discovery_events: add 'eval' kind for the eval harness
alter table public.discovery_events
  drop constraint if exists discovery_events_kind_check;

alter table public.discovery_events
  add constraint discovery_events_kind_check
  check (kind in ('impression','open','save','like','dislike','dwell','eval'));

-- Source trust heuristic (reference, used by backfill JS code)
create or replace function public.corpus_quality_heuristic(
  p_title text, p_image text, p_tags text[], p_source text, p_blurb text
)
returns smallint language sql immutable as $$
  select (
    case when p_image is not null and length(p_image) > 10 then 2 else 0 end +
    case when p_title is not null and length(p_title) > 5 then 2 else 0 end +
    case when array_length(p_tags, 1) >= 2 then 2 else 0 end +
    case when p_blurb is not null and length(p_blurb) > 10 then 1 else 0 end +
    case when p_source in ('typewolf', 'fontsInUse', 'itsnicetat', 'eyeondesign', 'are.na',
                           'arena', 'brandnew', 'identitydesigned') then 2
         when p_source like 'websearch%' then 1
         else 0
    end
  )::smallint
$$;
