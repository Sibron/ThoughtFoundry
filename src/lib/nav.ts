import { navigateTo } from '../router'
import { signOut } from './auth'
import { getTheme, setTheme, getFocusMode, setFocusMode, type Theme } from './display'
import { saveUserSetting, resetSettingsCache } from './user-settings'

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

export type NavKey = 'capture' | 'inbox' | 'search' | 'process' | 'graph' | 'book' | 'themes' | 'settings' | 'spark' | 'denkpartner' | 'clusters' | 'sources' | 'projects' | 'denktools' | 'library'

/**
 * Render the slim sticky header + fixed bottom tab bar.
 * Signature is unchanged: `title` shows in the header, `active` highlights
 * the matching tab, `extra` is injected into the header actions (e.g. online indicator).
 */
// Tabs shown directly in the bottom bar. Anything else (Denktools, Instellingen)
// lives behind the "Meer" overflow sheet. Zoeken/Graaf live as views inside
// Vangbak; Thema's/Bronnen/Boek/Projecten live as sub-tabs inside Bibliotheek.
const PRIMARY_TABS: NavKey[] = ['capture', 'inbox', 'process', 'library']

export function renderTopbar(title: string, active?: NavKey, extra = ''): string {
  const ai = isAiEnabled()

  const tab = (key: NavKey, label: string) =>
    `<button class="tab-btn${active === key ? ' active' : ''}" data-nav="${key}">${label}</button>`

  // "Meer" is active whenever the current screen isn't one of the primary tabs.
  const meerActive = !active || !PRIMARY_TABS.includes(active)

  const sheetItem = (key: NavKey, label: string) =>
    `<button class="nav-sheet-item${active === key ? ' active' : ''}" data-nav="${key}">${label}</button>`

  const aiSheetItems = ai ? sheetItem('denktools', 'Denktools') : ''

  return `
    <header class="topbar">
      <span class="topbar-title">${title}</span>
      <div class="topbar-actions">
        ${extra}
        <button class="topbar-btn" data-nav="focus-mode" aria-pressed="false" id="focus-mode-btn">Focus</button>
        <button class="topbar-btn" data-nav="toggle-theme" id="theme-toggle-btn">Donker</button>
      </div>
    </header>
    <nav class="bottom-nav focus-hide ${ai ? 'bottom-nav--5col' : 'bottom-nav--4col'}" aria-label="Hoofdnavigatie">
      ${tab('capture', 'Nieuw')}
      ${tab('inbox', 'Vangbak')}
      ${ai ? tab('process', 'Verwerken') : ''}
      ${tab('library', 'Bibliotheek')}
      <button class="tab-btn${meerActive ? ' active' : ''}" data-nav="meer" aria-expanded="false" aria-controls="nav-sheet">Meer</button>
    </nav>
    <div class="nav-sheet-scrim focus-hide" id="nav-sheet-scrim" hidden></div>
    <div class="nav-sheet focus-hide" id="nav-sheet" role="menu" aria-label="Meer" hidden>
      ${aiSheetItems}
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
        await signOut()
        navigateTo('/login')
        return
      }
      if (nav === 'toggle-theme') {
        const t = getTheme()
        const next: Theme = t === 'auto' ? 'dark' : t === 'dark' ? 'light' : 'auto'
        setTheme(next)
        updateNavButtons()
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
  const themeBtn = document.getElementById('theme-toggle-btn')
  if (themeBtn) {
    const t = getTheme()
    themeBtn.textContent = t === 'dark' ? 'Licht' : t === 'light' ? 'Auto' : 'Donker'
    themeBtn.title = `Thema: ${t}`
  }
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
