-- Allow the "bookmarks" kind for spaces (auto-created when user first likes a discovery result).
-- Idempotent: safe to re-run.
ALTER TABLE public.spaces DROP CONSTRAINT IF EXISTS spaces_kind_check;
ALTER TABLE public.spaces ADD CONSTRAINT spaces_kind_check CHECK (kind IN ('normal', 'inbox', 'bookmarks'));
