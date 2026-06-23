import { supabase } from './supabase'

interface UserSettingsRow {
  user_id: string
  ai_enabled: boolean
  ai_persona: string | null
  ai_monthly_cap_usd: number
  display_density: string
  display_motion: string
  display_theme: string
  focus_mode: boolean
}

export type UserSettingsPatch = Partial<Omit<UserSettingsRow, 'user_id'>>

// Singleton promise — settings are loaded once per session after login.
let loadPromise: Promise<void> | null = null

/** Call on logout so the next user gets a fresh load. */
export function resetSettingsCache(): void {
  loadPromise = null
}

/**
 * Fetch the user's settings from Supabase and write them into localStorage.
 * Safe to call on every route navigation — the actual network fetch only
 * happens once per session due to the singleton promise.
 */
export async function loadUserSettings(): Promise<void> {
  if (loadPromise) return loadPromise
  loadPromise = _fetchAndApply()
  return loadPromise
}

async function _fetchAndApply(): Promise<void> {
  const { data, error } = await supabase
    .from('user_settings')
    .select('*')
    .maybeSingle()

  if (error || !data) return

  const row = data as UserSettingsRow
  localStorage.setItem('ai_enabled', row.ai_enabled ? 'true' : 'false')
  if (row.ai_persona != null) {
    localStorage.setItem('ai_persona', row.ai_persona)
  } else {
    localStorage.removeItem('ai_persona')
  }
  localStorage.setItem('ai_monthly_cap_usd', String(row.ai_monthly_cap_usd))
  localStorage.setItem('display_density', row.display_density)
  localStorage.setItem('display_motion', row.display_motion)
  localStorage.setItem('tf-theme', row.display_theme)
  localStorage.setItem('tf-focus', row.focus_mode ? 'true' : 'false')
}

/**
 * Persist a partial settings update to Supabase.
 * Fire-and-forget safe: callers can .catch(() => {}) and carry on.
 */
export async function saveUserSetting(patch: UserSettingsPatch): Promise<void> {
  const { data: authData } = await supabase.auth.getUser()
  if (!authData.user) return
  await supabase
    .from('user_settings')
    .upsert({ user_id: authData.user.id, ...patch }, { onConflict: 'user_id' })
}
