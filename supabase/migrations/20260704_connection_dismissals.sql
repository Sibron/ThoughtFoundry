-- Verbindingen review queue: remember which suggested pairs the user rejected
-- so they never come back — on any device. Pairs are stored normalized
-- (a_id < b_id), matching the least/greatest convention of semantic_bridges
-- and the reverse-duplicate guard in src/lib/links.ts. Idempotent.

create table if not exists public.connection_dismissals (
  user_id    uuid not null references auth.users(id) on delete cascade,
  a_id       uuid not null,
  b_id       uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, a_id, b_id),
  check (a_id < b_id)
);

alter table public.connection_dismissals enable row level security;

do $$
begin
  drop policy if exists "connection_dismissals_select" on public.connection_dismissals;
  drop policy if exists "connection_dismissals_insert" on public.connection_dismissals;
  drop policy if exists "connection_dismissals_delete" on public.connection_dismissals;

  create policy "connection_dismissals_select" on public.connection_dismissals
    for select using (auth.uid() = user_id);
  create policy "connection_dismissals_insert" on public.connection_dismissals
    for insert with check (auth.uid() = user_id);
  create policy "connection_dismissals_delete" on public.connection_dismissals
    for delete using (auth.uid() = user_id);
end $$;
