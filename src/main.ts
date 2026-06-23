import './style.css'
import { registerPwa } from './lib/pwa'
import { getSession } from './lib/auth'
import { isConfigured } from './lib/supabase'
import { isAiEnabled, renderAiDisabled } from './lib/nav'
import { applyDisplayPrefs } from './lib/display'
import { loadUserSettings } from './lib/user-settings'
import { consumeSharedContent } from './lib/share'
import { createRouter, navigateTo } from './router'
import { renderLogin } from './pages/login'
import { renderCapture } from './pages/capture'
import { renderInbox } from './pages/inbox'
import { renderSearch } from './pages/search'
import { renderNoteDetail } from './pages/note'
import { renderProcess } from './pages/process'
import { renderGraph } from './pages/graph'
import { renderBook } from './pages/book'
import { renderThemes } from './pages/themes'
import { renderSettings } from './pages/settings'
import { renderSpark } from './pages/spark'
import { renderDenkpartner } from './pages/denkpartner'
import { renderClusters } from './pages/clusters'
import { renderSources } from './pages/sources'
import { renderProjects } from './pages/projects'
import { renderThemeSections } from './pages/theme-sections'

const app = document.getElementById('app') as HTMLElement

registerPwa()
applyDisplayPrefs()
// Handle an incoming Web Share (PWA share-target) before routing: stash the
// shared text into the capture draft and redirect to /capture.
consumeSharedContent()

async function guard(handler: (app: HTMLElement) => void | Promise<void>): Promise<void> {
  const session = await getSession()
  if (!session) { navigateTo('/login'); return }
  await loadUserSettings()
  applyDisplayPrefs()
  await handler(app)
}

/** Guard for AI-only routes: requires auth AND the AI flag turned on. */
function aiGuard(handler: (app: HTMLElement) => void | Promise<void>, title: string) {
  return () => guard((a) => {
    if (!isAiEnabled()) { renderAiDisabled(a, title); return }
    return handler(a)
  })
}

if (!isConfigured) {
  renderConfigError()
} else {
  createRouter({
    '/': async () => {
      const session = await getSession()
      navigateTo(session ? '/capture' : '/login')
    },
    '/login': async () => {
      const session = await getSession()
      if (session) { navigateTo('/capture'); return }
      renderLogin(app)
    },
    '/capture':  () => guard(renderCapture),
    '/inbox':    () => guard(renderInbox),
    '/search':   () => guard(renderSearch),
    '/note':     () => guard(renderNoteDetail),
    '/process':  aiGuard(renderProcess, 'Verwerken'),
    '/graph':    () => guard(renderGraph),
    '/book':     aiGuard(renderBook, 'Boek'),
    '/themes':           () => guard(renderThemes),
    '/theme-sections':   () => guard(renderThemeSections),
    '/settings':    () => guard(renderSettings),
    '/spark':       aiGuard(renderSpark, 'Spark'),
    '/denkpartner': aiGuard(renderDenkpartner, 'Denkpartner'),
    '/clusters':    aiGuard(renderClusters, 'Clusters'),
    '/sources':     () => guard(renderSources),
    '/projects':    () => guard(renderProjects)
  })
}

/** Shown when the Supabase env vars are missing — never a blank screen. */
function renderConfigError(): void {
  app.innerHTML = `
    <div class="config-error">
      <h1>ThoughtFoundry is niet geconfigureerd</h1>
      <p>De verbinding met Supabase ontbreekt. Zet deze waarden in je <code>.env</code>
         (lokaal) of in de build-secrets (deploy) en herstart:</p>
      <pre>VITE_SUPABASE_URL=https://&lt;project&gt;.supabase.co
VITE_SUPABASE_ANON_KEY=&lt;anon-key&gt;</pre>
      <p class="muted">Zonder deze waarden kan de app niet inloggen of nota's opslaan.</p>
    </div>
  `
  const style = document.createElement('style')
  style.textContent = `
    .config-error {
      max-width: 560px;
      margin: 0 auto;
      padding: var(--s-7) var(--s-5);
      display: flex;
      flex-direction: column;
      gap: var(--s-4);
    }
    .config-error h1 { font-size: var(--fs-xl); color: var(--danger); }
    .config-error pre {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-sm);
      padding: var(--s-3);
      overflow-x: auto;
      font-size: var(--fs-sm);
    }
    .config-error .muted { color: var(--text-muted); font-size: var(--fs-sm); }
  `
  document.head.appendChild(style)
}
