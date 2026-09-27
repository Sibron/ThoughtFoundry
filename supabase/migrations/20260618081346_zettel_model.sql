-- ── Workstream A: Semantic note model ──────────────────────────────────────
-- Add note_type (6 Zettelkasten types), core_idea (≤280-char kernel),
-- use_for ("Gebruik voor"), and source_id FK (Workstream B)

alter table public.notes
  add column if not exists note_type text not null default 'fleeting'
  check (note_type in ('fleeting','question','literature','permanent','reflection','framework'));

alter table public.notes
  add column if not exists core_idea text;

alter table public.notes
  add column if not exists use_for text;

-- ── Workstream B: Sources / Bibliotheek ─────────────────────────────────────
create table if not exists public.sources (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null,
  author      text,
  type        text not null default 'book'
              check (type in ('book','article','paper','podcast','video','course','other')),
  year        text,
  url         text,
  summary     text,
  tags        text[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists sources_updated_at on public.sources;
create trigger sources_updated_at
  before update on public.sources
  for each row execute procedure public.set_updated_at();

create index if not exists sources_user on public.sources(user_id);

alter table public.notes
  add column if not exists source_id uuid references public.sources(id) on delete set null;

create index if not exists notes_source_id on public.notes(source_id) where source_id is not null;

-- ── Workstream C: Book Projects ──────────────────────────────────────────────
create table if not exists public.book_projects (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  title          text not null,
  core_question  text not null,
  description    text,
  status         text not null default 'exploring'
                 check (status in ('exploring','active','dormant','archived')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

drop trigger if exists book_projects_updated_at on public.book_projects;
create trigger book_projects_updated_at
  before update on public.book_projects
  for each row execute procedure public.set_updated_at();

create index if not exists book_projects_user on public.book_projects(user_id);

-- Many-to-many: notes ↔ book_projects
create table if not exists public.note_book_projects (
  note_id     uuid not null references public.notes(id) on delete cascade,
  project_id  uuid not null references public.book_projects(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  primary key (note_id, project_id)
);

create index if not exists nbp_project on public.note_book_projects(project_id);
create index if not exists nbp_note    on public.note_book_projects(note_id);

-- ── RLS: sources ────────────────────────────────────────────────────────────
alter table public.sources            enable row level security;
alter table public.book_projects      enable row level security;
alter table public.note_book_projects enable row level security;

do $$
declare t text;
begin
  for t in select unnest(array['sources','book_projects','note_book_projects']) loop
    execute format('drop policy if exists "own select" on public.%I', t);
    execute format('drop policy if exists "own insert" on public.%I', t);
    execute format('drop policy if exists "own update" on public.%I', t);
    execute format('drop policy if exists "own delete" on public.%I', t);
  end loop;
end $$;

create policy "own select" on public.sources            for select using (auth.uid() = user_id);
create policy "own insert" on public.sources            for insert with check (auth.uid() = user_id);
create policy "own update" on public.sources            for update using (auth.uid() = user_id);
create policy "own delete" on public.sources            for delete using (auth.uid() = user_id);

create policy "own select" on public.book_projects      for select using (auth.uid() = user_id);
create policy "own insert" on public.book_projects      for insert with check (auth.uid() = user_id);
create policy "own update" on public.book_projects      for update using (auth.uid() = user_id);
create policy "own delete" on public.book_projects      for delete using (auth.uid() = user_id);

create policy "own select" on public.note_book_projects for select using (auth.uid() = user_id);
create policy "own insert" on public.note_book_projects for insert with check (auth.uid() = user_id);
create policy "own update" on public.note_book_projects for update using (auth.uid() = user_id);
create policy "own delete" on public.note_book_projects for delete using (auth.uid() = user_id);
