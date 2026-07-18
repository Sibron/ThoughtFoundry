// Verbanden shell — hosts the two connection-exploration views that used to
// live inside the Vangbak: the graph and the semantic-bridges review queue.
// Same shell pattern as Denktools; deep-links use ?view= (with Dutch aliases)
// because the repointed legacy /inbox?view=… links carry that param name.
// ?focus=<id> needs no handling here: mountGraph reads it from the hash itself.

import { renderTopbar, attachTopbar } from '../lib/nav'
import { injectShellStyles } from './denktools'
import { mountGraph } from './graph'
import { mountConnections } from './connections'

type VerbandenView = 'graph' | 'connections'

const TABS: { key: VerbandenView; label: string; mount: (root: HTMLElement) => Promise<void> }[] = [
  { key: 'graph',       label: 'Graaf',        mount: mountGraph },
  { key: 'connections', label: 'Verbindingen', mount: mountConnections },
]

const INTROS: Record<VerbandenView, string> = {
  graph:       'Jouw nota\'s als netwerk: zie hoe ideeën samenhangen.',
  connections: 'Voorgestelde verbindingen tussen nota\'s — jij beslist.',
}

const VIEW_ALIAS: Record<string, VerbandenView> = { graaf: 'graph', verbindingen: 'connections' }

export async function renderVerbanden(app: HTMLElement): Promise<void> {
  app.innerHTML = `
    ${renderTopbar('Verbanden', 'verbanden')}
    <div class="shell-body" id="verbanden-shell">
      <div class="shell-tabs focus-hide" id="verbanden-tabs"></div>
      <p class="shell-intro muted" id="verbanden-intro"></p>
      <div id="verbanden-panel"></div>
    </div>
    <div class="toast" id="toast"></div>
  `

  injectShellStyles()
  attachTopbar()

  const raw = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('view')
  const urlView = raw ? (VIEW_ALIAS[raw] ?? raw) : null
  let active: VerbandenView = TABS.some(t => t.key === urlView) ? (urlView as VerbandenView) : 'graph'

  const tabsEl = document.getElementById('verbanden-tabs')!
  const introEl = document.getElementById('verbanden-intro')!
  const panel = document.getElementById('verbanden-panel')!

  function renderTabs(): void {
    tabsEl.innerHTML = TABS.map(t =>
      `<button class="shell-tab" data-tab="${t.key}" ${t.key === active ? 'aria-current="true"' : ''}>${t.label}</button>`
    ).join('')
    tabsEl.querySelectorAll<HTMLButtonElement>('.shell-tab').forEach(btn => {
      btn.addEventListener('click', () => switchTo(btn.dataset['tab'] as VerbandenView))
    })
  }

  // Mount is async (network). Guard against fast tab-switching: only one mount
  // runs at a time, and the loop re-mounts if a newer tab was requested mid-load,
  // so the last-clicked tab always wins.
  let loading = false
  let desired: VerbandenView = active

  async function switchTo(view: VerbandenView): Promise<void> {
    desired = view
    active = view
    renderTabs()
    introEl.textContent = INTROS[view]
    if (loading) return
    loading = true
    try {
      while (true) {
        const v = desired
        panel.innerHTML = ''
        await TABS.find(x => x.key === v)!.mount(panel)
        if (desired === v) break
      }
    } finally {
      loading = false
    }
  }

  await switchTo(active)
}
