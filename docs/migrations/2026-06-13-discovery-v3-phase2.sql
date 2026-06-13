-- Phase 2: CIELAB palette + structured facets + colour-verified discovery RPCs
-- Applied 2026-06-13 via Supabase MCP.
-- ============================================================================

-- web_corpus + items: add palette_lab (dominant colours in CIELAB) and facets (structured vocabulary)
alter table public.web_corpus
  add column if not exists palette_lab jsonb,
  add column if not exists facets jsonb;

alter table public.items
  add column if not exists palette_lab jsonb,
  add column if not exists facets jsonb;

-- GIN indexes for fast facet containment queries  (@>  operator)
create index if not exists web_corpus_facets_idx on public.web_corpus using gin(facets);
create index if not exists items_facets_idx on public.items using gin(facets);

-- Colour-matched corpus search: vector similarity + CIE76 delta-E gate
-- p_target_lab: [L, a, b] as jsonb array, e.g. '[29, 4, -22]'
-- palette_lab stored as [[L,a,b], [L,a,b], ...] — dominant 3-5 colours per row
-- Rows pass when min(delta-E to any palette colour) < p_max_de
create or replace function public.match_corpus_colour_v2(
  p_query   vector(512),
  p_target_lab jsonb,
  p_max_de  real    default 25,
  p_count   int     default 30,
  p_exclude text[]  default '{}',
  p_kind    text    default null,
  p_exclude_urls text[] default '{}'
)
returns table (
  url text, domain text, title text, image text, blurb text,
  tags text[], colors text[], source text, kind text,
  multi_entry boolean, similarity float, min_delta_e real
)
language sql stable as $$
  with target as (
    select
      (p_target_lab->>0)::real as tl,
      (p_target_lab->>1)::real as ta,
      (p_target_lab->>2)::real as tb
  ),
  candidates as (
    select c.url, c.domain, c.title, c.image, c.blurb, c.tags, c.colors,
           c.source, c.kind, c.multi_entry,
           1 - (c.embedding_v2 <=> p_query) as similarity,
           c.palette_lab
    from public.web_corpus c
    where c.embedding_v2 is not null
      and c.palette_lab is not null
      and not (c.url = any(p_exclude_urls))
      and (c.multi_entry or not (c.domain = any(p_exclude)))
      and (p_kind is null or c.kind = p_kind)
    order by c.embedding_v2 <=> p_query
    limit p_count * 6
  ),
  de_scored as (
    select c.url, c.domain, c.title, c.image, c.blurb, c.tags, c.colors,
           c.source, c.kind, c.multi_entry, c.similarity,
           (
             select min(
               sqrt(
                 power((lab_color->>0)::real - t.tl, 2) +
                 power((lab_color->>1)::real - t.ta, 2) +
                 power((lab_color->>2)::real - t.tb, 2)
               )
             )
             from jsonb_array_elements(c.palette_lab) as lab_color
           ) as min_delta_e
    from candidates c, target t
  )
  select url, domain, title, image, blurb, tags, colors, source, kind, multi_entry,
         similarity::float, min_delta_e::real
  from de_scored
  where min_delta_e <= p_max_de
  order by (similarity * 0.55 + greatest(0, (1.0 - min_delta_e / 80.0)) * 0.45) desc
  limit p_count
$$;

-- Facet-filtered corpus search (layered on top of v2 nearest-neighbour)
create or replace function public.match_corpus_facets_v2(
  p_query   vector(512),
  p_facets  jsonb,
  p_count   int     default 30,
  p_exclude text[]  default '{}',
  p_kind    text    default null,
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
    and (p_facets is null or c.facets @> p_facets)
    and not (c.url = any(p_exclude_urls))
    and (c.multi_entry or not (c.domain = any(p_exclude)))
    and (p_kind is null or c.kind = p_kind)
  order by c.embedding_v2 <=> p_query
  limit p_count
$$;
