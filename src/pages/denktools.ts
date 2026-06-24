import { renderTopbar, attachTopbar } from '../lib/nav'
import { mountSpark } from './spark'
import { mountDenkpartner } from './denkpartner'
import { mountClusters } from './clusters'

type DenktoolsTab = 'spark' | 'denkpartner' | 'clusters'

const TABS: { key: DenktoolsTab; label: string; mount: (root: HTMLElement) => Promise<void> }[] = [
  { key: 'spark',       label: 'Spark',       mount: mountSpark },
  { key: 'denkpartner', label: 'Denkpartner', mount: mountDenkpartner },
  { key: 'clusters',    label: 'Clusters',    mount: mountClusters },
]

const INTROS: Record<DenktoolsTab, string> = {
  spark:       'Synthese: laat AI jouw nota\'s tot een tekst smeden.',
  denkpartner: 'Tegenspraak: scherpe vragen die je blinde vlekken blootleggen.',
  clusters:    'Patronen: impliciete thema-clusters in je verwerkte nota\'s.',
}

export async function renderDenktools(app: HTMLElement): Promise<void> {
  app.innerHTML = `
    ${renderTopbar('Denktools', 'denktools')}
    <div class="shell-body" id="denktools-shell">
      <div class="shell-tabs" id="denktools-tabs"></div>
      <p class="shell-intro muted" id="denktools-intro"></p>
      <div id="denktools-panel"></div>
    </div>
    <div class="toast" id="toast"></div>
  `

  injectShellStyles()
  attachTopbar()

  const urlTab = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('tab')
  let active: DenktoolsTab = TABS.some(t => t.key === urlTab) ? (urlTab as DenktoolsTab) : 'spark'

  const tabsEl = document.getElementById('denktools-tabs')!
  const introEl = document.getElementById('denktools-intro')!
  const panel = document.getElementById('denktools-panel')!

  function renderTabs(): void {
    tabsEl.innerHTML = TABS.map(t =>
      `<button class="shell-tab" data-tab="${t.key}" ${t.key === active ? 'aria-current="true"' : ''}>${t.label}</button>`
    ).join('')
    tabsEl.querySelectorAll<HTMLButtonElement>('.shell-tab').forEach(btn => {
      btn.addEventListener('click', () => switchTo(btn.dataset['tab'] as DenktoolsTab))
    })
  }

  async function switchTo(tab: DenktoolsTab): Promise<void> {
    active = tab
    renderTabs()
    introEl.textContent = INTROS[tab]
    panel.innerHTML = ''
    const t = TABS.find(x => x.key === tab)!
    await t.mount(panel)
  }

  renderTabs()
  introEl.textContent = INTROS[active]
  await TABS.find(t => t.key === active)!.mount(panel)
}

/** Shared styles for the Denktools / Bibliotheek host shells. Injected once. */
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
    .inbox-view-toggle {
      display: flex;
      gap: var(--s-2);
      flex-wrap: wrap;
      padding: var(--s-4) var(--s-4) 0;
      max-width: 800px;
      width: 100%;
      margin: 0 auto;
    }
    .shell-intro {
      margin: 0 auto;
      padding: 0 var(--s-4);
      max-width: 1100px;
      width: 100%;
    }
    #denktools-panel,
    #library-panel,
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
