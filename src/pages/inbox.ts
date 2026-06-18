import {
  fetchNotes,
  deleteNote,
  bulkUpdateStatus,
  bulkDelete,
  type Note,
  type NoteStatus,
  type NoteType
} from '../lib/notes'
import { NOTE_TYPES, NOTE_TYPE_ORDER } from '../lib/noteTypes'
import { renderTopbar, attachTopbar } from '../lib/nav'
import { navigateTo } from '../router'

export async function renderInbox(app: HTMLElement): Promise<void> {
  app.innerHTML = `
    ${renderTopbar('Inbox', 'inbox')}
    <div class="inbox-body">
      <div id="review-banner" class="review-banner" hidden></div>
      <div class="inbox-tabs">
        <button class="inbox-tab" data-status="" aria-current="true">Alle</button>
        <button class="inbox-tab" data-status="inbox">Inbox</button>
        <button class="inbox-tab" data-status="verwerkt">Verwerkt</button>
        <button class="inbox-tab" data-status="archief">Archief</button>
      </div>
      <div class="inbox-type-pills" id="inbox-type-pills">
        <button class="type-pill active" data-note-type="">Alle types</button>
        ${NOTE_TYPE_ORDER.map(t => {
          const m = NOTE_TYPES[t]
          return `<button class="type-pill" data-note-type="${t}" style="--pill-color:${m.color}">${escHtml(m.label)}</button>`
        }).join('')}
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
  let noteTypeFilter: NoteType | undefined = undefined
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

  document.querySelectorAll<HTMLButtonElement>('.type-pill').forEach(pill => {
    pill.addEventListener('click', async () => {
      document.querySelectorAll('.type-pill').forEach(p => p.classList.remove('active'))
      pill.classList.add('active')
      const v = pill.dataset['noteType']
      noteTypeFilter = v ? (v as NoteType) : undefined
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
  showReviewBanner()

  async function showReviewBanner(): Promise<void> {
    try {
      const old = await fetchNotes(0, 200, 'inbox')
      const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000
      const stale = old.filter(n => new Date(n.created_at).getTime() < cutoff)
      const banner = document.getElementById('review-banner') as HTMLDivElement | null
      if (!banner) return
      if (stale.length === 0) { banner.hidden = true; return }
      banner.hidden = false
      banner.innerHTML = `
        <span class="review-icon">&#x23F0;</span>
        <span>${stale.length} nota${stale.length === 1 ? '' : "'s"} staat al meer dan 90 dagen onverwerkt in de inbox.</span>
        <button class="btn-inline" id="review-filter-btn">Bekijk</button>
        <button class="review-dismiss" id="review-dismiss" title="Sluiten">&#x2715;</button>
      `
      document.getElementById('review-filter-btn')?.addEventListener('click', () => {
        const inboxTab = document.querySelector<HTMLButtonElement>('.inbox-tab[data-status="inbox"]')
        inboxTab?.click()
        banner.hidden = true
      })
      document.getElementById('review-dismiss')?.addEventListener('click', () => {
        banner.hidden = true
      })
    } catch {
      // non-critical, ignore
    }
  }

  async function loadNotes(): Promise<void> {
    try {
      const notes = await fetchNotes(page, 50, statusFilter, searchText || undefined)
      const filtered = noteTypeFilter ? notes.filter(n => n.note_type === noteTypeFilter) : notes
      allNotes = page === 0 ? filtered : [...allNotes, ...filtered]
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
        const removed = allNotes.filter(n => selected.has(n.id))
        allNotes = allNotes.filter(n => !selected.has(n.id))
        selected.clear()
        renderList()
        updateBulkBar()

        let undone = false
        showToastWithUndo(`${ids.length} nota${ids.length === 1 ? '' : "'s"} verwijderd`, () => {
          undone = true
          allNotes = [...removed, ...allNotes].sort(
            (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
          )
          renderList()
          updateBulkBar()
        })
        setTimeout(async () => {
          if (undone) return
          try { await bulkDelete(ids) } catch { showToast('Verwijderen mislukt.') }
        }, 5000)
      } else {
        const newStatus: NoteStatus = action === 'archive' ? 'archief' : 'inbox'
        await bulkUpdateStatus(ids, newStatus)
        allNotes = allNotes.map(n => selected.has(n.id) ? { ...n, status: newStatus } : n)
        if (statusFilter && statusFilter !== newStatus) {
          allNotes = allNotes.filter(n => !selected.has(n.id))
        }
        selected.clear()
        renderList()
        updateBulkBar()
        showToast(`${ids.length} bijgewerkt`)
      }
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
        navigateTo('/note?id=' + id)
      })

      row.querySelector('.row-delete-btn')?.addEventListener('click', async (e) => {
        e.stopPropagation()
        const note = allNotes.find(n => n.id === id)
        if (!note) return
        const noteIdx = allNotes.findIndex(n => n.id === id)
        allNotes = allNotes.filter(n => n.id !== id)
        selected.delete(id)
        renderList()
        updateBulkBar()

        let undone = false
        showToastWithUndo('Nota verwijderd', () => {
          undone = true
          allNotes.splice(noteIdx, 0, note)
          renderList()
        })
        setTimeout(async () => {
          if (undone) return
          try { await deleteNote(id) } catch { showToast('Verwijderen mislukt.') }
        }, 5000)
      })
    })
  }

}

function renderNoteRow(note: Note, isSelected: boolean): string {
  const preview = note.ai_title ?? note.content.slice(0, 200)
  const date = relativeDate(note.created_at)
  const badgeClass = `badge badge-${note.status}`
  const typeMeta = NOTE_TYPES[note.note_type ?? 'fleeting']
  const typeBadge = `<span class="note-type-badge" style="background:${typeMeta?.color ?? '#888'}">${escHtml(typeMeta?.label ?? note.note_type ?? '')}</span>`
  return `
    <div class="inbox-row" data-id="${note.id}">
      <div class="row-select">
        <input type="checkbox" class="row-check" ${isSelected ? 'checked' : ''} aria-label="selecteer" />
      </div>
      <div class="row-main">
        <div class="row-header" role="button" tabindex="0" aria-expanded="false">
          <div class="row-preview">${escHtml(preview)}${!note.ai_title && note.content.length > 200 ? '…' : ''}</div>
          <div class="row-meta">
            ${typeBadge}
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

function showToastWithUndo(msg: string, onUndo: () => void): void {
  const toast = document.getElementById('toast') as HTMLDivElement | null
  if (!toast) return
  toast.innerHTML = `${escHtml(msg)} <button class="toast-undo">Ongedaan maken</button>`
  toast.classList.add('show')
  toast.querySelector<HTMLButtonElement>('.toast-undo')?.addEventListener('click', () => {
    onUndo()
    toast.classList.remove('show')
  })
  setTimeout(() => toast.classList.remove('show'), 5000)
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
    .review-banner {
      display: flex;
      align-items: center;
      gap: var(--s-2);
      padding: var(--s-2) var(--s-3);
      background: #FFF7E6;
      border: 1px solid #FFD27F;
      border-radius: var(--r-sm);
      font-size: var(--fs-sm);
      color: #6B4A00;
      flex-wrap: wrap;
    }
    .review-icon { font-size: 1rem; }
    .review-banner span:nth-child(2) { flex: 1; }
    .btn-inline {
      background: none;
      border: 1px solid currentColor;
      border-radius: var(--r-sm);
      padding: 2px var(--s-2);
      font-size: var(--fs-sm);
      cursor: pointer;
      color: inherit;
      font-weight: 500;
    }
    .btn-inline:hover { background: rgba(0,0,0,0.05); }
    .review-dismiss {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 1rem;
      color: inherit;
      padding: 0 2px;
      opacity: 0.6;
    }
    .review-dismiss:hover { opacity: 1; }
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
    .inbox-type-pills {
      display: flex;
      gap: var(--s-1);
      flex-wrap: wrap;
    }
    .type-pill {
      background: var(--surface);
      border: 1.5px solid var(--pill-color, var(--border));
      border-radius: var(--r-sm);
      padding: 2px var(--s-2);
      cursor: pointer;
      font-size: var(--fs-sm);
      color: var(--pill-color, var(--text-muted));
    }
    .type-pill.active {
      background: var(--pill-color, var(--accent));
      color: #fff;
      font-weight: 600;
    }
    .note-type-badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: var(--r-sm);
      font-size: 11px;
      font-weight: 600;
      color: #fff;
      letter-spacing: 0.02em;
    }
    .muted { color: var(--text-muted); font-size: var(--fs-sm); }
  `
  document.head.appendChild(style)
}
