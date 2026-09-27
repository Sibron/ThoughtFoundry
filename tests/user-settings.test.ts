import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fake } from './helpers/fake-supabase'

vi.mock('../src/lib/supabase', async (orig) => ({
  ...(await orig<typeof import('../src/lib/supabase')>()),
  supabase: (await import('./helpers/fake-supabase')).fake.client,
}))

const { loadUserSettings, resetSettingsCache, saveUserSetting } = await import('../src/lib/user-settings')
const { getAiQuality } = await import('../src/lib/ai-prefs')

const row = (extra: Record<string, unknown> = {}) => ({
  user_id: 'user-a', ai_enabled: true, ai_persona: null, ai_monthly_cap_usd: 5,
  display_density: 'comfortabel', display_motion: 'auto', display_theme: 'auto',
  focus_mode: false, review_weekday: 0, ...extra,
})

beforeEach(() => {
  fake.reset()
  localStorage.clear()
  resetSettingsCache()
})

describe('hydrating ai_quality', () => {
  it('copies the account value into localStorage', async () => {
    fake.seed('user_settings', [row({ ai_quality: 'better' })])
    await loadUserSettings()
    expect(localStorage.getItem('ai_quality')).toBe('better')
    expect(getAiQuality()).toBe('better')
  })

  it('tolerates a row from before the column existed, without writing "null"', async () => {
    localStorage.setItem('ai_quality', 'better')
    fake.seed('user_settings', [row()])
    await loadUserSettings()
    expect(localStorage.getItem('ai_quality')).toBe('better')

    resetSettingsCache()
    fake.reset()
    fake.seed('user_settings', [row({ ai_quality: null })])
    await loadUserSettings()
    expect(localStorage.getItem('ai_quality')).toBeNull()
    expect(getAiQuality()).toBe('fast')
  })

  it('ignores an unrecognised stored value', async () => {
    fake.seed('user_settings', [row({ ai_quality: 'turbo' })])
    await loadUserSettings()
    expect(localStorage.getItem('ai_quality')).toBeNull()
    expect(getAiQuality()).toBe('fast')
  })

  it('round-trips through saveUserSetting', async () => {
    await saveUserSetting({ ai_quality: 'better' })
    localStorage.clear()
    await loadUserSettings()
    expect(getAiQuality()).toBe('better')
  })
})

describe('logging out', () => {
  it("does not hand one account's AI settings to the next", async () => {
    fake.seed('user_settings', [row({ ai_quality: 'better', ai_persona: 'coach', ai_monthly_cap_usd: 50 })])
    await loadUserSettings()
    expect(localStorage.getItem('ai_enabled')).toBe('true')

    resetSettingsCache()
    // The next user has never saved a setting, so there is no row to hydrate from.
    fake.userId = 'user-b'
    await loadUserSettings()

    for (const k of ['ai_enabled', 'ai_quality', 'ai_persona', 'ai_monthly_cap_usd']) {
      expect(localStorage.getItem(k), k).toBeNull()
    }
    expect(getAiQuality()).toBe('fast')
  })
})
