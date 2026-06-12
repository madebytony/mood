-- The board's most REPRESENTATIVE images: items nearest the board's embedding centroid.
-- Used to pick the visual-judge reference for "Explore style" — the most recent item is
-- often an outlier (e.g. a stark-white Balenciaga capture on an otherwise dark board).
-- Run in Supabase SQL editor (or migration tool).

create or replace function public.space_rep_thumbs(p_space_id uuid, p_count int default 3)
returns table (thumb_path text) language sql stable as $$
  with c as (select public.space_centroid(p_space_id) as v)
  select i.thumb_path
  from public.items i, c
  where i.space_id = p_space_id
    and i.embedding is not null
    and i.thumb_path is not null
    and c.v is not null
  order by i.embedding <=> c.v
  limit p_count
$$;
