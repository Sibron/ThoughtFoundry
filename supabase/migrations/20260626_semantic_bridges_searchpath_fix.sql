-- Fix: "Verbindingen voorstellen" (semantic_bridges RPC) returned HTTP 500.
--
-- Background / drift: the semantic_bridges function defined in
-- 20260626_semantic_links.sql was an O(n²) self-join that timed out on real
-- accounts, so it was rewritten directly in the database into the optimized
-- LATERAL KNN form below — but that rewrite was never committed, and it pinned
-- `search_path = public`. The pgvector cosine-distance operator `<=>` lives in
-- the `extensions` schema, so with `search_path = public` only, operator
-- resolution failed:
--   ERROR: 42883: operator does not exist: extensions.vector <=> extensions.vector
-- That aborted every call with a 500.
--
-- This migration makes the repo the source of truth for the optimized version
-- AND fixes the bug, by adding `extensions` to the function's search_path. The
-- explicit search_path is also kept (rather than dropped) so this SECURITY
-- DEFINER function does not trip the "function with a role mutable search_path"
-- security advisor. It supersedes the semantic_bridges definition in
-- 20260626_semantic_links.sql.
--
-- "Non-obvious bridges": pairs that are semantically close WITHIN A BAND
-- (related, not near-duplicate), are NOT already linked, and share NO theme.
-- Zero LLM cost — pure pgvector. Depends on notes.embedding being populated.

create or replace function public.semantic_bridges(
  band_lo float default 0.55,
  band_hi float default 0.82,
  max_pairs int default 20
)
returns table (a_id uuid, b_id uuid, similarity float)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  -- Probe 10% of ivfflat lists (100 lists → 10 probes) for much better recall
  -- without paying the cost of a full sequential scan.
  set local ivfflat.probes = 10;

  /*
   * Old approach: self-join on all pairs → O(n²) sequential scan, always times out.
   * New approach: for each note, ask the ivfflat index for its 25 nearest neighbours
   * via LATERAL KNN, then filter by band and exclusions.
   * Cost: O(n × 25 index probes) instead of O(n²).
   */
  return query
    select distinct
      least(a.id, nn.id)                 as a_id,
      greatest(a.id, nn.id)              as b_id,
      1 - (a.embedding <=> nn.embedding) as similarity
    from notes a
    cross join lateral (
      select b.id, b.embedding
      from   notes b
      where  b.user_id   = a.user_id
        and  b.id        <> a.id
        and  b.embedding is not null
      order by a.embedding <=> b.embedding   -- activates the ivfflat index
      limit 25
    ) nn
    where a.user_id   = auth.uid()
      and a.embedding is not null
      and (1 - (a.embedding <=> nn.embedding)) between band_lo and band_hi
      and not exists (
        select 1 from note_links l
        where (l.source_id = least(a.id, nn.id) and l.target_id = greatest(a.id, nn.id))
           or (l.source_id = greatest(a.id, nn.id) and l.target_id = least(a.id, nn.id))
      )
      and not exists (
        select 1 from note_themes ta
        join  note_themes tb on ta.theme_id = tb.theme_id
        where ta.note_id = least(a.id, nn.id)
          and tb.note_id = greatest(a.id, nn.id)
      )
    order by similarity desc
    limit max_pairs;
end;
$$;
