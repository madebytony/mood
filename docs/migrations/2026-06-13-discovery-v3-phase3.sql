-- Phase 3: taste model (preference vector), style clusters, trending lane
-- Applied 2026-06-13 via Supabase MCP.
-- ============================================================================

-- Style clusters: auto-named aesthetic groups computed by cron k-means
create table if not exists public.style_clusters (
  id         int primary key,
  label      text,
  centroid   vector(512),
  size       int not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.web_corpus
  add column if not exists style_cluster int references public.style_clusters(id);

create index if not exists web_corpus_style_cluster_idx
  on public.web_corpus (style_cluster)
  where style_cluster is not null;

-- Dislike centroid: mean embedding of corpus rows the user has disliked
-- Used by preference vector: liked_centroid - 0.3 * disliked_centroid
create or replace function public.dislike_centroid_v2(p_user_id uuid)
returns vector(512) language sql stable as $$
  select avg(c.embedding_v2)::vector(512)
  from public.discovery_events e
  join public.web_corpus c on c.url = e.url
  where e.kind = 'dislike'
    and e.user_id = p_user_id
    and c.embedding_v2 is not null
$$;

-- Trend score update (called by daily cron via /api/ping or dedicated route)
create or replace function public.update_trend_scores()
returns int language sql as $$
  with updated as (
    update public.web_corpus c
    set trend_score = coalesce((
      select count(*)::real
      from public.discovery_events e
      where e.url = c.url
        and e.kind in ('save', 'like', 'open')
        and e.created_at > now() - interval '14 days'
    ), 0)
    where c.embedding_v2 is not null
    returning 1
  )
  select count(*)::int from updated
$$;

-- Trending lane: positive engagement velocity, 14-day rolling
create or replace function public.trending_corpus_v2(
  p_count   int    default 30,
  p_exclude text[] default '{}',
  p_kind    text   default null,
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
         c.trend_score::float as similarity
  from public.web_corpus c
  where c.embedding_v2 is not null
    and c.trend_score > 0
    and not (c.url = any(p_exclude_urls))
    and (c.multi_entry or not (c.domain = any(p_exclude)))
    and (p_kind is null or c.kind = p_kind)
  order by c.trend_score desc, c.first_seen_at desc
  limit p_count
$$;

-- Cluster-scoped nearest-neighbour search
create or replace function public.match_corpus_cluster_v2(
  p_query     vector(512),
  p_cluster   int,
  p_count     int    default 20,
  p_exclude   text[] default '{}',
  p_kind      text   default null,
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
    and c.style_cluster = p_cluster
    and not (c.url = any(p_exclude_urls))
    and (c.multi_entry or not (c.domain = any(p_exclude)))
    and (p_kind is null or c.kind = p_kind)
  order by c.embedding_v2 <=> p_query
  limit p_count
$$;

-- Rep thumbs: items nearest the board centroid (multi-reference board search)
drop function if exists public.space_rep_thumbs(uuid, integer);
create or replace function public.space_rep_thumbs(
  p_space_id uuid,
  p_count    int default 3
)
returns table (thumb_path text, similarity float)
language sql stable as $$
  with centroid as (
    select avg(embedding_v2)::vector(512) as v
    from public.items
    where space_id = p_space_id and embedding_v2 is not null
  )
  select i.thumb_path,
         (1 - (i.embedding_v2 <=> centroid.v))::float as similarity
  from public.items i, centroid
  where i.space_id = p_space_id
    and i.embedding_v2 is not null
    and i.thumb_path is not null
  order by i.embedding_v2 <=> centroid.v
  limit p_count
$$;
