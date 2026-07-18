import { navigateTo } from '../router'
import { signOut } from './auth'
import { getFocusMode, setFocusMode } from './display'
import { saveUserSetting, resetSettingsCache } from './user-settings'
import { clearCache } from './cache'

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
// instead of eleven times mid-flow.
const AI_QUALITY_KEY = 'ai_quality'

export type AiQuality = 'fast' | 'better'

export function getAiQuality(): AiQuality {
  return localStorage.getItem(AI_QUALITY_KEY) === 'better' ? 'better' : 'fast'
}

export function setAiQuality(q: AiQuality): void {
  localStorage.setItem(AI_QUALITY_KEY, q)
}

// ── Guidance Banner ───────────────────────────────────────────────────────

/**
 * Returns a GuidanceBanner HTML string.
 * anchor: left-border accent variant for primary capture/focus screens.
 * quiet: subtle surface-2 variant for browse/overview screens.
 */
export function renderGuidanceBanner(text: string, tone: 'anchor' | 'quiet' = 'quiet'): string {
  const cls = tone === 'anchor' ? 'guidance-banner guidance-banner--anchor' : 'guidance-banner'
  return `<div class="${cls}" role="complementary" aria-label="Wat nu te doen">${text}</div>`
}

// ── Navigation ────────────────────────────────────────────────────────────

export type NavKey = 'vandaag' | 'capture' | 'inbox' | 'process' | 'settings' | 'denktools' | 'library' | 'verbanden' | 'studio'

/**
 * Render the slim sticky header + fixed bottom tab bar.
 * Signature is unchanged: `title` shows in the header, `active` highlights
 * the matching tab, `extra` is injected into the header actions (e.g. online indicator).
 */
// The bottom bar IS the core flow: Vangen → Vangbak → Verwerken → Verbanden.
// Verwerken only shows when AI is on (the bar drops to 4 columns without it).
// Everything else (Vandaag, Bibliotheek, Schrijfstudio, Denktools,
// Instellingen) lives behind the "Meer" overflow sheet. Zoeken is the topbar
// overlay on every screen.
const PRIMARY_TABS: NavKey[] = ['capture', 'inbox', 'process', 'verbanden']

const TAB_LABELS: Record<string, string> = {
  capture: 'Vangen',
  inbox: 'Vangbak',
  process: 'Verwerken',
  verbanden: 'Verbanden'
}

export function renderTopbar(title: string, active?: NavKey, extra = ''): string {
  const ai = isAiEnabled()

  const tab = (key: NavKey, label: string) =>
    `<button class="tab-btn${active === key ? ' active' : ''}" data-nav="${key}">${label}</button>`

  const visibleTabs = PRIMARY_TABS.filter(k => k !== 'process' || ai)
  const colClass = `bottom-nav--${visibleTabs.length + 1}col`

  // "Meer" is active whenever the current screen isn't one of the visible tabs.
  const meerActive = !active || !visibleTabs.includes(active)

  const sheetItem = (key: NavKey, label: string) =>
    `<button class="nav-sheet-item${active === key ? ' active' : ''}" data-nav="${key}">${label}</button>`

  return `
    <header class="topbar">
      <span class="topbar-title">${title}</span>
      <div class="topbar-actions">
        ${extra}
        <button class="topbar-btn" data-nav="zoek-overlay" id="zoek-overlay-btn" title="Zoek in al je notities">Zoek</button>
        <button class="topbar-btn" data-nav="focus-mode" aria-pressed="false" id="focus-mode-btn">Focus</button>
      </div>
    </header>
    <nav class="bottom-nav focus-hide ${colClass}" aria-label="Hoofdnavigatie">
      ${visibleTabs.map(k => tab(k, TAB_LABELS[k])).join('')}
      <button class="tab-btn${meerActive ? ' active' : ''}" data-nav="meer" aria-expanded="false" aria-controls="nav-sheet">Meer</button>
    </nav>
    <div class="nav-sheet-scrim focus-hide" id="nav-sheet-scrim" hidden></div>
    <div class="nav-sheet focus-hide" id="nav-sheet" role="menu" aria-label="Meer" hidden>
      ${sheetItem('vandaag', 'Vandaag')}
      ${sheetItem('library', 'Bibliotheek')}
      ${sheetItem('studio', 'Schrijfstudio')}
      ${ai ? sheetItem('denktools', 'Denktools') : ''}
      ${sheetItem('settings', 'Instellingen')}
    </div>`
}

/** Open or close the "Meer" overflow sheet. */
function setSheetOpen(open: boolean): void {
  const sheet = document.getElementById('nav-sheet')
  const scrim = document.getElementById('nav-sheet-scrim')
  const trigger = document.querySelector<HTMLElement>('[data-nav="meer"]')
  if (sheet) sheet.hidden = !open
  if (scrim) scrim.hidden = !open
  if (trigger) trigger.setAttribute('aria-expanded', String(open))
}

/** Wire up every `[data-nav]` button in the document. Idempotent per render. */
export function attachTopbar(): void {
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) => {
    if (el.dataset['navBound']) return
    el.dataset['navBound'] = '1'

    el.addEventListener('click', async () => {
      const nav = el.dataset['nav']
      if (!nav) return

      if (nav === 'logout') {
        resetSettingsCache()
        await clearCache()
        await signOut()
        navigateTo('/login')
        return
      }
      if (nav === 'focus-mode') {
        setFocusMode(!getFocusMode())
        updateNavButtons()
        return
      }
      if (nav === 'meer') {
        const sheet = document.getElementById('nav-sheet')
        setSheetOpen(!!sheet?.hidden)
        return
      }
      if (nav === 'zoek-overlay') {
        // Dynamic import: keeps nav.ts free of a page dependency cycle and
        // loads the overlay only when first used.
        const { openSearchOverlay } = await import('./search-overlay')
        void openSearchOverlay()
        return
      }

      // Any real navigation closes the overflow sheet first.
      setSheetOpen(false)
      navigateTo('/' + nav)
    })
  })

  // Tapping the scrim closes the sheet without navigating.
  const scrim = document.getElementById('nav-sheet-scrim')
  if (scrim && !scrim.dataset['navBound']) {
    scrim.dataset['navBound'] = '1'
    scrim.addEventListener('click', () => setSheetOpen(false))
  }

  updateNavButtons()
}

function updateNavButtons(): void {
  const focusBtn = document.getElementById('focus-mode-btn')
  if (focusBtn) {
    const on = getFocusMode()
    focusBtn.textContent = on ? 'Focus uit' : 'Focus'
    focusBtn.setAttribute('aria-pressed', String(on))
  }
}

/** Full-screen panel shown when an AI-only route is opened while AI is off. */
export function renderAiDisabled(app: HTMLElement, title: string): void {
  app.innerHTML = `
    ${renderTopbar(title)}
    <div class="ai-disabled">
      <h2>AI staat uit</h2>
      <p>Deze functie gebruikt AI. Schakel AI in via Instellingen om verder te gaan.</p>
      <button class="btn btn-primary" data-nav="settings">Naar instellingen</button>
    </div>
    <div class="toast" id="toast"></div>
  `
  injectAiDisabledStyles()
  attachTopbar()
}

function injectAiDisabledStyles(): void {
  if (document.getElementById('ai-disabled-styles')) return
  const style = document.createElement('style')
  style.id = 'ai-disabled-styles'
  style.textContent = `
    .ai-disabled {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--s-3);
      text-align: center;
      padding: var(--s-7);
      padding-bottom: calc(var(--bottom-nav-h) + var(--s-7));
      color: var(--text-muted);
    }
    .ai-disabled h2 { color: var(--text); }
    .ai-disabled .btn { width: auto; }
  `
  document.head.appendChild(style)
}
