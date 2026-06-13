-- Phase 1: Feed policy — fresh + explore lanes, RRF fusion, MMR diversity
-- Applied 2026-06-13 via Supabase MCP.
-- ============================================================================

-- fresh_corpus_v2: recency-ordered feed lane (no similarity required)
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
  order by c.first_seen_at desc
  limit p_count
$$;

-- explore_corpus_v2: random picks far from mean (cosine sim < 0.70 vs centroid)
create or replace function public.explore_corpus_v2(
  p_centroid vector(512),
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
         1 - (c.embedding_v2 <=> p_centroid) as similarity
  from public.web_corpus c
  where c.embedding_v2 is not null
    and not (c.url = any(p_exclude_urls))
    and (c.multi_entry or not (c.domain = any(p_exclude)))
    and (p_kind is null or c.kind = p_kind)
    and (p_color is null or p_color = any(c.colors))
    and 1 - (c.embedding_v2 <=> p_centroid) < 0.70
  order by random()
  limit p_count
$$;
