import './style.css'
import { getSession } from './lib/auth'
import { createRouter, navigateTo } from './router'
import { renderLogin } from './pages/login'
import { renderCapture } from './pages/capture'
import { renderInbox } from './pages/inbox'
import { renderProcess } from './pages/process'
import { renderGraph } from './pages/graph'
import { renderBook } from './pages/book'
import { renderThemes } from './pages/themes'
import { renderSettings } from './pages/settings'

const app = document.getElementById('app') as HTMLElement

async function guard(handler: (app: HTMLElement) => void | Promise<void>): Promise<void> {
  const session = await getSession()
  if (!session) { navigateTo('/login'); return }
  await handler(app)
}

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
  '/process':  () => guard(renderProcess),
  '/graph':    () => guard(renderGraph),
  '/book':     () => guard(renderBook),
  '/themes':   () => guard(renderThemes),
  '/settings': () => guard(renderSettings)
})
