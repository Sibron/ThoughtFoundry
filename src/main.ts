import './style.css'
import { registerPwa } from './lib/pwa'
import { getSession } from './lib/auth'
import { isConfigured } from './lib/supabase'
import { isAiEnabled, renderAiDisabled } from './lib/nav'
import { applyDisplayPrefs } from './lib/display'
import { loadUserSettings } from './lib/user-settings'
import { consumeSharedContent } from './lib/share'
import { createRouter, navigateTo } from './router'
import { renderSetup } from './pages/setup'
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
  renderSetup(app)
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

