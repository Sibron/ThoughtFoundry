-- Merge the free-form notes.types[] array into tags[] and drop the column.
-- The app no longer distinguishes "types" (content descriptors) from "tags";
-- a single editable tag list keeps the model coherent.

-- 1) Fold every existing type value into tags (deduplicated, order-stable).
update public.notes
set tags = (
  select array(
    select distinct t
    from unnest(coalesce(tags, '{}') || coalesce(types, '{}')) as t
    where t is not null and t <> ''
  )
)
where types is not null and array_length(types, 1) is not null;

-- 2) Drop the now-redundant column.
alter table public.notes drop column if exists types;
