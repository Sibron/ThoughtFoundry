-- ThoughtFoundry Phase 1 Schema
-- Run this in Supabase SQL Editor

-- Enable UUID extension
create extension if not exists "pgcrypto";

-- Notes table
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
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Auto-update updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger notes_updated_at
  before update on public.notes
  for each row execute procedure public.set_updated_at();

-- Row Level Security
alter table public.notes enable row level security;

-- Users can only see/modify their own notes
create policy "Users can select own notes"
  on public.notes for select
  using (auth.uid() = user_id);

create policy "Users can insert own notes"
  on public.notes for insert
  with check (auth.uid() = user_id);

create policy "Users can update own notes"
  on public.notes for update
  using (auth.uid() = user_id);

create policy "Users can delete own notes"
  on public.notes for delete
  using (auth.uid() = user_id);

-- Index for performance
create index if not exists notes_user_created on public.notes(user_id, created_at desc);
