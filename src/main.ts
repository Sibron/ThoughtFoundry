import './style.css'
import { getSession } from './lib/auth'
import { createRouter, navigateTo } from './router'
import { renderLogin } from './pages/login'
import { renderCapture } from './pages/capture'
import { renderInbox } from './pages/inbox'

const app = document.getElementById('app') as HTMLElement

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
  '/capture': async () => {
    const session = await getSession()
    if (!session) { navigateTo('/login'); return }
    await renderCapture(app)
  },
  '/inbox': async () => {
    const session = await getSession()
    if (!session) { navigateTo('/login'); return }
    await renderInbox(app)
  }
})
