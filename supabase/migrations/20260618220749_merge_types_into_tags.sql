-- Merge the free-form notes.types[] array into tags[] and drop the column.
-- The app no longer distinguishes "types" (content descriptors) from "tags";
-- a single editable tag list keeps the model coherent.

-- 1) Fold every existing type value into tags (deduplicated, order-stable).
--
-- Guarded (2026-09, #49): on a database built fresh from schema.sql neither
-- column exists -- `tags` was later retired too (20260718220604_simplify_model)
-- -- and the bare update failed there, stopping a replay of this directory at
-- this file. Where both columns exist, it does exactly what it always did.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'notes' and column_name = 'types')
     and exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'notes' and column_name = 'tags') then
    update public.notes
    set tags = (
      select array(
        select distinct t
        from unnest(coalesce(tags, '{}') || coalesce(types, '{}')) as t
        where t is not null and t <> ''
      )
    )
    where types is not null and array_length(types, 1) is not null;
  end if;
end $$;

-- 2) Drop the now-redundant column.
alter table public.notes drop column if exists types;
