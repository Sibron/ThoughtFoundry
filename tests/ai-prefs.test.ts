import { beforeEach, describe, expect, it, vi } from 'vitest'

const saveUserSetting = vi.fn()
vi.mock('../src/lib/user-settings', () => ({ saveUserSetting: (...a: unknown[]) => saveUserSetting(...a) }))

const { getAiQuality, setAiQuality, setAiEnabled } = await import('../src/lib/ai-prefs')

beforeEach(() => {
  localStorage.clear()
  saveUserSetting.mockReset().mockResolvedValue(undefined)
})

describe('getAiQuality', () => {
  it("is 'better' only for an explicit 'better'", () => {
    localStorage.setItem('ai_quality', 'better')
    expect(getAiQuality()).toBe('better')
  })

  it("falls back to 'fast' for unset, empty, 'null' and junk", () => {
    expect(getAiQuality()).toBe('fast')
    for (const v of ['', 'null', 'BETTER', 'sonnet']) {
      localStorage.setItem('ai_quality', v)
      expect(getAiQuality()).toBe('fast')
    }
  })
})

describe('setAiQuality', () => {
  it('stores locally and mirrors to user_settings, like its neighbours', () => {
    setAiQuality('better')
    expect(localStorage.getItem('ai_quality')).toBe('better')
    expect(saveUserSetting).toHaveBeenCalledWith({ ai_quality: 'better' })
  })

  it('keeps the local choice when the save fails (offline)', async () => {
    saveUserSetting.mockRejectedValue(new Error('offline'))
    expect(() => setAiQuality('better')).not.toThrow()
    await Promise.resolve()
    expect(getAiQuality()).toBe('better')
  })

  it('matches setAiEnabled, which always mirrored', () => {
    setAiEnabled(true)
    expect(saveUserSetting).toHaveBeenCalledWith({ ai_enabled: true })
  })
})
