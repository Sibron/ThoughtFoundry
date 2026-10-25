-- The parts of a Supabase project that the migrations assume but do not
-- create, so they can be replayed on a plain Postgres with pgvector: the API
-- roles, the auth schema with auth.users and auth.uid(), and the `extensions`
-- schema that pgvector is installed into. auth.uid() reads the JWT subject the
-- way PostgREST passes it.
--
-- Used only by replay-migrations.sh. Nothing here is deployed.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

create schema if not exists auth;
create schema if not exists extensions;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth, extensions, public to anon, authenticated, service_role;
