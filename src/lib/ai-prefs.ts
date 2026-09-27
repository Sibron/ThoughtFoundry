import { saveUserSetting } from './user-settings'

// The two app-wide AI preferences. Like every other preference they are read
// from localStorage -- instant, and available offline -- and mirrored to
// user_settings so they follow the account to another device. They lived in
// nav.ts until 2026-09, which is how setAiQuality came to be the one setting
// that skipped the mirror (#58).

// ── AI feature flag ───────────────────────────────────────────────────────
// AI (process / graph / book generation) is OFF by default. The core
// capture → inbox → organise loop works fully without it. The user opts in
// from Settings; only then do the AI nav items and edge-function calls appear.

const AI_ENABLED_KEY = 'ai_enabled'

export function isAiEnabled(): boolean {
  return localStorage.getItem(AI_ENABLED_KEY) === 'true'
}

export function setAiEnabled(on: boolean): void {
  localStorage.setItem(AI_ENABLED_KEY, on ? 'true' : 'false')
  saveUserSetting({ ai_enabled: on }).catch(() => {})
}

// One app-wide quality preference replaces the per-action model picker that
// used to appear on every AI surface — the user decides once, in Instellingen,
// instead of eleven times mid-flow. It picks the model for every AI call, so it
// decides what each call costs.
const AI_QUALITY_KEY = 'ai_quality'

export type AiQuality = 'fast' | 'better'

/** Anything but an explicit 'better' -- unset, empty, junk -- means 'fast'. */
export function getAiQuality(): AiQuality {
  return localStorage.getItem(AI_QUALITY_KEY) === 'better' ? 'better' : 'fast'
}

export function setAiQuality(q: AiQuality): void {
  localStorage.setItem(AI_QUALITY_KEY, q)
  saveUserSetting({ ai_quality: q }).catch(() => {})
}
