import {
  fetchNotes,
  insertNote,
  updateNote,
  deleteNote,
  bulkUpdateStatus,
  bulkDelete,
  queueOfflineNote,
  type Note,
  type NoteStatus,
  type NoteUpdate
} from '../lib/notes'
import { fetchThemes, fetchAllNoteThemes, type Theme } from '../lib/themes'
import { fetchSimilarNotes } from '../lib/ai'
import { signOut } from '../lib/auth'
import { navigateTo } from '../router'

export async function renderInbox(app: HTMLElement): Promise<void> {
  app.innerHTML = `
    <div class="topbar">
      <span class="topbar-title">Inbox</span>
      <div class="topbar-actions">
        <button class="topbar-btn" id="goto-capture">+ Nieuw</button>
        <button class="topbar-btn" id="goto-process">Verwerken</button>
        <button class="topbar-btn" id="goto-graph">Graaf</button>
        <button class="topbar-btn" id="goto-book">Boek</button>
        <button class="topbar-btn" id="goto-themes">Thema's</button>
        <button class="topbar-btn" id="goto-settings">⚙</button>
        <button class="topbar-btn" id="logout-btn" title="Afmelden">&#x238B;</button>
      </div>
    </div>
    <div class="inbox-body">
      <details class="quick-capture" id="quick-capture">
        <summary class="quick-capture-toggle">+ Snel idee toevoegen</summary>
        <div class="quick-capture-form">
          <textarea id="quick-text" placeholder="Wat schiet je te binnen?" rows="2"></textarea>
          <button class="btn btn-primary" id="quick-save" disabled>Opslaan</button>
        </div>
      </details>
      <div class="inbox-tabs">
        <button class="inbox-tab" data-status="" aria-current="true">Alle</button>
        <button class="inbox-tab" data-status="inbox">Inbox</button>
        <button class="inbox-tab" data-status="verwerkt">Verwerkt</button>
        <button class="inbox-tab" data-status="archief">Archief</button>
      </div>
      <div class="inbox-themes" id="inbox-themes" hidden></div>
      <div class="inbox-active-filters" id="inbox-active-filters" hidden></div>
      <div class="inbox-toolbar">
        <input type="text" id="inbox-filter" placeholder="Zoeken in content, titel, samenvatting…" class="inbox-filter" />
        <label class="inbox-select-all"><input type="checkbox" id="select-all" /> alles</label>
      </div>
      <div class="inbox-bulkbar" id="inbox-bulkbar" hidden>
        <span id="bulk-count" class="muted"></span>
        <button class="btn btn-ghost" data-bulk="archive">Archiveer</button>
        <button class="btn btn-ghost" data-bulk="restore">→ Inbox</button>
        <button class="btn btn-danger" data-bulk="delete">Verwijder</button>
        <button class="btn btn-ghost" id="bulk-clear">Annuleer</button>
      </div>
      <div id="inbox-list" class="inbox-list">
        <div class="inbox-loading">Laden…</div>
      </div>
      <button class="btn btn-ghost inbox-load-more" id="load-more" style="display:none">Meer laden</button>
    </div>
    <div class="toast" id="toast"></div>
  `

  injectInboxStyles()

  document.getElementById('goto-capture')?.addEventListener('click', () => navigateTo('/capture'))
  document.getElementById('goto-process')?.addEventListener('click', () => navigateTo('/process'))
  document.getElementById('goto-graph')?.addEventListener('click', () => navigateTo('/graph'))
  document.getElementById('goto-book')?.addEventListener('click', () => navigateTo('/book'))
  document.getElementById('goto-themes')?.addEventListener('click', () => navigateTo('/themes'))
  document.getElementById('goto-settings')?.addEventListener('click', () => navigateTo('/settings'))
  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    await signOut()
    navigateTo('/login')
  })

  let page = 0
  let allNotes: Note[] = []
  let searchText = ''
  let statusFilter: NoteStatus | undefined = undefined
  let themeFilter: string | undefined = undefined
  let tagFilter: string | undefined = undefined
  let themes: Theme[] = []
  let noteThemes: { note_id: string; theme_id: string }[] = []
  const selected = new Set<string>()
  let searchDebounce: ReturnType<typeof setTimeout> | null = null

  try {
    [themes, noteThemes] = await Promise.all([fetchThemes(), fetchAllNoteThemes()])
    renderThemeFilter()
  } catch {
    // non-fatal — themes are optional
  }

  const listEl = document.getElementById('inbox-list') as HTMLDivElement
  const loadMoreBtn = document.getElementById('load-more') as HTMLButtonElement
  const filterInput = document.getElementById('inbox-filter') as HTMLInputElement
  const selectAllEl = document.getElementById('select-all') as HTMLInputElement
  const bulkBar = document.getElementById('inbox-bulkbar') as HTMLDivElement
  const bulkCount = document.getElementById('bulk-count') as HTMLSpanElement

  document.querySelectorAll<HTMLButtonElement>('.inbox-tab').forEach(tab => {
    tab.addEventListener('click', async () => {
      document.querySelectorAll('.inbox-tab').forEach(t => t.removeAttribute('aria-current'))
      tab.setAttribute('aria-current', 'true')
      const v = tab.dataset['status']
      statusFilter = v ? (v as NoteStatus) : undefined
      page = 0
      allNotes = []
      selected.clear()
      updateBulkBar()
      await loadNotes()
    })
  })

  filterInput.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce)
    searchDebounce = setTimeout(async () => {
      searchText = filterInput.value.trim()
      page = 0
      allNotes = []
      selected.clear()
      updateBulkBar()
      await loadNotes()
    }, 280)
  })

  selectAllEl.addEventListener('change', () => {
    if (selectAllEl.checked) {
      allNotes.forEach(n => selected.add(n.id))
    } else {
      selected.clear()
    }
    renderList()
    updateBulkBar()
  })

  document.querySelectorAll<HTMLButtonElement>('[data-bulk]').forEach(btn => {
    btn.addEventListener('click', () => onBulkAction(btn.dataset['bulk'] as 'archive' | 'restore' | 'delete'))
  })
  document.getElementById('bulk-clear')?.addEventListener('click', () => {
    selected.clear()
    selectAllEl.checked = false
    renderList()
    updateBulkBar()
  })

  loadMoreBtn.addEventListener('click', async () => {
    page++
    await loadNotes()
  })

  // Quick-capture wiring
  const quickText = document.getElementById('quick-text') as HTMLTextAreaElement
  const quickSave = document.getElementById('quick-save') as HTMLButtonElement
  quickText.addEventListener('input', () => {
    quickSave.disabled = quickText.value.trim() === ''
  })
  quickText.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !quickSave.disabled) quickSave.click()
  })
  quickSave.addEventListener('click', async () => {
    const content = quickText.value.trim()
    if (!content) return
    quickSave.disabled = true
    try {
      if (navigator.onLine) {
        const note = await insertNote({ content })
        allNotes = [note, ...allNotes]
        renderList()
        showToast('Opgeslagen')
      } else {
        await queueOfflineNote({ content })
        showToast('Opgeslagen (offline wachtrij)')
      }
      quickText.value = ''
      ;(document.getElementById('quick-capture') as HTMLDetailsElement).open = false
    } catch (err) {
      showToast(`Mislukt: ${errMsg(err)}`)
    } finally {
      quickSave.disabled = quickText.value.trim() === ''
    }
  })

  await loadNotes()

  async function loadNotes(): Promise<void> {
    try {
      const notes = await fetchNotes(page, 50, statusFilter, searchText || undefined, {
        themeId: themeFilter,
        tag: tagFilter
      })
      allNotes = page === 0 ? notes : [...allNotes, ...notes]
      loadMoreBtn.style.display = notes.length === 50 ? 'flex' : 'none'
      renderList()
      renderActiveFilters()
    } catch (err) {
      listEl.innerHTML = `<div class="inbox-error">Laden mislukt: ${escHtml(errMsg(err))}</div>`
      console.error(err)
    }
  }

  function renderThemeFilter(): void {
    const el = document.getElementById('inbox-themes') as HTMLDivElement
    if (themes.length === 0) { el.hidden = true; return }
    el.hidden = false
    el.innerHTML = `
      <button class="inbox-tab" data-theme="" ${!themeFilter ? 'aria-current="true"' : ''}>Alle thema's</button>
      ${themes.map(t => `
        <button class="inbox-tab inbox-tab-theme" data-theme="${t.id}" ${themeFilter === t.id ? 'aria-current="true"' : ''}>
          <span class="theme-dot" style="background:${escHtml(t.color)}"></span>${escHtml(t.name)}
        </button>
      `).join('')}
    `
    el.querySelectorAll<HTMLButtonElement>('button').forEach(btn => {
      btn.addEventListener('click', async () => {
        themeFilter = btn.dataset['theme'] || undefined
        page = 0
        allNotes = []
        selected.clear()
        renderThemeFilter()
        updateBulkBar()
        await loadNotes()
      })
    })
  }

  function renderActiveFilters(): void {
    const el = document.getElementById('inbox-active-filters') as HTMLDivElement
    const chips: string[] = []
    if (tagFilter) chips.push(`<span class="active-chip">tag: ${escHtml(tagFilter)} <button data-clear="tag">×</button></span>`)
    if (chips.length === 0) { el.hidden = true; el.innerHTML = ''; return }
    el.hidden = false
    el.innerHTML = chips.join('')
    el.querySelectorAll<HTMLButtonElement>('[data-clear]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (btn.dataset['clear'] === 'tag') tagFilter = undefined
        page = 0
        allNotes = []
        await loadNotes()
      })
    })
  }

  function renderList(): void {
    if (allNotes.length === 0) {
      listEl.innerHTML = '<div class="inbox-empty">Geen notities gevonden.</div>'
      selectAllEl.checked = false
      return
    }
    const themesById: Record<string, Theme> = {}
    themes.forEach(t => { themesById[t.id] = t })
    const themeIdsByNote: Record<string, string[]> = {}
    noteThemes.forEach(nt => {
      ;(themeIdsByNote[nt.note_id] ??= []).push(nt.theme_id)
    })
    listEl.innerHTML = allNotes
      .map(note => renderNoteRow(note, selected.has(note.id), themeIdsByNote[note.id] ?? [], themesById))
      .join('')
    attachRowListeners()
    selectAllEl.checked = allNotes.length > 0 && allNotes.every(n => selected.has(n.id))
  }

  function updateBulkBar(): void {
    if (selected.size === 0) {
      bulkBar.hidden = true
      return
    }
    bulkBar.hidden = false
    bulkCount.textContent = `${selected.size} geselecteerd`
  }

  async function onBulkAction(action: 'archive' | 'restore' | 'delete'): Promise<void> {
    const ids = Array.from(selected)
    if (ids.length === 0) return
    try {
      if (action === 'delete') {
        if (!confirm(`${ids.length} nota('s) definitief verwijderen?`)) return
        await bulkDelete(ids)
        allNotes = allNotes.filter(n => !selected.has(n.id))
      } else {
        const newStatus: NoteStatus = action === 'archive' ? 'archief' : 'inbox'
        await bulkUpdateStatus(ids, newStatus)
        allNotes = allNotes.map(n => selected.has(n.id) ? { ...n, status: newStatus } : n)
        if (statusFilter && statusFilter !== newStatus) {
          allNotes = allNotes.filter(n => !selected.has(n.id))
        }
      }
      selected.clear()
      renderList()
      updateBulkBar()
      showToast(`${ids.length} bijgewerkt`)
    } catch (err) {
      showToast(`Mislukt: ${errMsg(err)}`)
    }
  }

  function attachRowListeners(): void {
    listEl.querySelectorAll<HTMLElement>('.inbox-row').forEach(row => {
      const id = row.dataset['id']!

      row.querySelector<HTMLInputElement>('.row-check')?.addEventListener('change', (e) => {
        e.stopPropagation()
        const cb = e.currentTarget as HTMLInputElement
        if (cb.checked) selected.add(id); else selected.delete(id)
        updateBulkBar()
        selectAllEl.checked = allNotes.every(n => selected.has(n.id))
      })

      row.querySelector('.row-header')?.addEventListener('click', () => {
        const expanded = row.classList.toggle('expanded')
        row.querySelector('.row-detail')!.setAttribute('aria-hidden', String(!expanded))
        if (expanded) loadSimilar(row, id)
      })

      row.querySelectorAll<HTMLElement>('.tag-badge').forEach(b => {
        b.addEventListener('click', async (e) => {
          e.stopPropagation()
          const t = b.dataset['tag']
          if (!t) return
          tagFilter = t
          page = 0
          allNotes = []
          await loadNotes()
        })
      })

      row.querySelector('.row-edit-btn')?.addEventListener('click', (e) => {
        e.stopPropagation()
        toggleEdit(row, id)
      })

      row.querySelector('.row-delete-btn')?.addEventListener('click', async (e) => {
        e.stopPropagation()
        if (!confirm('Notitie verwijderen?')) return
        try {
          await deleteNote(id)
          allNotes = allNotes.filter(n => n.id !== id)
          selected.delete(id)
          renderList()
          updateBulkBar()
        } catch {
          showToast('Verwijderen mislukt.')
        }
      })
    })
  }

  async function loadSimilar(row: HTMLElement, id: string): Promise<void> {
    const slot = row.querySelector<HTMLDivElement>('[data-similar-slot]')
    if (!slot || slot.dataset['loaded']) return
    slot.dataset['loaded'] = '1'
    slot.innerHTML = '<span class="muted">Vergelijkbare nota\'s zoeken…</span>'
    try {
      const similar = await fetchSimilarNotes(id, 5)
      if (similar.length === 0) {
        slot.innerHTML = ''
        return
      }
      slot.innerHTML = `
        <h4 class="similar-title">Vergelijkbare nota's</h4>
        <ul class="similar-list">
          ${similar.map(s => `
            <li>
              <span class="similar-score">${(s.similarity * 100).toFixed(0)}%</span>
              <span>${escHtml(s.ai_title ?? s.content.slice(0, 100))}</span>
            </li>
          `).join('')}
        </ul>
      `
    } catch {
      slot.innerHTML = ''
    }
  }

  function toggleEdit(row: HTMLElement, id: string): void {
    const note = allNotes.find(n => n.id === id)
    if (!note) return

    const isEditing = row.classList.contains('editing')
    if (isEditing) {
      const contentEl = row.querySelector<HTMLTextAreaElement>('.edit-content')!
      const miniEl = row.querySelector<HTMLTextAreaElement>('.edit-mini')
      const updates: NoteUpdate = { content: contentEl.value.trim() }
      if (miniEl) updates.mini_notes = miniEl.value.trim() || null
      updateNote(id, updates)
        .then(updated => {
          const idx = allNotes.findIndex(n => n.id === id)
          if (idx !== -1) allNotes[idx] = updated
          renderList()
        })
        .catch(() => showToast('Opslaan mislukt.'))
    } else {
      row.classList.add('editing', 'expanded')
      const detailEl = row.querySelector('.row-detail')!
      detailEl.innerHTML = `
        <textarea class="edit-content">${escHtml(note.content)}</textarea>
        <textarea class="edit-mini" placeholder="Extra notitie…">${escHtml(note.mini_notes ?? '')}</textarea>
        <div class="row-actions">
          <button class="btn btn-primary row-edit-btn" style="width:auto">Opslaan</button>
          <button class="btn btn-danger row-delete-btn" style="width:auto">Verwijderen</button>
        </div>
      `
      row.querySelector('.row-edit-btn')?.addEventListener('click', (e) => {
        e.stopPropagation()
        toggleEdit(row, id)
      })
      row.querySelector('.row-delete-btn')?.addEventListener('click', async (e) => {
        e.stopPropagation()
        if (!confirm('Notitie verwijderen?')) return
        try {
          await deleteNote(id)
          allNotes = allNotes.filter(n => n.id !== id)
          selected.delete(id)
          renderList()
          updateBulkBar()
        } catch {
          showToast('Verwijderen mislukt.')
        }
      })
    }
  }
}

function renderNoteRow(
  note: Note,
  isSelected: boolean,
  themeIds: string[],
  themesById: Record<string, Theme>
): string {
  const preview = note.ai_title ?? note.content.slice(0, 200)
  const date = relativeDate(note.created_at)
  const badgeClass = `badge badge-${note.status}`
  const themeDots = themeIds
    .map(id => themesById[id])
    .filter(Boolean)
    .map(t => `<span class="row-theme-dot" style="background:${escHtml(t.color)}" title="${escHtml(t.name)}"></span>`)
    .join('')
  const themeNames = themeIds
    .map(id => themesById[id]?.name)
    .filter((n): n is string => !!n)
  return `
    <div class="inbox-row" data-id="${note.id}">
      <div class="row-select">
        <input type="checkbox" class="row-check" ${isSelected ? 'checked' : ''} aria-label="selecteer" />
      </div>
      <div class="row-main">
        <div class="row-header" role="button" tabindex="0" aria-expanded="false">
          <div class="row-preview">${escHtml(preview)}${!note.ai_title && note.content.length > 200 ? '…' : ''}</div>
          <div class="row-meta">
            ${themeDots ? `<span class="row-theme-dots">${themeDots}</span>` : ''}
            <span class="${badgeClass}">${escHtml(note.status)}</span>
            <span class="row-date">${date}</span>
          </div>
        </div>
        <div class="row-detail" aria-hidden="true">
          ${note.ai_summary ? `<div class="row-mini"><em>${escHtml(note.ai_summary)}</em></div>` : ''}
          <div class="row-full-content">${escHtml(note.content)}</div>
          ${note.mini_notes ? `<div class="row-mini">${escHtml(note.mini_notes)}</div>` : ''}
          ${note.source_url ? `<a class="row-source" href="${escHtml(note.source_url)}" target="_blank" rel="noopener">${escHtml(note.source_title ?? note.source_url)}</a>` : ''}
          ${themeNames.length ? `<div class="row-themes">${themeNames.map(n => `<span class="badge">${escHtml(n)}</span>`).join('')}</div>` : ''}
          ${(note.tags ?? []).length ? `<div class="row-tags">${note.tags.map(t => `<button type="button" class="badge tag-badge" data-tag="${escHtml(t)}">${escHtml(t)}</button>`).join('')}</div>` : ''}
          <div class="row-similar" data-similar-slot></div>
          <div class="row-actions">
            <button class="btn btn-ghost row-edit-btn" style="width:auto;min-height:36px">Bewerken</button>
            <button class="btn btn-danger row-delete-btn" style="width:auto;min-height:36px">Verwijderen</button>
          </div>
        </div>
      </div>
    </div>
  `
}

function relativeDate(iso: string): string {
  const now = new Date()
  const d = new Date(iso)
  const diffMs = now.getTime() - d.getTime()
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffDays === 0) return 'vandaag'
  if (diffDays === 1) return 'gisteren'
  if (diffDays < 7) return `${diffDays} dagen geleden`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weken geleden`
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' })
}

function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'onbekende fout'
}

function showToast(msg: string): void {
  const toast = document.getElementById('toast') as HTMLDivElement | null
  if (!toast) return
  toast.textContent = msg
  toast.classList.add('show')
  setTimeout(() => toast.classList.remove('show'), 2500)
}

function injectInboxStyles(): void {
  if (document.getElementById('inbox-styles')) return
  const style = document.createElement('style')
  style.id = 'inbox-styles'
  style.textContent = `
    .inbox-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      padding: var(--s-4);
      gap: var(--s-3);
      max-width: 800px;
      width: 100%;
      margin: 0 auto;
    }
    .inbox-toolbar {
      display: flex;
      gap: var(--s-2);
      align-items: center;
    }
    .inbox-filter {
      flex: 1;
    }
    .inbox-select-all {
      display: inline-flex;
      align-items: center;
      gap: var(--s-1);
      font-size: var(--fs-sm);
      color: var(--text-muted);
      white-space: nowrap;
    }
    .inbox-bulkbar {
      display: flex;
      gap: var(--s-2);
      align-items: center;
      padding: var(--s-2) var(--s-3);
      background: var(--surface);
      border: 1px solid var(--accent);
      border-radius: var(--r-sm);
      flex-wrap: wrap;
    }
    .inbox-bulkbar .btn { width: auto; min-height: 32px; padding: var(--s-1) var(--s-3); }
    .inbox-list {
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }
    .inbox-loading, .inbox-empty, .inbox-error {
      color: var(--text-muted);
      font-size: var(--fs-sm);
      text-align: center;
      padding: var(--s-7) 0;
    }
    .inbox-row {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      overflow: hidden;
      display: flex;
      align-items: stretch;
    }
    .row-select {
      display: flex;
      align-items: flex-start;
      padding: var(--s-3) var(--s-2) 0 var(--s-3);
    }
    .row-main { flex: 1; }
    .row-header {
      padding: var(--s-3) var(--s-4);
      cursor: pointer;
      user-select: none;
    }
    .row-header:hover {
      background: var(--bg);
    }
    .row-preview {
      font-size: var(--fs-base);
      margin-bottom: var(--s-2);
      color: var(--text);
    }
    .row-meta {
      display: flex;
      align-items: center;
      gap: var(--s-2);
    }
    .row-date {
      font-size: var(--fs-sm);
      color: var(--text-muted);
    }
    .row-detail {
      display: none;
      padding: var(--s-4);
      border-top: 1px solid var(--border);
      flex-direction: column;
      gap: var(--s-3);
    }
    .inbox-row.expanded .row-detail {
      display: flex;
    }
    .row-full-content {
      font-size: var(--fs-base);
      white-space: pre-wrap;
      color: var(--text);
    }
    .row-mini {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      white-space: pre-wrap;
    }
    .row-source {
      font-size: var(--fs-sm);
      color: var(--accent);
      word-break: break-all;
    }
    .row-tags {
      display: flex;
      gap: var(--s-1);
      flex-wrap: wrap;
    }
    .row-similar:empty { display: none; }
    .similar-title {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      margin-bottom: var(--s-1);
      font-weight: 500;
    }
    .similar-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: var(--fs-sm);
    }
    .similar-list li {
      display: flex;
      gap: var(--s-2);
      padding: var(--s-1) var(--s-2);
      background: var(--bg);
      border-radius: var(--r-sm);
    }
    .similar-score {
      flex-shrink: 0;
      color: var(--accent-hover);
      font-weight: 500;
      width: 40px;
    }
    .row-actions {
      display: flex;
      gap: var(--s-2);
      flex-wrap: wrap;
    }
    .edit-content, .edit-mini {
      width: 100%;
    }
    .inbox-load-more {
      margin: var(--s-3) auto;
      width: auto;
    }
    .inbox-tabs {
      display: flex;
      gap: var(--s-2);
      flex-wrap: wrap;
    }
    .inbox-tab {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-sm);
      padding: var(--s-2) var(--s-3);
      cursor: pointer;
      font-size: var(--fs-sm);
      color: var(--text-muted);
    }
    .inbox-tab[aria-current="true"] {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    .muted { color: var(--text-muted); font-size: var(--fs-sm); }
    .quick-capture {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      overflow: hidden;
    }
    .quick-capture-toggle {
      list-style: none;
      cursor: pointer;
      padding: var(--s-3) var(--s-4);
      font-size: var(--fs-sm);
      color: var(--text-muted);
      user-select: none;
    }
    .quick-capture-toggle::-webkit-details-marker { display: none; }
    .quick-capture[open] .quick-capture-toggle { border-bottom: 1px solid var(--border); }
    .quick-capture-form {
      padding: var(--s-3) var(--s-4);
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }
    .quick-capture-form .btn { width: auto; align-self: flex-end; }
    .inbox-themes {
      display: flex;
      gap: var(--s-1);
      flex-wrap: wrap;
      align-items: center;
    }
    .inbox-tab-theme { display: inline-flex; align-items: center; gap: var(--s-1); }
    .theme-dot {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }
    .row-theme-dots {
      display: inline-flex;
      gap: 3px;
      align-items: center;
    }
    .row-theme-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    .row-themes {
      display: flex;
      gap: var(--s-1);
      flex-wrap: wrap;
    }
    .tag-badge {
      cursor: pointer;
      border: none;
      font-family: inherit;
    }
    .tag-badge:hover { background: var(--accent); color: #fff; }
    .inbox-active-filters {
      display: flex;
      gap: var(--s-2);
      flex-wrap: wrap;
    }
    .active-chip {
      display: inline-flex;
      align-items: center;
      gap: var(--s-1);
      padding: 2px var(--s-2);
      background: var(--accent);
      color: #fff;
      border-radius: var(--r-sm);
      font-size: var(--fs-sm);
    }
    .active-chip button {
      background: rgba(255,255,255,0.3);
      border: none;
      color: #fff;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      cursor: pointer;
      line-height: 1;
    }
  `
  document.head.appendChild(style)
}
