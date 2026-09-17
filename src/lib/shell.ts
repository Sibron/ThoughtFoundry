// The tabbed host shell used by Bibliotheek, Denktools and Verbanden.
//
// All three are the same screen with different contents: a row of tabs, an
// optional intro line, and one async-mounted panel. They each carried their own
// copy of the tab rendering, the ?tab= parsing and — the part that actually
// matters — the re-entrancy guard below, so a fix to one silently left the
// other two behind. One implementation, three callers.

import { renderTopbar, attachTopbar } from './nav'

export interface ShellTab<K extends string> {
  key: K
  label: string
  mount: (root: HTMLElement) => Promise<void>
}

export interface ShellConfig<K extends string> {
  /** Page title and the nav key to highlight. */
  title: string
  navKey: Parameters<typeof renderTopbar>[1]
  tabs: ShellTab<K>[]
  /** Per-tab intro line above the panel. Omit for a shell without one. */
  intros?: Record<K, string>
  /** Query param carrying the active tab — 'tab' or 'view'. */
  param?: string
  /** Extra accepted values for `param`, e.g. Dutch deep-link aliases. */
  aliases?: Record<string, K>
}

/** Read the active tab from the hash query string, falling back to the first. */
function initialTab<K extends string>(config: ShellConfig<K>): K {
  const raw = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get(config.param ?? 'tab')
  const resolved = raw ? (config.aliases?.[raw] ?? raw) : null
  return config.tabs.some(t => t.key === resolved) ? resolved as K : config.tabs[0].key
}

export async function renderShell<K extends string>(app: HTMLElement, config: ShellConfig<K>): Promise<void> {
  app.innerHTML = `
    ${renderTopbar(config.title, config.navKey)}
    <div class="shell-body">
      <div class="shell-tabs focus-hide" id="shell-tabs"></div>
      ${config.intros ? '<p class="shell-intro muted" id="shell-intro"></p>' : ''}
      <div id="shell-panel"></div>
    </div>
    <div class="toast" id="toast"></div>
  `

  injectShellStyles()
  attachTopbar()

  let active = initialTab(config)
  const tabsEl = document.getElementById('shell-tabs')!
  const introEl = document.getElementById('shell-intro')
  const panel = document.getElementById('shell-panel')!

  function renderTabs(): void {
    tabsEl.innerHTML = config.tabs.map(t =>
      `<button class="shell-tab" data-tab="${t.key}" ${t.key === active ? 'aria-current="true"' : ''}>${t.label}</button>`
    ).join('')
    tabsEl.querySelectorAll<HTMLButtonElement>('.shell-tab').forEach(btn => {
      btn.addEventListener('click', () => void switchTo(btn.dataset['tab'] as K))
    })
  }

  // Mount is async (network). Only one mount runs at a time; if a newer tab was
  // clicked mid-load the loop re-mounts, so the last-clicked tab always wins.
  let loading = false
  let desired: K = active

  async function switchTo(tab: K): Promise<void> {
    desired = tab
    active = tab
    renderTabs()
    if (introEl && config.intros) introEl.textContent = config.intros[tab]
    if (loading) return
    loading = true
    try {
      for (;;) {
        const t = desired
        panel.innerHTML = ''
        await config.tabs.find(x => x.key === t)!.mount(panel)
        if (desired === t) break
      }
    } finally {
      loading = false
    }
  }

  await switchTo(active)
}

/** Shared styles for the tabbed host shells. Injected once. */
export function injectShellStyles(): void {
  if (document.getElementById('shell-styles')) return
  const style = document.createElement('style')
  style.id = 'shell-styles'
  style.textContent = `
    .shell-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
      width: 100%;
    }
    .shell-tabs {
      display: flex;
      gap: var(--s-2);
      flex-wrap: wrap;
      padding: var(--s-4) var(--s-4) 0;
      max-width: 1100px;
      width: 100%;
      margin: 0 auto;
    }
    .shell-tab {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-sm);
      padding: var(--s-2) var(--s-4);
      cursor: pointer;
      font-size: var(--fs-sm);
      color: var(--text-muted);
    }
    .shell-tab[aria-current="true"] {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    .shell-intro {
      margin: 0 auto;
      padding: 0 var(--s-4);
      max-width: 1100px;
      width: 100%;
    }
    #shell-panel,
    #inbox-view {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }
    .muted { color: var(--text-muted); font-size: var(--fs-sm); }
  `
  document.head.appendChild(style)
}
