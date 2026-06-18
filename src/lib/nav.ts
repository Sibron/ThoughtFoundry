import { navigateTo } from '../router'
import { signOut } from './auth'

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

// ── Shared topbar ─────────────────────────────────────────────────────────
// Single source of truth for navigation so every page stays consistent and
// the AI-only items (Verwerken / Graaf / Boek) can be hidden in one place.

export type NavKey = 'capture' | 'inbox' | 'process' | 'graph' | 'book' | 'themes' | 'settings' | 'spark' | 'denkpartner' | 'clusters' | 'sources' | 'projects'

/**
 * Render the topbar HTML. `extra` is injected at the start of the actions row
 * (used by the capture page for its online/offline indicator).
 */
export function renderTopbar(title: string, active?: NavKey, extra = ''): string {
  const ai = isAiEnabled()
  const btn = (key: NavKey, label: string) =>
    `<button class="topbar-btn${active === key ? ' active' : ''}" data-nav="${key}">${label}</button>`

  const aiButtons = ai
    ? btn('process', 'Verwerken') +
      btn('spark', 'Spark') +
      btn('denkpartner', 'Denkpartner') +
      btn('clusters', 'Clusters') +
      btn('graph', 'Graaf') +
      btn('book', 'Boek')
    : ''

  return `
    <div class="topbar">
      <span class="topbar-title">${title}</span>
      <div class="topbar-actions">
        ${extra}
        ${active === 'capture' ? '' : btn('capture', '+ Nieuw')}
        ${active === 'inbox' ? '' : btn('inbox', 'Inbox')}
        ${aiButtons}
        ${btn('themes', "Thema's")}
        ${btn('sources', 'Bronnen')}
        ${btn('projects', 'Projecten')}
        ${btn('settings', '⚙')}
        <button class="topbar-btn" data-nav="logout" title="Afmelden">&#x238B;</button>
      </div>
    </div>`
}

/** Wire up every `[data-nav]` button in the document (idempotent per render). */
export function attachTopbar(): void {
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) => {
    el.addEventListener('click', async () => {
      const nav = el.dataset['nav']
      if (!nav) return
      if (nav === 'logout') {
        await signOut()
        navigateTo('/login')
        return
      }
      navigateTo('/' + nav)
    })
  })
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
      color: var(--text-muted);
    }
    .ai-disabled h2 { color: var(--text); }
    .ai-disabled .btn { width: auto; }
  `
  document.head.appendChild(style)
}
