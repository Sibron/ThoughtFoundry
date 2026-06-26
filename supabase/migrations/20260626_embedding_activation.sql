-- Embedding activation: bookkeeping to (re)generate Voyage embeddings in cheap,
-- resumable batches. The embedding column, the ivfflat index and match_notes()
-- already exist (see schema.sql) — this migration only adds the staleness stamp
-- and the cursor/count RPCs the backfill loop needs. Idempotent.

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
