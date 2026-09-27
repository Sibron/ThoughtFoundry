-- Saving a note is one transaction: its fields, its themes and its projects (#55).
--
-- The editor used to save in three requests -- update the note, then replace
-- its note_themes, then replace its note_book_projects -- and each replace was
-- itself a delete followed by an insert. A dropped connection between any two
-- of those left a state nobody asked for: the content saved but the toast
-- saying "Opslaan mislukt", or, worst, the delete landed and the insert did
-- not, and the note silently lost every theme. On a phone on a train -- this
-- app's main context -- that is not hypothetical.
--
-- One function call is one statement, and so one transaction: all of it lands
-- or none of it does. The theme and project links are also diffed rather than
-- replaced, so a link that stays is never deleted and re-inserted.
--
-- SECURITY INVOKER, deliberately: atomicity needs a function, not elevated
-- rights, and running as the caller keeps RLS in force on every row this
-- touches (CLAUDE.md ground rule 2). The explicit user_id filters on themes and
-- book_projects are belt and braces for a caller whose role bypasses RLS.
-- execute is still revoked from anon, as for every function since
-- 20260720184137_security_hardening.
--
-- Arguments:
--   p_updates      the note columns to change, as JSON. A key that is absent
--                  keeps its current value; only the columns listed below can be
--                  changed at all (never embedding, user_id or timestamps).
--   p_theme_ids    the complete set of themes the note should have, or null to
--                  leave its themes alone. Ids that are not the caller's own
--                  themes are ignored.
--   p_project_ids  the same for book projects.
--
-- Idempotent: create or replace, and the grants are re-stated.

create or replace function public.save_note(
  p_id          uuid,
  p_updates     jsonb,
  p_theme_ids   uuid[] default null,
  p_project_ids uuid[] default null
)
returns setof public.notes
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  update public.notes n
     set (content, mini_notes, core_idea, use_for, source_id, source_url, source_title,
          source_author, status, ai_summary, ai_title, processed_at, section)
       = (select r.content, r.mini_notes, r.core_idea, r.use_for, r.source_id, r.source_url,
                 r.source_title, r.source_author, r.status, r.ai_summary, r.ai_title,
                 r.processed_at, r.section
            -- The current row is the base record, so a key missing from
            -- p_updates keeps its value rather than becoming null.
            from jsonb_populate_record(n, coalesce(p_updates, '{}'::jsonb)) r)
   where n.id = p_id
     and n.user_id = v_uid;

  if not found then
    raise exception 'note % not found', p_id using errcode = 'P0002';
  end if;

  if p_theme_ids is not null then
    delete from public.note_themes nt
     where nt.note_id = p_id
       and nt.theme_id <> all (p_theme_ids);
    insert into public.note_themes (note_id, theme_id, user_id)
    select p_id, t.id, v_uid
      from public.themes t
     where t.id = any (p_theme_ids)
       and t.user_id = v_uid
    on conflict (note_id, theme_id) do nothing;
  end if;

  if p_project_ids is not null then
    delete from public.note_book_projects np
     where np.note_id = p_id
       and np.project_id <> all (p_project_ids);
    insert into public.note_book_projects (note_id, project_id, user_id)
    select p_id, p.id, v_uid
      from public.book_projects p
     where p.id = any (p_project_ids)
       and p.user_id = v_uid
    on conflict (note_id, project_id) do nothing;
  end if;

  return query select * from public.notes where id = p_id;
end;
$$;

revoke execute on function public.save_note(uuid, jsonb, uuid[], uuid[]) from public, anon;
grant  execute on function public.save_note(uuid, jsonb, uuid[], uuid[]) to authenticated, service_role;
