alter table public.themes
  add column if not exists is_sensitive boolean not null default false;
