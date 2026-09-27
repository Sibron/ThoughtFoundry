-- Manuscript per boekproject: the arranged order of its chapters. Chapters
-- reference the project via chapters.project_id (20260705); this array only
-- stores the user's ordering. Idempotent.

alter table public.book_projects
  add column if not exists chapter_order uuid[] not null default '{}';
