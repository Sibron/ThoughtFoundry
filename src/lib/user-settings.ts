import { supabase } from './supabase'

interface UserSettingsRow {
  user_id: string
  ai_enabled: boolean
  // 'fast' | 'better'. Nullable here because a row read before the
  // 20260927 migration has no such column at all.
  ai_quality: string | null
  ai_persona: string | null
  ai_monthly_cap_usd: number
  display_density: string
  display_motion: string
  display_theme: string
  focus_mode: boolean
  review_weekday: number
}

export type UserSettingsPatch = Partial<Omit<UserSettingsRow, 'user_id'>>

// Singleton promise — settings are loaded once per session after login.
let loadPromise: Promise<void> | null = null

// Values that belong to the account rather than the device. A user who has
// never saved a setting has no user_settings row, so hydration leaves
// localStorage untouched -- and without this list the next person to log in
// on the same browser would inherit the previous one's AI switch, model
// quality, spend cap and persona. Display preferences are deliberately not
// cleared: they are cosmetic, and keeping them stops the login screen from
// flashing back to the default theme.
const ACCOUNT_KEYS = ['ai_enabled', 'ai_quality', 'ai_persona', 'ai_monthly_cap_usd', 'review_weekday']

/** Call on logout so the next user gets a fresh load and none of this one's settings. */
export function resetSettingsCache(): void {
  loadPromise = null
  for (const k of ACCOUNT_KEYS) localStorage.removeItem(k)
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
  // Only a recognised value is copied: never write "null" or junk, which
  // getAiQuality would read as 'fast' anyway but which would then shadow a
  // good local value.
  if (row.ai_quality === 'fast' || row.ai_quality === 'better') {
    localStorage.setItem('ai_quality', row.ai_quality)
  }
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
  localStorage.setItem('review_weekday', String(row.review_weekday ?? 0))
}

/** 0 = zondag … 6 = zaterdag (matches Date#getDay). */
export function getReviewWeekday(): number {
  const n = Number(localStorage.getItem('review_weekday'))
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : 0
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
