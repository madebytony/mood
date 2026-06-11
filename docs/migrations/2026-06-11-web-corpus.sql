-- Mini-Pinterest corpus: every design-site candidate the app ever encounters gets stored
-- and embedded ONCE, so "similar" becomes instant vector retrieval over an owned index
-- instead of a flaky live-web generation pipeline. Harvested from curated galleries
-- (which carry human-applied tags) + Are.na + web-search results.
-- Run in Supabase SQL editor (or migration tool).

create table if not exists public.web_corpus (
  id uuid primary key default gen_random_uuid(),
  url text not null unique,
  domain text not null,
  title text,
  image text,
  blurb text,
  tags text[] not null default '{}',
  source text not null,
  embedding vector(1024),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists web_corpus_domain_idx on public.web_corpus (domain);
create index if not exists web_corpus_unembedded_idx on public.web_corpus (created_at) where embedding is null;
create index if not exists web_corpus_embedding_idx on public.web_corpus
  using hnsw (embedding vector_cosine_ops);

alter table public.web_corpus enable row level security;
drop policy if exists web_corpus_read on public.web_corpus;
create policy web_corpus_read on public.web_corpus for select to authenticated using (true);
-- writes: service role only (no insert/update policies)

-- Taste centroid: the average vector of a board's items (or the whole library when null).
create or replace function public.space_centroid(p_space_id uuid default null)
returns vector(1024) language sql stable as $$
  select avg(embedding)::vector(1024)
  from public.items
  where embedding is not null
    and (p_space_id is null or space_id = p_space_id)
$$;

-- Corpus nearest-neighbours, excluding given domains (library + dislikes + already shown).
create or replace function public.match_corpus(
  p_query vector(1024),
  p_count int default 30,
  p_exclude text[] default '{}'
)
returns table (url text, domain text, title text, image text, blurb text, tags text[], source text, similarity float)
language sql stable as $$
  select c.url, c.domain, c.title, c.image, c.blurb, c.tags, c.source,
         1 - (c.embedding <=> p_query) as similarity
  from public.web_corpus c
  where c.embedding is not null
    and not (c.domain = any(p_exclude))
  order by c.embedding <=> p_query
  limit p_count
$$;
