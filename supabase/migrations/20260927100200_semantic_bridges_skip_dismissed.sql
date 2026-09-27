-- semantic_bridges leaves out the pairs the caller has already dismissed (#56).
--
-- The Verbindingen queue fetched the top 20 bridges and only then removed
-- dismissed pairs in the browser. The database kept returning the same top
-- 20, so every dismissal made the visible list one shorter, and after 20 the
-- band showed "Geen nieuwe voorstellen" for good -- while pair 21 onward had
-- never been shown. The review queue got worse the more it was used, and its
-- lifetime value was capped at 20 pairs per band. capture.ts's "Verbind twee"
-- had the same wall, and graph.ts's "Verbindingen voorstellen" never filtered
-- dismissals at all.
--
-- The exclusion now sits in SQL next to the other two (already linked, shares
-- a theme). connection_dismissals stores each pair normalised as (least,
-- greatest), exactly as this function builds a_id/b_id, and its primary key
-- (user_id, a_id, b_id) is the index the lookup needs -- no new index. A
-- dismissal is per pair, not per band, so a pair dismissed under "Dichtbij"
-- stays gone under "Verrassend" too.
--
-- Everything else is the 20260626165956_semantic_bridges_searchpath_fix
-- definition unchanged: same signature and defaults (the band itself is #36),
-- SECURITY DEFINER with search_path = public, extensions (`<=>` lives in
-- extensions -- that migration's header explains the 500 it fixed). Because
-- it is SECURITY DEFINER, RLS does not apply inside, so the dismissal lookup
-- filters on auth.uid() itself, as the note lookup already does.
--
-- The signature is unchanged, so create or replace keeps the grants; they are
-- re-stated anyway, so this file alone leaves execute revoked from anon.
-- Idempotent.

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

  -- For each note, ask the ivfflat index for its 25 nearest neighbours via
  -- LATERAL KNN, then filter by band and exclusions: O(n × 25 index probes)
  -- instead of the O(n²) self-join this replaced.
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
      and not exists (
        select 1 from connection_dismissals d
        where d.user_id = auth.uid()
          and d.a_id    = least(a.id, nn.id)
          and d.b_id    = greatest(a.id, nn.id)
      )
    order by similarity desc
    limit max_pairs;
end;
$$;

revoke execute on function public.semantic_bridges(double precision, double precision, integer) from public, anon;
grant  execute on function public.semantic_bridges(double precision, double precision, integer) to authenticated, service_role;
