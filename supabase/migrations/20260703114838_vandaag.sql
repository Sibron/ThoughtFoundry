-- "Vandaag" dashboard: book projects are the goal spine, so they get an
-- optional target date; the weekly review gets a configurable weekday.
-- Idempotent.

alter table public.book_projects
  add column if not exists target_date date;

-- 0 = zondag … 6 = zaterdag (JS Date#getDay convention).
alter table public.user_settings
  add column if not exists review_weekday int not null default 0;
