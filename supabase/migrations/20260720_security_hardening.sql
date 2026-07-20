-- Security-hardening n.a.v. Supabase security advisors (2026-07-20).
-- 1) Semantische RPC's zijn SECURITY DEFINER: anonieme uitvoering blokkeren
--    (de anon-key zit in de publieke site; alleen ingelogde gebruikers mogen
--    deze RPC's aanroepen — RLS geldt niet binnen SECURITY DEFINER).
-- 2) search_path vastzetten op de resterende functies met mutable search_path.
-- 3) Backup-tabellen van de juni-operaties opruimen (ROADMAP M0 vestige).
-- Idempotent.

-- ── 1. Anon mag de SECURITY DEFINER RPC's niet uitvoeren ────────────────────
revoke execute on function public.match_notes(extensions.vector, integer, uuid) from public, anon;
grant execute on function public.match_notes(extensions.vector, integer, uuid) to authenticated, service_role;

revoke execute on function public.note_neighbors(uuid, integer) from public, anon;
grant execute on function public.note_neighbors(uuid, integer) to authenticated, service_role;

revoke execute on function public.semantic_bridges(double precision, double precision, integer) from public, anon;
grant execute on function public.semantic_bridges(double precision, double precision, integer) to authenticated, service_role;

-- ── 2. search_path vastzetten ───────────────────────────────────────────────
alter function public.stamp_embedded_at() set search_path = public, extensions;
alter function public.notes_needing_embedding(integer) set search_path = public, extensions;
alter function public.count_notes_needing_embedding() set search_path = public, extensions;

-- ── 3. Backup-tabellen weg ──────────────────────────────────────────────────
-- notes_backup_b_enrich (209 rijen) en notes_backup_dedup (2 rijen) waren
-- eenmalige vangnetten; notes bevat de definitieve data.
drop table if exists public.notes_backup_b_enrich;
drop table if exists public.notes_backup_dedup;
