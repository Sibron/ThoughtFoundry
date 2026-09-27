-- Schrijfstudio: prose lives in real section rows instead of index-keyed
-- outline JSONB. Stable UUIDs per section make prose, note attachments and
-- revisions survive reordering; lightweight snapshot revisions give undo for
-- AI rewrites without CRDT complexity. chapters.project_id ties chapters into
-- the book-project pipeline. Idempotent.

-- ── Tables ──────────────────────────────────────────────────────────────────

create table if not exists public.chapter_sections (
  id         uuid primary key default gen_random_uuid(),
  chapter_id uuid not null references public.chapters(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  position   int not null default 0,
  heading    text not null,
  intent     text,
  note_ids   uuid[] not null default '{}',
  content_md text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.chapter_section_revisions (
  id         uuid primary key default gen_random_uuid(),
  section_id uuid not null references public.chapter_sections(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  content_md text not null,
  label      text,
  created_at timestamptz not null default now()
);

alter table public.chapters
  add column if not exists project_id uuid references public.book_projects(id) on delete set null;

-- ── Indexes ─────────────────────────────────────────────────────────────────

create index if not exists chapter_sections_chapter
  on public.chapter_sections(chapter_id, position);
create index if not exists chapter_section_revisions_section
  on public.chapter_section_revisions(section_id, created_at desc);
create index if not exists chapters_project
  on public.chapters(project_id) where project_id is not null;

-- ── updated_at trigger (reuses public.set_updated_at) ───────────────────────

drop trigger if exists chapter_sections_updated_at on public.chapter_sections;
create trigger chapter_sections_updated_at
  before update on public.chapter_sections
  for each row execute procedure public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────

alter table public.chapter_sections enable row level security;
alter table public.chapter_section_revisions enable row level security;

do $$
declare t text;
begin
  foreach t in array array['chapter_sections', 'chapter_section_revisions'] loop
    execute format('drop policy if exists "%s_select" on public.%I', t, t);
    execute format('drop policy if exists "%s_insert" on public.%I', t, t);
    execute format('drop policy if exists "%s_update" on public.%I', t, t);
    execute format('drop policy if exists "%s_delete" on public.%I', t, t);

    execute format('create policy "%s_select" on public.%I for select using (auth.uid() = user_id)', t, t);
    execute format('create policy "%s_insert" on public.%I for insert with check (auth.uid() = user_id)', t, t);
    execute format('create policy "%s_update" on public.%I for update using (auth.uid() = user_id)', t, t);
    execute format('create policy "%s_delete" on public.%I for delete using (auth.uid() = user_id)', t, t);
  end loop;
end $$;

-- ── Backfill: explode existing outline JSONB into section rows ──────────────
-- Runs once per chapter (skipped when the chapter already has rows), so the
-- migration is safe to re-apply.

insert into public.chapter_sections (chapter_id, user_id, position, heading, intent, note_ids)
select c.id,
       c.user_id,
       s.ord - 1,
       coalesce(s.elem->>'heading', 'Sectie ' || s.ord),
       s.elem->>'intent',
       coalesce(
         (select array_agg(v::uuid) from jsonb_array_elements_text(coalesce(s.elem->'note_ids', '[]'::jsonb)) as v),
         '{}'
       )
from public.chapters c,
     lateral jsonb_array_elements(c.outline) with ordinality as s(elem, ord)
where jsonb_typeof(c.outline) = 'array'
  and not exists (select 1 from public.chapter_sections cs where cs.chapter_id = c.id);
