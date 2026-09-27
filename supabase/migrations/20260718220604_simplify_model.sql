-- Model-versimpeling: geen onbereikbare data in de database.
-- 1) Verbindingstypen 6 → 3 (legacy-rijen migreren naar 'related')
-- 2) notes.note_type weg (een notitie is verwerkt of niet — status is de as)
-- 3) notes.tags weg (thema's zijn het indelingssysteem)
-- 4) books-tabel weg (het boekproject ís het boek)
-- Idempotent; volgorde: data eerst, dan constraints/kolommen.

-- ── 1. Verbindingstypen ─────────────────────────────────────────────────────
update public.note_links
   set type = 'related'
 where type in ('example_of', 'contrasts', 'applies_to');

alter table public.note_links drop constraint if exists note_links_type_check;
alter table public.note_links add constraint note_links_type_check
  check (type in ('builds_on', 'contradicts', 'related'));

-- ── 2. Notitietypen ─────────────────────────────────────────────────────────
alter table public.notes drop column if exists note_type;

-- ── 3. Tags ─────────────────────────────────────────────────────────────────
alter table public.notes drop column if exists tags;

-- ── 4. Boeken (bundels) ─────────────────────────────────────────────────────
drop table if exists public.books;
