-- ThoughtFoundry — Full schema (Phase 1 + 2 + 3 + 4)
-- Run this in Supabase SQL Editor.
-- Phase 2+ extras (themes, note_links, embeddings, ai_usage) are additive
-- and can be applied later without breaking Phase 1.

-- ── Extensions ──────────────────────────────────────────────────────────────
create extension if not exists "pgcrypto";

-- pgvector is required for Phase 2 similarity search.
-- If your region doesn't ship it, comment the next line out — the rest of
-- the schema still applies; the embedding column just won't exist.
create extension if not exists "vector";

-- ── Phase 1: notes ──────────────────────────────────────────────────────────
create table if not exists public.notes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  content      text not null,
  mini_notes   text,
  status       text not null default 'inbox' check (status in ('inbox', 'verwerkt', 'archief')),
  types        text[] not null default '{}',
  tags         text[] not null default '{}',
  source_url   text,
  source_title text,
  source_author text,
  ai_summary   text,
  ai_title     text,
  processed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Phase 2 columns (add if upgrading an existing Phase 1 install)
alter table public.notes add column if not exists ai_title text;
alter table public.notes add column if not exists processed_at timestamptz;

-- Add embedding column only if pgvector is available
do $$
begin
  if exists (select 1 from pg_extension where extname = 'vector') then
    execute 'alter table public.notes add column if not exists embedding vector(1024)';
  end if;
end $$;

-- ── Phase 2: themes ─────────────────────────────────────────────────────────
create table if not exists public.themes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  description text,
  color       text not null default '#3AC48D',
  created_at  timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.note_themes (
  note_id  uuid not null references public.notes(id) on delete cascade,
  theme_id uuid not null references public.themes(id) on delete cascade,
  user_id  uuid not null references auth.users(id) on delete cascade,
  primary key (note_id, theme_id)
);

-- ── Phase 3: note_links (Zettelkasten links) ────────────────────────────────
create table if not exists public.note_links (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  source_id   uuid not null references public.notes(id) on delete cascade,
  target_id   uuid not null references public.notes(id) on delete cascade,
  reason      text,
  created_at  timestamptz not null default now(),
  check (source_id <> target_id),
  unique (source_id, target_id)
);

-- ── Phase 2: AI usage / cost tracking ───────────────────────────────────────
create table if not exists public.ai_usage (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  model           text not null,
  operation       text not null,
  input_tokens    int  not null default 0,
  output_tokens   int  not null default 0,
  cost_usd        numeric(10, 6) not null default 0,
  created_at      timestamptz not null default now()
);

-- ── Phase 4: chapter outlines ───────────────────────────────────────────────
create table if not exists public.chapters (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  theme_id    uuid references public.themes(id) on delete set null,
  title       text not null,
  summary     text,
  outline     jsonb not null default '[]'::jsonb,
  note_ids    uuid[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── Phase 6: per-user settings (e.g. monthly cap) ───────────────────────────
create table if not exists public.user_settings (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  monthly_cap_usd  numeric(10, 2) not null default 5,
  updated_at       timestamptz not null default now()
);

-- ── Phase 5: book bundles (multi-chapter) ───────────────────────────────────
create table if not exists public.books (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null,
  intro       text,
  chapter_ids uuid[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── updated_at trigger function ─────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists notes_updated_at on public.notes;
create trigger notes_updated_at
  before update on public.notes
  for each row execute procedure public.set_updated_at();

drop trigger if exists chapters_updated_at on public.chapters;
create trigger chapters_updated_at
  before update on public.chapters
  for each row execute procedure public.set_updated_at();

drop trigger if exists books_updated_at on public.books;
create trigger books_updated_at
  before update on public.books
  for each row execute procedure public.set_updated_at();

drop trigger if exists user_settings_updated_at on public.user_settings;
create trigger user_settings_updated_at
  before update on public.user_settings
  for each row execute procedure public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.notes         enable row level security;
alter table public.themes        enable row level security;
alter table public.note_themes   enable row level security;
alter table public.note_links    enable row level security;
alter table public.ai_usage      enable row level security;
alter table public.chapters      enable row level security;
alter table public.books         enable row level security;
alter table public.user_settings enable row level security;

-- Helper: drop policy if exists, then recreate (idempotent re-runs)
do $$
declare t text;
begin
  for t in select unnest(array[
    'notes', 'themes', 'note_themes', 'note_links', 'ai_usage', 'chapters', 'books', 'user_settings'
  ]) loop
    execute format('drop policy if exists "own select" on public.%I', t);
    execute format('drop policy if exists "own insert" on public.%I', t);
    execute format('drop policy if exists "own update" on public.%I', t);
    execute format('drop policy if exists "own delete" on public.%I', t);
  end loop;
end $$;

create policy "own select" on public.notes       for select using (auth.uid() = user_id);
create policy "own insert" on public.notes       for insert with check (auth.uid() = user_id);
create policy "own update" on public.notes       for update using (auth.uid() = user_id);
create policy "own delete" on public.notes       for delete using (auth.uid() = user_id);

create policy "own select" on public.themes      for select using (auth.uid() = user_id);
create policy "own insert" on public.themes      for insert with check (auth.uid() = user_id);
create policy "own update" on public.themes      for update using (auth.uid() = user_id);
create policy "own delete" on public.themes      for delete using (auth.uid() = user_id);

create policy "own select" on public.note_themes for select using (auth.uid() = user_id);
create policy "own insert" on public.note_themes for insert with check (auth.uid() = user_id);
create policy "own update" on public.note_themes for update using (auth.uid() = user_id);
create policy "own delete" on public.note_themes for delete using (auth.uid() = user_id);

create policy "own select" on public.note_links  for select using (auth.uid() = user_id);
create policy "own insert" on public.note_links  for insert with check (auth.uid() = user_id);
create policy "own update" on public.note_links  for update using (auth.uid() = user_id);
create policy "own delete" on public.note_links  for delete using (auth.uid() = user_id);

create policy "own select" on public.ai_usage    for select using (auth.uid() = user_id);
create policy "own insert" on public.ai_usage    for insert with check (auth.uid() = user_id);
create policy "own update" on public.ai_usage    for update using (auth.uid() = user_id);
create policy "own delete" on public.ai_usage    for delete using (auth.uid() = user_id);

create policy "own select" on public.chapters    for select using (auth.uid() = user_id);
create policy "own insert" on public.chapters    for insert with check (auth.uid() = user_id);
create policy "own update" on public.chapters    for update using (auth.uid() = user_id);
create policy "own delete" on public.chapters    for delete using (auth.uid() = user_id);

create policy "own select" on public.books       for select using (auth.uid() = user_id);
create policy "own insert" on public.books       for insert with check (auth.uid() = user_id);
create policy "own update" on public.books       for update using (auth.uid() = user_id);
create policy "own delete" on public.books       for delete using (auth.uid() = user_id);

create policy "own select" on public.user_settings for select using (auth.uid() = user_id);
create policy "own insert" on public.user_settings for insert with check (auth.uid() = user_id);
create policy "own update" on public.user_settings for update using (auth.uid() = user_id);
create policy "own delete" on public.user_settings for delete using (auth.uid() = user_id);

-- ── Indexes ─────────────────────────────────────────────────────────────────
create index if not exists notes_user_created     on public.notes(user_id, created_at desc);
create index if not exists notes_user_status      on public.notes(user_id, status);
create index if not exists themes_user            on public.themes(user_id);
create index if not exists note_themes_theme      on public.note_themes(theme_id);
create index if not exists note_themes_note       on public.note_themes(note_id);
create index if not exists note_links_source      on public.note_links(source_id);
create index if not exists note_links_target      on public.note_links(target_id);
create index if not exists ai_usage_user_created  on public.ai_usage(user_id, created_at desc);
create index if not exists chapters_user_theme    on public.chapters(user_id, theme_id);
create index if not exists books_user_created     on public.books(user_id, created_at desc);

-- Vector index (only if pgvector is available)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'vector') then
    execute 'create index if not exists notes_embedding_idx
             on public.notes using ivfflat (embedding vector_cosine_ops) with (lists = 100)';
  end if;
end $$;

-- ── RPC: cosine-similar notes ───────────────────────────────────────────────
-- Returns the N notes most similar to a given query embedding (excluding self).
-- Safe to call even without pgvector — it just returns nothing.
create or replace function public.match_notes(
  query_embedding vector(1024),
  match_count int default 5,
  exclude_id uuid default null
)
returns table (id uuid, content text, similarity float)
language sql stable as $$
  select n.id, n.content, 1 - (n.embedding <=> query_embedding) as similarity
  from public.notes n
  where n.user_id = auth.uid()
    and n.embedding is not null
    and (exclude_id is null or n.id <> exclude_id)
  order by n.embedding <=> query_embedding
  limit match_count
$$;

-- ── RPC: monthly AI cost ────────────────────────────────────────────────────
create or replace function public.ai_cost_this_month()
returns numeric language sql stable as $$
  select coalesce(sum(cost_usd), 0)
  from public.ai_usage
  where user_id = auth.uid()
    and created_at >= date_trunc('month', now())
$$;

-- ── RPC: merge two themes ───────────────────────────────────────────────────
-- Moves all note_themes from source → target, then deletes the source theme.
-- Skips notes already linked to both (unique constraint).
create or replace function public.merge_themes(p_source uuid, p_target uuid)
returns void language plpgsql as $$
begin
  if p_source = p_target then return; end if;
  -- Verify ownership for both themes (defence in depth on top of RLS)
  if not exists (select 1 from public.themes where id = p_source and user_id = auth.uid())
     or not exists (select 1 from public.themes where id = p_target and user_id = auth.uid()) then
    raise exception 'Theme not found or not owned';
  end if;

  update public.note_themes
     set theme_id = p_target
   where theme_id = p_source
     and user_id = auth.uid()
     and note_id not in (
       select note_id from public.note_themes
       where theme_id = p_target and user_id = auth.uid()
     );

  delete from public.note_themes where theme_id = p_source and user_id = auth.uid();
  delete from public.themes      where id = p_source       and user_id = auth.uid();
end;
$$;

-- ── RPC: similar notes by id ────────────────────────────────────────────────
-- Convenience over match_notes(): looks up the embedding for the given note
-- and returns the closest others. Only created if pgvector is installed.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'vector') then
    execute $func$
      create or replace function public.similar_to_note(
        p_note_id uuid,
        match_count int default 5
      )
      returns table (id uuid, content text, ai_title text, similarity float)
      language plpgsql stable as $body$
      declare
        v_embedding vector(1024);
      begin
        select embedding into v_embedding
        from public.notes
        where id = p_note_id and user_id = auth.uid();
        if v_embedding is null then return; end if;
        return query
          select n.id, n.content, n.ai_title, 1 - (n.embedding <=> v_embedding) as similarity
          from public.notes n
          where n.user_id = auth.uid()
            and n.embedding is not null
            and n.id <> p_note_id
          order by n.embedding <=> v_embedding
          limit match_count;
      end;
      $body$;
    $func$;
  else
    -- Stub so frontend RPC call returns empty gracefully without error.
    execute $func$
      create or replace function public.similar_to_note(
        p_note_id uuid,
        match_count int default 5
      )
      returns table (id uuid, content text, ai_title text, similarity float)
      language sql stable as $body$ select null::uuid, null::text, null::text, null::float where false $body$;
    $func$;
  end if;
end $$;
