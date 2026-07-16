import './style.css'
import { registerPwa } from './lib/pwa'
import { getSession } from './lib/auth'
import { isConfigured } from './lib/supabase'
import { isAiEnabled, renderAiDisabled } from './lib/nav'
import { applyDisplayPrefs } from './lib/display'
import { loadUserSettings } from './lib/user-settings'
import { consumeSharedContent } from './lib/share'
import { warmSnapshots } from './lib/snapshots'
import { createRouter, navigateTo } from './router'
import { renderSetup } from './pages/setup'
import { renderLogin } from './pages/login'
import { renderVandaag } from './pages/vandaag'
import { renderCapture } from './pages/capture'
import { renderInbox } from './pages/inbox'
import { renderNoteDetail } from './pages/note'
import { renderProcess } from './pages/process'
import { renderSettings } from './pages/settings'
import { renderThemeSections } from './pages/theme-sections'
import { renderStudio } from './pages/studio'
import { renderDenktools } from './pages/denktools'
import { renderLibrary } from './pages/library'

const app = document.getElementById('app') as HTMLElement

registerPwa()
applyDisplayPrefs()
// Handle an incoming Web Share (PWA share-target) before routing: stash the
// shared text into the capture draft and redirect to /capture.
consumeSharedContent()

// Warm the on-device snapshot cache once per session (after the first authed
// route), so the first visit to a heavy page — graph, themes, sources — renders
// from cache instead of waiting on the network.
let warmedThisSession = false

async function guard(handler: (app: HTMLElement) => void | Promise<void>): Promise<void> {
  const session = await getSession()
  if (!session) { navigateTo('/login'); return }
  await loadUserSettings()
  applyDisplayPrefs()
  if (!warmedThisSession) { warmedThisSession = true; warmSnapshots() }
  await handler(app)
}

/** Guard for AI-only routes: requires auth AND the AI flag turned on. */
function aiGuard(handler: (app: HTMLElement) => void | Promise<void>, title: string) {
  return () => guard((a) => {
    if (!isAiEnabled()) { renderAiDisabled(a, title); return }
    return handler(a)
  })
}

/** Redirect a retired route, carrying any query params of the old URL along. */
function redirect(to: string): () => void {
  return () => {
    const q = window.location.hash.split('?')[1]
    navigateTo(q ? `${to}${to.includes('?') ? '&' : '?'}${q}` : to)
  }
}

if (!isConfigured) {
  renderSetup(app)
} else {
  createRouter({
    '/': async () => {
      const session = await getSession()
      navigateTo(session ? '/vandaag' : '/login')
    },
    '/login': async () => {
      const session = await getSession()
      if (session) { navigateTo('/vandaag'); return }
      renderLogin(app)
    },
    '/vandaag':  () => guard(renderVandaag),
    '/capture':  () => guard(renderCapture),
    '/inbox':    () => guard(renderInbox),
    '/note':     () => guard(renderNoteDetail),
    '/process':  aiGuard(renderProcess, 'Verwerken'),
    '/theme-sections':   () => guard(renderThemeSections),
    '/studio':   () => guard(renderStudio),
    '/settings':    () => guard(renderSettings),
    '/denktools':   aiGuard(renderDenktools, 'Denktools'),
    '/library':     () => guard(renderLibrary),
    // Retired standalone routes (pre-consolidation deep links / muscle
    // memory): everything lives inside a shell now, so redirect there.
    '/search':      redirect('/inbox?view=search'),
    '/graph':       redirect('/inbox?view=graph'),
    '/themes':      redirect('/library?tab=themes'),
    '/sources':     redirect('/library?tab=sources'),
    '/book':        redirect('/library?tab=book'),
    '/projects':    redirect('/library?tab=book&booktab=projects'),
    '/spark':       redirect('/denktools?tab=spark'),
    '/denkpartner': redirect('/denktools?tab=denkpartner'),
    '/clusters':    redirect('/denktools?tab=clusters')
  })
}

