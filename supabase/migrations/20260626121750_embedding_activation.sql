-- Embedding activation: switch the embedding column to the dimension produced by
-- the Supabase Edge built-in model (gte-small = 384-dim), and add the bookkeeping
-- to (re)generate embeddings in cheap, resumable batches. No external provider,
-- no API key, no per-token cost. Idempotent.

-- gte-small outputs 384 dims; the base schema created embedding as vector(1024).
-- No embeddings have been generated yet, so dropping + re-adding the column is
-- lossless. Recreate the cosine index and the match_notes RPC at the new size.
drop index if exists public.notes_embedding_idx;

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'notes' and column_name = 'embedding') then
    alter table public.notes drop column embedding;
  end if;
end $$;

alter table public.notes add column embedding vector(384);

create index if not exists notes_embedding_idx
  on public.notes using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- Function arg typmods aren't part of the signature, so this replaces the
-- existing match_notes cleanly (kept consistent at 384 even though the app uses
-- note_neighbors instead).
create or replace function public.match_notes(
  query_embedding vector(384),
  match_count int default 5,
  exclude_id uuid default null
)
returns table (id uuid, content text, similarity float)
language sql stable as $$
  select n.id, n.content, 1 - (n.embedding <=> query_embedding) as similarity
  from public.notes n
  where n.user_id = auth.uid()
    and n.embedding is not null
    and (exclude_id is null or n.id <> exclude_id)
  order by n.embedding <=> query_embedding
  limit match_count
$$;

-- When the stored embedding was last (re)generated.
--   embedded_at IS NULL              => never embedded
--   embedded_at < updated_at         => content changed since the last embedding
alter table public.notes add column if not exists embedded_at timestamptz;

-- Stamp embedded_at from the DB clock whenever the embedding column is (re)written.
-- now() is the transaction timestamp, so embedded_at ends up exactly equal to the
-- updated_at that the existing notes_updated_at trigger sets in the same write —
-- which means a just-embedded note is NOT re-selected by notes_needing_embedding,
-- while a later content edit (bumps updated_at, not embedded_at) marks it stale.
create or replace function public.stamp_embedded_at()
returns trigger language plpgsql as $$
begin
  if new.embedding is not null and new.embedding is distinct from old.embedding then
    new.embedded_at = now();
  end if;
  return new;
end $$;

drop trigger if exists notes_stamp_embedded_at on public.notes;
create trigger notes_stamp_embedded_at
  before update on public.notes
  for each row execute procedure public.stamp_embedded_at();

-- Next batch of notes that still need (re)embedding, oldest-first so a client
-- loop is naturally resumable. RLS-scoped via auth.uid().
create or replace function public.notes_needing_embedding(batch_size int default 50)
returns table (id uuid, content text, mini_notes text)
language sql stable as $$
  select n.id, n.content, n.mini_notes
  from public.notes n
  where n.user_id = auth.uid()
    and (n.embedding is null or n.embedded_at is null or n.embedded_at < n.updated_at)
  order by n.created_at asc
  limit batch_size
$$;

-- How many notes still need (re)embedding — drives the backfill progress UI.
create or replace function public.count_notes_needing_embedding()
returns int language sql stable as $$
  select count(*)::int
  from public.notes n
  where n.user_id = auth.uid()
    and (n.embedding is null or n.embedded_at is null or n.embedded_at < n.updated_at)
$$;
