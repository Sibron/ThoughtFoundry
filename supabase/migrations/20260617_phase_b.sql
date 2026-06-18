-- Phase B additive migration: section on notes, parent_id on themes.
-- Idempotent: safe to re-run. Does not touch existing rows.

alter table public.notes
  add column if not exists section text;

alter table public.themes
  add column if not exists parent_id uuid references public.themes(id) on delete set null;

create index if not exists themes_parent on public.themes(parent_id);
