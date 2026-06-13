-- Phase 0: embedding_v2 (512-dim CLIP), discovery_events, recency + trend signals
-- Applied 2026-06-13 via Supabase MCP.
-- ============================================================================

-- web_corpus: new embedding space + recency/trend columns
alter table public.web_corpus
  add column if not exists embedding_v2 vector(512),
  add column if not exists first_seen_at timestamptz not null default now(),
  add column if not exists trend_score real not null default 0;

-- items: new embedding space
alter table public.items
  add column if not exists embedding_v2 vector(512);

-- HNSW indexes for fast ANN search
create index if not exists web_corpus_embedding_v2_idx
  on public.web_corpus using hnsw (embedding_v2 vector_cosine_ops);
create index if not exists items_embedding_v2_idx
  on public.items using hnsw (embedding_v2 vector_cosine_ops);
create index if not exists web_corpus_unembedded_v2_idx
  on public.web_corpus (multi_entry desc, created_at asc) where embedding_v2 is null;

-- Back-fill first_seen_at from created_at for existing rows
update public.web_corpus
  set first_seen_at = created_at
  where first_seen_at = now();

-- Corpus v2 nearest-neighbour search (512-dim, same filters as match_corpus)
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
  order by c.embedding_v2 <=> p_query
  limit p_count
$$;

-- Items v2 nearest-neighbour search
create or replace function public.match_items_v2(
  p_query vector(512),
  p_count int default 40
)
returns table (
  id uuid, space_id uuid, user_id uuid, type text,
  storage_path text, thumb_path text, content text, title text,
  source_url text, source_domain text, tags text[], colors text[],
  fonts text[], tech text[], ai_caption text, created_at timestamptz,
  similarity float
)
language sql stable as $$
  select i.id, i.space_id, i.user_id, i.type,
         i.storage_path, i.thumb_path, i.content, i.title,
         i.source_url, i.source_domain, i.tags, i.colors,
         i.fonts, i.tech, i.ai_caption, i.created_at,
         1 - (i.embedding_v2 <=> p_query) as similarity
  from public.items i
  where i.embedding_v2 is not null
  order by i.embedding_v2 <=> p_query
  limit p_count
$$;

-- Board centroid in v2 space
create or replace function public.space_centroid_v2(
  p_space_id uuid default null
)
returns vector(512) language sql stable as $$
  select avg(embedding_v2)::vector(512)
  from public.items
  where embedding_v2 is not null
    and (p_space_id is null or space_id = p_space_id)
$$;

-- Library "more like this" in v2 space
create or replace function public.match_to_item_v2(
  p_item_id uuid,
  p_count int default 12
)
returns table (
  id uuid, space_id uuid, user_id uuid, type text,
  storage_path text, thumb_path text, content text, title text,
  source_url text, source_domain text, tags text[], colors text[],
  fonts text[], tech text[], ai_caption text, created_at timestamptz,
  similarity float
)
language sql stable as $$
  with q as (
    select embedding_v2
    from public.items
    where id = p_item_id and embedding_v2 is not null
  )
  select i.id, i.space_id, i.user_id, i.type,
         i.storage_path, i.thumb_path, i.content, i.title,
         i.source_url, i.source_domain, i.tags, i.colors,
         i.fonts, i.tech, i.ai_caption, i.created_at,
         1 - (i.embedding_v2 <=> q.embedding_v2) as similarity
  from public.items i, q
  where i.embedding_v2 is not null
    and i.id != p_item_id
  order by i.embedding_v2 <=> q.embedding_v2
  limit p_count
$$;

-- discovery_events: learning loop + bandit training data
create table if not exists public.discovery_events (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade,
  url text,
  item_id uuid references public.items(id) on delete set null,
  kind text not null check (kind in ('impression','open','save','like','dislike','dwell')),
  value real,
  lane text,
  ref_key text,
  model text,
  created_at timestamptz not null default now()
);

create index if not exists discovery_events_user_created_idx
  on public.discovery_events (user_id, created_at desc);
create index if not exists discovery_events_url_kind_idx
  on public.discovery_events (url, kind);

alter table public.discovery_events enable row level security;
drop policy if exists discovery_events_own on public.discovery_events;
create policy discovery_events_own on public.discovery_events
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
