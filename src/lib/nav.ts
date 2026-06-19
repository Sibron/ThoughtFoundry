import { navigateTo } from '../router'
import { signOut } from './auth'
import { getTheme, setTheme, getFocusMode, setFocusMode, type Theme } from './display'

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
}

// ── Navigation ────────────────────────────────────────────────────────────

export type NavKey = 'capture' | 'inbox' | 'search' | 'process' | 'graph' | 'book' | 'themes' | 'settings' | 'spark' | 'denkpartner' | 'clusters' | 'sources' | 'projects'

/**
 * Render the slim sticky header + fixed bottom tab bar.
 * Signature is unchanged: `title` shows in the header, `active` highlights
 * the matching tab, `extra` is injected into the header actions (e.g. online indicator).
 */
export function renderTopbar(title: string, active?: NavKey, extra = ''): string {
  const ai = isAiEnabled()

  const tab = (key: NavKey, label: string) =>
    `<button class="tab-btn${active === key ? ' active' : ''}" data-nav="${key}">${label}</button>`

  return `
    <header class="topbar">
      <span class="topbar-title">${title}</span>
      <div class="topbar-actions">
        ${extra}
        <button class="topbar-btn focus-hide" data-nav="focus-mode" aria-pressed="false" id="focus-mode-btn">Focus</button>
        <button class="topbar-btn focus-hide" data-nav="toggle-theme" id="theme-toggle-btn">Donker</button>
      </div>
    </header>
    <nav class="bottom-nav focus-hide ${ai ? 'bottom-nav--5col' : 'bottom-nav--4col'}" aria-label="Hoofdnavigatie">
      ${tab('capture', 'Nieuw')}
      ${tab('inbox', 'Vangbak')}
      ${ai ? tab('process', 'Verwerken') : ''}
      ${tab('themes', "Thema's")}
      ${tab('settings', 'Meer')}
    </nav>`
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

      navigateTo('/' + nav)
    })
  })

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
