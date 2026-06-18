-- Add link type to note_links (Zettelkasten typed relationships)
alter table public.note_links
  add column if not exists type text not null default 'related'
  check (type in ('builds_on', 'contradicts', 'example_of', 'contrasts', 'applies_to', 'related'));

-- Add index for fast source lookups
create index if not exists notes_source_url on public.notes (user_id, source_url) where source_url is not null;
