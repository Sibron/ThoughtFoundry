import { renderTopbar, attachTopbar } from '../lib/nav'
import { injectShellStyles } from './denktools'
import { mountThemes } from './themes'
import { mountSources } from './sources'
import { mountBook } from './book'

type LibraryTab = 'themes' | 'sources' | 'book'

const TABS: { key: LibraryTab; label: string; mount: (root: HTMLElement) => Promise<void> }[] = [
  { key: 'themes',  label: "Thema's", mount: mountThemes },
  { key: 'sources', label: 'Bronnen', mount: mountSources },
  { key: 'book',    label: 'Boek',    mount: mountBook },
]

export async function renderLibrary(app: HTMLElement): Promise<void> {
  app.innerHTML = `
    ${renderTopbar('Bibliotheek', 'library')}
    <div class="shell-body" id="library-shell">
      <div class="shell-tabs" id="library-tabs"></div>
      <div id="library-panel"></div>
    </div>
    <div class="toast" id="toast"></div>
  `

  injectShellStyles()
  attachTopbar()

  const urlTab = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('tab')
  let active: LibraryTab = TABS.some(t => t.key === urlTab) ? (urlTab as LibraryTab) : 'themes'

  const tabsEl = document.getElementById('library-tabs')!
  const panel = document.getElementById('library-panel')!

  function renderTabs(): void {
    tabsEl.innerHTML = TABS.map(t =>
      `<button class="shell-tab" data-tab="${t.key}" ${t.key === active ? 'aria-current="true"' : ''}>${t.label}</button>`
    ).join('')
    tabsEl.querySelectorAll<HTMLButtonElement>('.shell-tab').forEach(btn => {
      btn.addEventListener('click', () => switchTo(btn.dataset['tab'] as LibraryTab))
    })
  }

  async function switchTo(tab: LibraryTab): Promise<void> {
    active = tab
    renderTabs()
    panel.innerHTML = ''
    await TABS.find(x => x.key === tab)!.mount(panel)
  }

  renderTabs()
  await TABS.find(t => t.key === active)!.mount(panel)
}
