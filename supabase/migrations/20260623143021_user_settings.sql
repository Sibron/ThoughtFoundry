-- Per-account preferences (AI switch, persona, spend cap, display), so they
-- follow the user across devices instead of living only in one browser's
-- localStorage. One row per user, keyed on user_id; RLS limits each user to
-- their own row.
--
-- Made re-runnable in 2026-09 (#49): the policies and trigger are dropped
-- before they are created, so replaying the directory twice no longer stops
-- here with "policy already exists". Idempotent.

CREATE TABLE IF NOT EXISTS public.user_settings (
  user_id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  ai_enabled         boolean NOT NULL DEFAULT false,
  ai_persona         text,
  ai_monthly_cap_usd numeric(10,2) NOT NULL DEFAULT 5,
  display_density    text NOT NULL DEFAULT 'comfortabel',
  display_motion     text NOT NULL DEFAULT 'auto',
  display_theme      text NOT NULL DEFAULT 'auto',
  focus_mode         boolean NOT NULL DEFAULT false,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_settings_select" ON public.user_settings;
CREATE POLICY "user_settings_select" ON public.user_settings
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_settings_insert" ON public.user_settings;
CREATE POLICY "user_settings_insert" ON public.user_settings
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_settings_update" ON public.user_settings;
CREATE POLICY "user_settings_update" ON public.user_settings
  FOR UPDATE USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.touch_user_settings_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_settings_updated_at ON public.user_settings;
CREATE TRIGGER user_settings_updated_at
  BEFORE UPDATE ON public.user_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_user_settings_updated_at();
