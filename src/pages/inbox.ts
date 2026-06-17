import {
  fetchNotes,
  updateNote,
  deleteNote,
  bulkUpdateStatus,
  bulkDelete,
  type Note,
  type NoteStatus,
  type NoteUpdate
} from '../lib/notes'
import { renderTopbar, attachTopbar } from '../lib/nav'

export async function renderInbox(app: HTMLElement): Promise<void> {
  app.innerHTML = `
    ${renderTopbar('Inbox', 'inbox')}
    <div class="inbox-body">
      <div class="inbox-tabs">
        <button class="inbox-tab" data-status="" aria-current="true">Alle</button>
        <button class="inbox-tab" data-status="inbox">Inbox</button>
        <button class="inbox-tab" data-status="verwerkt">Verwerkt</button>
        <button class="inbox-tab" data-status="archief">Archief</button>
      </div>
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
  attachTopbar()

  let page = 0
  let allNotes: Note[] = []
  let searchText = ''
  let statusFilter: NoteStatus | undefined = undefined
  const selected = new Set<string>()
  let searchDebounce: ReturnType<typeof setTimeout> | null = null

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

  await loadNotes()

  async function loadNotes(): Promise<void> {
    try {
      const notes = await fetchNotes(page, 50, statusFilter, searchText || undefined)
      allNotes = page === 0 ? notes : [...allNotes, ...notes]
      loadMoreBtn.style.display = notes.length === 50 ? 'flex' : 'none'
      renderList()
    } catch (err) {
      listEl.innerHTML = `<div class="inbox-error">Laden mislukt: ${escHtml(errMsg(err))}</div>`
      console.error(err)
    }
  }

  function renderList(): void {
    if (allNotes.length === 0) {
      listEl.innerHTML = '<div class="inbox-empty">Geen notities gevonden.</div>'
      selectAllEl.checked = false
      return
    }
    listEl.innerHTML = allNotes.map(note => renderNoteRow(note, selected.has(note.id))).join('')
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

function renderNoteRow(note: Note, isSelected: boolean): string {
  const preview = note.ai_title ?? note.content.slice(0, 200)
  const date = relativeDate(note.created_at)
  const badgeClass = `badge badge-${note.status}`
  return `
    <div class="inbox-row" data-id="${note.id}">
      <div class="row-select">
        <input type="checkbox" class="row-check" ${isSelected ? 'checked' : ''} aria-label="selecteer" />
      </div>
      <div class="row-main">
        <div class="row-header" role="button" tabindex="0" aria-expanded="false">
          <div class="row-preview">${escHtml(preview)}${!note.ai_title && note.content.length > 200 ? '…' : ''}</div>
          <div class="row-meta">
            <span class="${badgeClass}">${escHtml(note.status)}</span>
            <span class="row-date">${date}</span>
          </div>
        </div>
        <div class="row-detail" aria-hidden="true">
          ${note.ai_summary ? `<div class="row-mini"><em>${escHtml(note.ai_summary)}</em></div>` : ''}
          <div class="row-full-content">${escHtml(note.content)}</div>
          ${note.mini_notes ? `<div class="row-mini">${escHtml(note.mini_notes)}</div>` : ''}
          ${note.source_url ? `<a class="row-source" href="${escHtml(note.source_url)}" target="_blank" rel="noopener">${escHtml(note.source_title ?? note.source_url)}</a>` : ''}
          ${(note.tags ?? []).length ? `<div class="row-tags">${note.tags.map(t => `<span class="badge">${escHtml(t)}</span>`).join('')}</div>` : ''}
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
  `
  document.head.appendChild(style)
}
