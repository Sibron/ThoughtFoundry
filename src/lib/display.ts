// Display preferences — density, motion, theme, focus mode. Stored locally
// (per-device), applied as attributes/classes on <html> so plain CSS does the rest.

export type Density = 'comfortabel' | 'compact'
export type Motion = 'auto' | 'reduced'
export type Theme = 'auto' | 'dark' | 'light'

const DENSITY_KEY = 'display_density'
const MOTION_KEY = 'display_motion'
const THEME_KEY = 'tf-theme'
const FOCUS_KEY = 'tf-focus'

export function getDensity(): Density {
  return localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortabel'
}

export function setDensity(d: Density): void {
  localStorage.setItem(DENSITY_KEY, d)
  applyDisplayPrefs()
}

export function getMotion(): Motion {
  return localStorage.getItem(MOTION_KEY) === 'reduced' ? 'reduced' : 'auto'
}

export function setMotion(m: Motion): void {
  localStorage.setItem(MOTION_KEY, m)
  applyDisplayPrefs()
}

export function getTheme(): Theme {
  const v = localStorage.getItem(THEME_KEY)
  return v === 'dark' || v === 'light' ? v : 'auto'
}

export function setTheme(t: Theme): void {
  localStorage.setItem(THEME_KEY, t)
  applyDisplayPrefs()
}

export function getFocusMode(): boolean {
  return localStorage.getItem(FOCUS_KEY) === 'true'
}

export function setFocusMode(on: boolean): void {
  localStorage.setItem(FOCUS_KEY, on ? 'true' : 'false')
  applyDisplayPrefs()
}

/** Reflect stored preferences onto <html>. Safe to call repeatedly. */
export function applyDisplayPrefs(): void {
  const root = document.documentElement
  root.setAttribute('data-density', getDensity())
  root.classList.toggle('reduce-motion', getMotion() === 'reduced')
  const theme = getTheme()
  if (theme === 'auto') {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', theme)
  }
  root.setAttribute('data-focus-mode', getFocusMode() ? 'on' : 'off')
}
