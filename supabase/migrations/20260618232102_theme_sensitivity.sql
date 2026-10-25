-- A theme can be marked sensitive. process-note tags such themes [GEVOELIG] in
-- its prompt, so notes under them get focused, closing suggestions rather than
-- open questions. Defaults to false; idempotent. (Header added 2026-09, #49.)

alter table public.themes
  add column if not exists is_sensitive boolean not null default false;
