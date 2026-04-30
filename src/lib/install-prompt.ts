// Hook the PWA install lifecycle and inject a floating "Installeer app"
// button when the browser tells us it's installable. iOS doesn't fire
// beforeinstallprompt — those users install manually via the share menu.

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISSED_KEY = 'pwa_install_dismissed_at'
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

let deferredPrompt: BeforeInstallPromptEvent | null = null

export function initInstallPrompt(): void {
  // Skip if already running standalone (i.e. installed)
  if (window.matchMedia('(display-mode: standalone)').matches) return

  // Skip if user dismissed recently
  const dismissed = Number(localStorage.getItem(DISMISSED_KEY) ?? 0)
  if (dismissed && Date.now() - dismissed < DISMISS_TTL_MS) return

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferredPrompt = e as BeforeInstallPromptEvent
    showButton()
  })

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    hideButton()
    localStorage.removeItem(DISMISSED_KEY)
  })
}

function showButton(): void {
  if (document.getElementById('install-pwa-btn')) return
  const btn = document.createElement('button')
  btn.id = 'install-pwa-btn'
  btn.type = 'button'
  btn.textContent = 'Installeer app'
  btn.title = 'Voeg ThoughtFoundry toe aan je startscherm'
  btn.addEventListener('click', onInstallClick)

  const dismiss = document.createElement('button')
  dismiss.id = 'install-pwa-dismiss'
  dismiss.type = 'button'
  dismiss.textContent = '×'
  dismiss.title = 'Verberg voor 7 dagen'
  dismiss.addEventListener('click', () => {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()))
    hideButton()
  })

  const wrap = document.createElement('div')
  wrap.id = 'install-pwa-wrap'
  wrap.appendChild(btn)
  wrap.appendChild(dismiss)
  document.body.appendChild(wrap)

  injectStyles()
}

function hideButton(): void {
  document.getElementById('install-pwa-wrap')?.remove()
}

async function onInstallClick(): Promise<void> {
  if (!deferredPrompt) return
  try {
    await deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    if (outcome === 'dismissed') {
      localStorage.setItem(DISMISSED_KEY, String(Date.now()))
    }
  } catch {
    // user closed or browser refused — ignore
  } finally {
    deferredPrompt = null
    hideButton()
  }
}

function injectStyles(): void {
  if (document.getElementById('install-pwa-styles')) return
  const style = document.createElement('style')
  style.id = 'install-pwa-styles'
  style.textContent = `
    #install-pwa-wrap {
      position: fixed;
      right: var(--s-3, 12px);
      bottom: calc(var(--s-3, 12px) + env(safe-area-inset-bottom));
      display: inline-flex;
      align-items: stretch;
      background: var(--accent, #3AC48D);
      color: #fff;
      border-radius: 999px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.18);
      z-index: 200;
      overflow: hidden;
    }
    #install-pwa-btn {
      background: transparent;
      color: inherit;
      border: none;
      font: inherit;
      padding: 10px 16px;
      cursor: pointer;
    }
    #install-pwa-dismiss {
      background: rgba(0,0,0,0.12);
      color: inherit;
      border: none;
      font-size: 18px;
      line-height: 1;
      width: 32px;
      cursor: pointer;
    }
    #install-pwa-dismiss:hover { background: rgba(0,0,0,0.2); }
  `
  document.head.appendChild(style)
}
