-- Lanes for the Discover feed (awwwards-collections style): site design vs type foundries.
-- Run in Supabase SQL editor (or migration tool).

alter table public.web_corpus add column if not exists kind text not null default 'site';
update public.web_corpus set kind = 'type' where source like 'are.na/type%' or source like 'are.na/typography%';
create index if not exists web_corpus_kind_idx on public.web_corpus (kind);

-- match_corpus gains kind + palette filters (chips in the feed). Drop first: adding
-- defaulted params to an existing signature would create an ambiguous overload.
drop function if exists public.match_corpus(vector, int, text[]);
create or replace function public.match_corpus(
  p_query vector(1024),
  p_count int default 30,
  p_exclude text[] default '{}',
  p_kind text default null,
  p_color text default null
)
returns table (url text, domain text, title text, image text, blurb text, tags text[], colors text[], source text, kind text, similarity float)
language sql stable as $$
  select c.url, c.domain, c.title, c.image, c.blurb, c.tags, c.colors, c.source, c.kind,
         1 - (c.embedding <=> p_query) as similarity
  from public.web_corpus c
  where c.embedding is not null
    and not (c.domain = any(p_exclude))
    and (p_kind is null or c.kind = p_kind)
    and (p_color is null or p_color = any(c.colors))
  order by c.embedding <=> p_query
  limit p_count
$$;
