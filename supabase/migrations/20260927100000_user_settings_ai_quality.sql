-- AI quality ("Snel" / "Beter") follows the account, like every other preference.
--
-- Every setting is written to localStorage for instant reads and mirrored to
-- user_settings so it survives a new device, another browser or cleared site
-- data -- except ai_quality, which only ever lived in localStorage (#58). It is
-- the one choice that picks the model for every AI call, and so what every call
-- costs: set "Beter" on the laptop, capture from the phone, and the phone
-- quietly used the fast model.
--
-- Existing rows get 'fast', which is what the client already assumed for an
-- unset value. No RLS change: user_settings is already user_id-scoped.
-- Idempotent.

alter table public.user_settings
  add column if not exists ai_quality text not null default 'fast';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_settings_ai_quality_check'
      and conrelid = 'public.user_settings'::regclass
  ) then
    alter table public.user_settings
      add constraint user_settings_ai_quality_check check (ai_quality in ('fast', 'better'));
  end if;
end $$;
