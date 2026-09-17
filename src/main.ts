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

type PageRenderer = (app: HTMLElement) => void | Promise<void>

/**
 * Every page is loaded on demand.
 *
 * Statically importing all of them put the graph's force layout, the writing
 * studio, the book pipeline and the export/import machinery into the same
 * bundle as the capture box — so the one screen that has to open instantly,
 * from a phone, mid-thought, waited on code for screens the user wasn't going
 * to. Each route now pulls only its own chunk, and the service worker caches
 * them after first use, so this costs nothing offline.
 */
async function guard(load: () => Promise<PageRenderer>): Promise<void> {
  const session = await getSession()
  if (!session) { navigateTo('/login'); return }
  await loadUserSettings()
  applyDisplayPrefs()
  if (!warmedThisSession) { warmedThisSession = true; warmSnapshots() }
  let render: PageRenderer
  try {
    render = await load()
  } catch {
    // A chunk can now fail to arrive where a static import could not: a stale
    // service worker after a deploy, or a dropped connection mid-navigation.
    // A blank screen would look like the app died, so say what happened and
    // offer the one thing that actually fixes it.
    renderChunkError()
    return
  }
  await render(app)
}

function renderChunkError(): void {
  app.innerHTML = `
    <div class="boot-error">
      <h2>Dit scherm kon niet geladen worden</h2>
      <p>Controleer je verbinding en probeer het opnieuw. Je notities zijn veilig.</p>
      <button class="btn btn-primary" id="boot-reload">Opnieuw laden</button>
    </div>`
  document.getElementById('boot-reload')?.addEventListener('click', () => location.reload())
}

/** Guard for AI-only routes: requires auth AND the AI flag turned on. */
function aiGuard(load: () => Promise<PageRenderer>, title: string) {
  return () => guard(async () => {
    if (!isAiEnabled()) return (a: HTMLElement) => renderAiDisabled(a, title)
    return load()
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
  void import('./pages/setup').then(m => m.renderSetup(app))
} else {
  createRouter({
    '/': async () => {
      const session = await getSession()
      navigateTo(session ? '/capture' : '/login')
    },
    '/login': async () => {
      const session = await getSession()
      if (session) { navigateTo('/capture'); return }
      const { renderLogin } = await import('./pages/login')
      renderLogin(app)
    },
    '/vandaag':        () => guard(async () => (await import('./pages/vandaag')).renderVandaag),
    '/capture':        () => guard(async () => (await import('./pages/capture')).renderCapture),
    '/inbox':          () => guard(async () => (await import('./pages/inbox')).renderInbox),
    '/note':           () => guard(async () => (await import('./pages/note')).renderNoteDetail),
    '/process':        aiGuard(async () => (await import('./pages/process')).renderProcess, 'Verwerken'),
    '/theme-sections': () => guard(async () => (await import('./pages/theme-sections')).renderThemeSections),
    '/studio':         () => guard(async () => (await import('./pages/studio')).renderStudio),
    '/settings':       () => guard(async () => (await import('./pages/settings')).renderSettings),
    '/denktools':      aiGuard(async () => (await import('./pages/denktools')).renderDenktools, 'Denktools'),
    '/library':        () => guard(async () => (await import('./pages/library')).renderLibrary),
    '/verbanden':      () => guard(async () => (await import('./pages/verbanden')).renderVerbanden),
    // Retired standalone routes (pre-consolidation deep links / muscle
    // memory): everything lives inside a shell now, so redirect there.
    '/search':      redirect('/inbox?view=search'),
    '/graph':       redirect('/verbanden?view=graph'),
    '/themes':      redirect('/library?tab=themes'),
    '/sources':     redirect('/library?tab=sources'),
    '/book':        redirect('/library?tab=book'),
    '/projects':    redirect('/library?tab=book&booktab=projects'),
    '/spark':       redirect('/denktools?tab=spark'),
    '/denkpartner': redirect('/denktools?tab=denkpartner'),
    '/clusters':    redirect('/denktools?tab=clusters')
  })
}
