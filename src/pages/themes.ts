import {
  fetchThemes,
  createTheme,
  updateTheme,
  deleteTheme,
  mergeThemes,
  fetchAllNoteThemes,
  type Theme
} from '../lib/themes'
import { signOut } from '../lib/auth'
import { navigateTo } from '../router'

const COLOR_PALETTE = [
  '#3AC48D', '#2E76A8', '#C45A3A', '#A83AC4',
  '#C4A83A', '#3AC4B5', '#C43A6E', '#6B6B6B'
]

export async function renderThemes(app: HTMLElement): Promise<void> {
  app.innerHTML = `
    <div class="topbar">
      <span class="topbar-title">Thema's</span>
      <div class="topbar-actions">
        <button class="topbar-btn" id="goto-capture">+ Nieuw</button>
        <button class="topbar-btn" id="goto-inbox">Inbox</button>
        <button class="topbar-btn" id="goto-process">Verwerken</button>
        <button class="topbar-btn" id="goto-graph">Graaf</button>
        <button class="topbar-btn" id="goto-book">Boek</button>
        <button class="topbar-btn" id="goto-settings">⚙</button>
        <button class="topbar-btn" id="logout-btn" title="Afmelden">&#x238B;</button>
      </div>
    </div>
    <div class="themes-body" id="themes-body">
      <div class="themes-loading">Laden…</div>
    </div>
    <div class="toast" id="toast"></div>
  `

  injectThemesStyles()
  attachTopbar()

  let themes: Theme[] = []
  let counts: Record<string, number> = {}

  try {
    themes = await fetchThemes()
    const noteThemes = await fetchAllNoteThemes()
    counts = noteThemes.reduce<Record<string, number>>((acc, nt) => {
      acc[nt.theme_id] = (acc[nt.theme_id] ?? 0) + 1
      return acc
    }, {})
  } catch (err) {
    document.getElementById('themes-body')!.innerHTML =
      `<div class="themes-error">Laden mislukt: ${escHtml(errMsg(err))}</div>`
    return
  }

  renderShell()

  function renderShell(): void {
    const body = document.getElementById('themes-body')!
    body.innerHTML = `
      <section class="themes-section">
        <header class="themes-section-header">
          <h2>Nieuw thema</h2>
        </header>
        <div class="themes-form">
          <div class="form-row">
            <input type="text" id="new-name" placeholder="Naam (bv. Autisme & werk)" />
            <input type="text" id="new-desc" placeholder="Korte beschrijving (optioneel)" />
          </div>
          <div class="form-row">
            <fieldset class="color-picker" id="new-colors">
              <legend class="muted">Kleur</legend>
              ${COLOR_PALETTE.map((c, i) => `
                <label class="color-swatch" style="background:${c}">
                  <input type="radio" name="new-color" value="${c}" ${i === 0 ? 'checked' : ''} />
                </label>
              `).join('')}
            </fieldset>
            <button class="btn btn-primary" id="create-btn">Toevoegen</button>
          </div>
        </div>
      </section>

      <section class="themes-section">
        <header class="themes-section-header">
          <h2>Alle thema's (${themes.length})</h2>
          <span class="muted">Klik een rij om te bewerken.</span>
        </header>
        <div class="themes-list" id="themes-list"></div>
      </section>
    `

    document.getElementById('create-btn')?.addEventListener('click', onCreate)
    renderList()
  }

  function renderList(): void {
    const listEl = document.getElementById('themes-list')!
    if (themes.length === 0) {
      listEl.innerHTML = '<p class="muted">Nog geen thema\'s. Maak er een aan, of laat AI er voorstellen tijdens "Verwerken".</p>'
      return
    }
    listEl.innerHTML = themes.map(t => `
      <details class="theme-row" data-id="${t.id}">
        <summary class="theme-summary">
          <span class="theme-dot" style="background:${escHtml(t.color)}"></span>
          <span class="theme-name">${escHtml(t.name)}</span>
          <span class="theme-count">${counts[t.id] ?? 0} nota's</span>
        </summary>
        <div class="theme-edit">
          <label class="field">
            <span class="field-label">Naam</span>
            <input type="text" data-edit-name value="${escHtml(t.name)}" />
          </label>
          <label class="field">
            <span class="field-label">Beschrijving</span>
            <textarea data-edit-desc rows="2">${escHtml(t.description ?? '')}</textarea>
          </label>
          <fieldset class="color-picker">
            <legend class="field-label">Kleur</legend>
            ${COLOR_PALETTE.map(c => `
              <label class="color-swatch" style="background:${c}">
                <input type="radio" name="color-${t.id}" value="${c}" ${c === t.color ? 'checked' : ''} />
              </label>
            `).join('')}
          </fieldset>
          <details class="merge-block">
            <summary class="muted">Mergen in ander thema</summary>
            <div class="merge-form">
              <select data-merge-target>
                <option value="">— kies doel-thema —</option>
                ${themes.filter(o => o.id !== t.id).map(o => `<option value="${o.id}">${escHtml(o.name)}</option>`).join('')}
              </select>
              <button class="btn btn-ghost" data-action="merge">Voer merge uit</button>
            </div>
          </details>
          <div class="theme-actions">
            <button class="btn btn-primary" data-action="save">Opslaan</button>
            <button class="btn btn-danger" data-action="delete">Verwijder</button>
          </div>
        </div>
      </details>
    `).join('')

    listEl.querySelectorAll<HTMLElement>('.theme-row').forEach(row => {
      const id = row.dataset['id']!
      row.querySelector<HTMLButtonElement>('[data-action="save"]')?.addEventListener('click', () => onSave(row, id))
      row.querySelector<HTMLButtonElement>('[data-action="delete"]')?.addEventListener('click', () => onDelete(id))
      row.querySelector<HTMLButtonElement>('[data-action="merge"]')?.addEventListener('click', () => onMerge(row, id))
    })
  }

  async function onMerge(row: HTMLElement, sourceId: string): Promise<void> {
    const targetId = row.querySelector<HTMLSelectElement>('[data-merge-target]')!.value
    if (!targetId) { showToast('Kies een doel-thema'); return }
    const source = themes.find(t => t.id === sourceId)
    const target = themes.find(t => t.id === targetId)
    if (!source || !target) return
    if (!confirm(`Alle nota's van "${source.name}" verplaatsen naar "${target.name}", en "${source.name}" verwijderen?`)) return
    try {
      await mergeThemes(sourceId, targetId)
      // Re-fetch counts and themes
      const noteThemes = await fetchAllNoteThemes()
      counts = noteThemes.reduce<Record<string, number>>((acc, nt) => {
        acc[nt.theme_id] = (acc[nt.theme_id] ?? 0) + 1
        return acc
      }, {})
      themes = themes.filter(t => t.id !== sourceId)
      delete counts[sourceId]
      renderList()
      const total = document.querySelector('.themes-section-header h2')
      if (total) total.textContent = `Alle thema's (${themes.length})`
      showToast('Gemerged')
    } catch (err) {
      showToast(`Mislukt: ${errMsg(err)}`)
    }
  }

  async function onCreate(): Promise<void> {
    const nameEl = document.getElementById('new-name') as HTMLInputElement
    const descEl = document.getElementById('new-desc') as HTMLInputElement
    const colorEl = document.querySelector<HTMLInputElement>('input[name="new-color"]:checked')
    const name = nameEl.value.trim()
    if (!name) { showToast('Naam is verplicht'); return }
    const btn = document.getElementById('create-btn') as HTMLButtonElement
    btn.disabled = true
    try {
      const created = await createTheme({
        name,
        description: descEl.value.trim() || undefined,
        color: colorEl?.value
      })
      themes.push(created)
      themes.sort((a, b) => a.name.localeCompare(b.name))
      counts[created.id] = 0
      nameEl.value = ''
      descEl.value = ''
      renderList()
      const total = document.querySelector('.themes-section-header h2')
      if (total) total.textContent = `Alle thema's (${themes.length})`
      showToast('Thema toegevoegd')
    } catch (err) {
      showToast(`Mislukt: ${errMsg(err)}`)
    } finally {
      btn.disabled = false
    }
  }

  async function onSave(row: HTMLElement, id: string): Promise<void> {
    const name = row.querySelector<HTMLInputElement>('[data-edit-name]')!.value.trim()
    const desc = row.querySelector<HTMLTextAreaElement>('[data-edit-desc]')!.value.trim()
    const color = row.querySelector<HTMLInputElement>(`input[name="color-${id}"]:checked`)?.value
    if (!name) { showToast('Naam is verplicht'); return }
    try {
      const updated = await updateTheme(id, { name, description: desc || null, color })
      const idx = themes.findIndex(t => t.id === id)
      if (idx !== -1) themes[idx] = updated
      themes.sort((a, b) => a.name.localeCompare(b.name))
      renderList()
      showToast('Opgeslagen')
    } catch (err) {
      showToast(`Mislukt: ${errMsg(err)}`)
    }
  }

  async function onDelete(id: string): Promise<void> {
    const t = themes.find(x => x.id === id)
    const noteCount = counts[id] ?? 0
    const msg = noteCount > 0
      ? `Thema "${t?.name}" verwijderen? ${noteCount} nota('s) raken hun koppeling kwijt (de nota's zelf blijven bestaan).`
      : `Thema "${t?.name}" verwijderen?`
    if (!confirm(msg)) return
    try {
      await deleteTheme(id)
      themes = themes.filter(x => x.id !== id)
      delete counts[id]
      renderList()
      const total = document.querySelector('.themes-section-header h2')
      if (total) total.textContent = `Alle thema's (${themes.length})`
      showToast('Verwijderd')
    } catch (err) {
      showToast(`Mislukt: ${errMsg(err)}`)
    }
  }
}

function attachTopbar(): void {
  document.getElementById('goto-capture')?.addEventListener('click', () => navigateTo('/capture'))
  document.getElementById('goto-inbox')?.addEventListener('click', () => navigateTo('/inbox'))
  document.getElementById('goto-process')?.addEventListener('click', () => navigateTo('/process'))
  document.getElementById('goto-graph')?.addEventListener('click', () => navigateTo('/graph'))
  document.getElementById('goto-book')?.addEventListener('click', () => navigateTo('/book'))
  document.getElementById('goto-settings')?.addEventListener('click', () => navigateTo('/settings'))
  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    await signOut()
    navigateTo('/login')
  })
}

function showToast(msg: string): void {
  const toast = document.getElementById('toast') as HTMLDivElement | null
  if (!toast) return
  toast.textContent = msg
  toast.classList.add('show')
  setTimeout(() => toast.classList.remove('show'), 2500)
}

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'onbekende fout'
}

function injectThemesStyles(): void {
  if (document.getElementById('themes-styles')) return
  const style = document.createElement('style')
  style.id = 'themes-styles'
  style.textContent = `
    .themes-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: var(--s-5);
      padding: var(--s-4);
      max-width: 760px;
      width: 100%;
      margin: 0 auto;
    }
    .themes-section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-4);
    }
    .themes-section-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: var(--s-3);
      gap: var(--s-3);
      flex-wrap: wrap;
    }
    .themes-section-header h2 {
      font-size: var(--fs-lg);
      font-weight: 600;
    }
    .themes-form {
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
    }
    .form-row {
      display: flex;
      gap: var(--s-2);
      align-items: center;
      flex-wrap: wrap;
    }
    .form-row input[type=text] {
      flex: 1;
      min-width: 200px;
    }
    .form-row .btn { width: auto; }
    .color-picker {
      border: none;
      display: flex;
      gap: var(--s-1);
      align-items: center;
      flex-wrap: wrap;
    }
    .color-picker legend {
      padding-right: var(--s-2);
      font-size: var(--fs-sm);
    }
    .color-swatch {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      cursor: pointer;
      border: 2px solid transparent;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .color-swatch input { opacity: 0; width: 100%; height: 100%; cursor: pointer; }
    .color-swatch:has(input:checked) { border-color: var(--text); }
    .themes-list {
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }
    .theme-row {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      overflow: hidden;
    }
    .theme-summary {
      list-style: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: var(--s-3);
      padding: var(--s-3) var(--s-4);
    }
    .theme-summary::-webkit-details-marker { display: none; }
    .theme-dot {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .theme-name { flex: 1; font-weight: 500; }
    .theme-count { font-size: var(--fs-sm); color: var(--text-muted); }
    .theme-edit {
      padding: var(--s-3) var(--s-4);
      border-top: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
    }
    .theme-actions {
      display: flex;
      gap: var(--s-2);
    }
    .theme-actions .btn { width: auto; }
    .merge-block summary {
      cursor: pointer;
      padding: var(--s-1) 0;
    }
    .merge-form {
      display: flex;
      gap: var(--s-2);
      align-items: center;
      margin-top: var(--s-2);
      flex-wrap: wrap;
    }
    .merge-form select { flex: 1; min-width: 180px; }
    .merge-form .btn { width: auto; }
    .field { display: flex; flex-direction: column; gap: var(--s-1); }
    .field-label { font-size: var(--fs-sm); color: var(--text-muted); font-weight: 500; }
    .themes-loading,
    .themes-error {
      text-align: center;
      padding: var(--s-7);
      color: var(--text-muted);
    }
    .muted { color: var(--text-muted); font-size: var(--fs-sm); }
  `
  document.head.appendChild(style)
}
