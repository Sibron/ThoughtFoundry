// Display preferences — density + motion. Stored locally (per-device), applied
// as attributes/classes on <html> so plain CSS does the rest. ND-friendly:
// the user controls visual density and whether the UI animates at all.

export type Density = 'comfortabel' | 'compact'
export type Motion = 'auto' | 'reduced'

const DENSITY_KEY = 'display_density'
const MOTION_KEY = 'display_motion'

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

/** Reflect the stored preferences onto <html>. Safe to call repeatedly. */
export function applyDisplayPrefs(): void {
  const root = document.documentElement
  root.setAttribute('data-density', getDensity())
  root.classList.toggle('reduce-motion', getMotion() === 'reduced')
}
