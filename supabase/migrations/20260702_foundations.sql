-- Foundations for the "doel-instrument" arc: missing indexes, the missing
-- user_settings delete policy, and better vector recall for the two KNN RPCs.
-- Idempotent.

-- ── 1) user_settings delete policy ──────────────────────────────────────────
-- Every other table has the full four own-row policies; user_settings was
-- created with only select/insert/update, so deletes silently no-op under RLS.
drop policy if exists "user_settings_delete" on public.user_settings;
create policy "user_settings_delete" on public.user_settings
  for delete using (auth.uid() = user_id);

-- ── 2) Missing indexes for common filters ───────────────────────────────────
-- tags is filtered with array containment (denkpartner scope, tag search):
-- without a GIN index that is a sequential scan per query.
create index if not exists notes_tags_gin on public.notes using gin(tags);
-- note_type pills (inbox) and section grouping (theme-sections, book) both
-- filter on these columns per user.
create index if not exists notes_user_note_type on public.notes(user_id, note_type);
create index if not exists notes_user_section on public.notes(user_id, section)
  where section is not null;

-- ── 3) KNN RPCs: probe more ivfflat lists for better recall ─────────────────
-- semantic_bridges already sets ivfflat.probes = 10 (see
-- 20260626_semantic_bridges_searchpath_fix.sql); note_neighbors and
-- match_notes were still on the default of 1 probe, which gives weak recall on
-- a small single-user corpus. Same signatures, same row shapes — only the
-- language changes (plpgsql, to allow SET LOCAL) plus the pinned search_path
-- so the pgvector <=> operator resolves under SECURITY DEFINER.

create or replace function public.note_neighbors(
  source uuid,
  match_count int default 8
)
returns table (id uuid, ai_title text, content text, similarity float)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  set local ivfflat.probes = 10;
  return query
    with src as (
      select n.embedding
      from public.notes n
      where n.id = source and n.user_id = auth.uid() and n.embedding is not null
    )
    select n.id, n.ai_title, n.content,
           1 - (n.embedding <=> (select src.embedding from src)) as similarity
    from public.notes n
    where n.user_id = auth.uid()
      and n.embedding is not null
      and n.id <> source
      and exists (select 1 from src)
      and not exists (
        select 1 from public.note_links l
        where (l.source_id = source and l.target_id = n.id)
           or (l.source_id = n.id and l.target_id = source)
      )
    order by n.embedding <=> (select src.embedding from src)
    limit match_count;
end;
$$;

create or replace function public.match_notes(
  query_embedding vector(384),
  match_count int default 5,
  exclude_id uuid default null
)
returns table (id uuid, content text, similarity float)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  set local ivfflat.probes = 10;
  return query
    select n.id, n.content, 1 - (n.embedding <=> query_embedding) as similarity
    from public.notes n
    where n.user_id = auth.uid()
      and n.embedding is not null
      and (exclude_id is null or n.id <> exclude_id)
    order by n.embedding <=> query_embedding
    limit match_count;
end;
$$;
