-- Deterministic palette for corpus rows (same named hue buckets as items.colors):
-- multimodal embeddings under-weight palette, so colour gets its own explicit channel.
-- Run in Supabase SQL editor (or migration tool).

alter table public.web_corpus add column if not exists colors text[] not null default '{}';

drop function if exists public.match_corpus(vector, int, text[]);
create or replace function public.match_corpus(
  p_query vector(1024),
  p_count int default 30,
  p_exclude text[] default '{}'
)
returns table (url text, domain text, title text, image text, blurb text, tags text[], colors text[], source text, similarity float)
language sql stable as $$
  select c.url, c.domain, c.title, c.image, c.blurb, c.tags, c.colors, c.source,
         1 - (c.embedding <=> p_query) as similarity
  from public.web_corpus c
  where c.embedding is not null
    and not (c.domain = any(p_exclude))
  order by c.embedding <=> p_query
  limit p_count
$$;
