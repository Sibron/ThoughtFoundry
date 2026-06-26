-- Semantic linking RPCs (zero LLM cost — pure pgvector).
-- Depend on notes.embedding being populated (see embed-notes-batch + the
-- backfill in Settings). Both are RLS-scoped via auth.uid().

-- Top-k semantic neighbours of a note, BY ITS OWN STORED EMBEDDING (no need to
-- re-embed a query string). Already-linked notes are excluded so every suggestion
-- is directly actionable. Returns the closest notes by cosine distance.
create or replace function public.note_neighbors(
  source uuid,
  match_count int default 8
)
returns table (id uuid, ai_title text, content text, similarity float)
language sql stable as $$
  with src as (
    select embedding
    from public.notes
    where id = source and user_id = auth.uid() and embedding is not null
  )
  select n.id, n.ai_title, n.content,
         1 - (n.embedding <=> (select embedding from src)) as similarity
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
  order by n.embedding <=> (select embedding from src)
  limit match_count
$$;

-- "Non-obvious bridges": pairs that are semantically close WITHIN A BAND
-- (related, not near-duplicate), are NOT already linked, and share NO theme.
-- The semantic upgrade of the lexical findSurprisingPair. Band is parameterised
-- so the UI can tune "specifieker / breder" without an LLM. Zero API cost.
create or replace function public.semantic_bridges(
  band_lo float default 0.55,
  band_hi float default 0.82,
  max_pairs int default 20
)
returns table (a_id uuid, b_id uuid, similarity float)
language sql stable as $$
  select a.id as a_id, b.id as b_id,
         1 - (a.embedding <=> b.embedding) as similarity
  from public.notes a
  join public.notes b
    on a.user_id = auth.uid()
   and b.user_id = auth.uid()
   and a.id < b.id                                   -- each undirected pair once
   and a.embedding is not null
   and b.embedding is not null
   and (1 - (a.embedding <=> b.embedding)) between band_lo and band_hi
  where not exists (
      select 1 from public.note_links l
      where (l.source_id = a.id and l.target_id = b.id)
         or (l.source_id = b.id and l.target_id = a.id))
    and not exists (
      select 1 from public.note_themes ta
      join public.note_themes tb on ta.theme_id = tb.theme_id
      where ta.note_id = a.id and tb.note_id = b.id)
  order by (1 - (a.embedding <=> b.embedding)) desc
  limit max_pairs
$$;
