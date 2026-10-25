#!/usr/bin/env bash
# Rebuilds the schema from nothing -- supabase/schema.sql, then every migration
# in filename order -- and then applies every migration a second time.
#
# The first pass proves the directory can build a new project (#49): a fix
# that sorts before what it fixes, or a migration that assumes a column only
# the live database still has, fails here. The second pass proves every file
# survives a re-run, which CLAUDE.md requires because migrations are re-applied
# by hand. Neither can be seen from `npm run build`.
#
# Needs a Postgres with pgvector and the usual PG* environment variables
# (PGHOST, PGUSER, PGPASSWORD, ...). Creates and uses a database called
# `replay`.
set -euo pipefail
cd "$(dirname "$0")/../.."

export PGOPTIONS='-c client_min_messages=warning'
run() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }

run -d postgres -c 'drop database if exists replay' -c 'create database replay'
export PGDATABASE=replay
run -f .github/scripts/supabase-stub.sql
run -c 'alter database replay set search_path = "$user", public, extensions'
run -f supabase/schema.sql

for pass in 1 2; do
  for f in supabase/migrations/*.sql; do
    if ! out=$(run -f "$f" 2>&1); then
      echo "$out"
      echo "::error file=$f::migration failed on pass $pass (1 = fresh build, 2 = re-run)"
      exit 1
    fi
  done
  echo "pass $pass: $(ls supabase/migrations/*.sql | wc -l) migrations applied"
done
