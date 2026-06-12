-- Multi-entry domains: blogs (itsnicethat) and Fonts In Use have MANY distinct pieces on
-- ONE domain. Such rows must dedup/exclude by URL, not domain — otherwise showing or
-- saving one article kills the whole domain for retrieval.
-- Run in Supabase SQL editor (or migration tool).

alter table public.web_corpus add column if not exists multi_entry boolean not null default false;

drop function if exists public.match_corpus(vector, int, text[], text, text);
create or replace function public.match_corpus(
  p_query vector(1024),
  p_count int default 30,
  p_exclude text[] default '{}',
  p_kind text default null,
  p_color text default null,
  p_exclude_urls text[] default '{}'
)
returns table (url text, domain text, title text, image text, blurb text, tags text[], colors text[], source text, kind text, multi_entry boolean, similarity float)
language sql stable as $$
  select c.url, c.domain, c.title, c.image, c.blurb, c.tags, c.colors, c.source, c.kind, c.multi_entry,
         1 - (c.embedding <=> p_query) as similarity
  from public.web_corpus c
  where c.embedding is not null
    and not (c.url = any(p_exclude_urls))
    and (c.multi_entry or not (c.domain = any(p_exclude)))
    and (p_kind is null or c.kind = p_kind)
    and (p_color is null or p_color = any(c.colors))
  order by c.embedding <=> p_query
  limit p_count
$$;
