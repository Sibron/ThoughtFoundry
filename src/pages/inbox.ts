import {
  fetchNotes,
  fetchConnectedNoteIds,
  deleteNote,
  bulkUpdateStatus,
  bulkDelete,
  type Note,
  type NoteStatus,
  type NoteType
} from '../lib/notes'
import { NOTE_TYPES, NOTE_TYPE_ORDER } from '../lib/noteTypes'
import { renderTopbar, attachTopbar, renderGuidanceBanner } from '../lib/nav'
import { navigateTo } from '../router'
import { mountSearch } from './search'
import { mountGraph } from './graph'
import { mountConnections } from './connections'
import { injectShellStyles } from './denktools'
import { esc as escHtml, errMsg, showToast, showUndoToast, formatRelative } from '../lib/crud-list'

export async function renderInbox(app: HTMLElement): Promise<void> {
  app.innerHTML = `
    ${renderTopbar('Vangbak', 'inbox')}
    <div class="inbox-view-toggle focus-hide" id="inbox-view-toggle">
      <button class="shell-tab" data-view="list" aria-current="true">Lijst</button>
      <button class="shell-tab" data-view="search">Zoeken</button>
      <button class="shell-tab" data-view="graph">Graaf</button>
      <button class="shell-tab" data-view="connections">Verbindingen</button>
    </div>
    <div id="inbox-view">
      <div id="inbox-list-view"></div>
      <div id="inbox-aux-view" hidden></div>
    </div>
    <div class="toast" id="toast"></div>
  `
  injectShellStyles()
  attachTopbar()

  const listView = document.getElementById('inbox-list-view')!
  const auxView = document.getElementById('inbox-aux-view')!
  const toggle = document.getElementById('inbox-view-toggle')!

  // The list holds expensive state (status/type filters, search text, selection,
  // loaded pages, scroll), so it is mounted once and only hidden/shown. Zoeken,
  // Graaf and Verbindingen are "re-finding" views without state worth keeping —
  // they mount fresh into a separate aux container.
  type AuxView = 'search' | 'graph' | 'connections'
  let current: 'list' | AuxView = 'list'
  let auxLoading = false
  let auxDesired: AuxView | null = null

  // Single in-flight aux mount; re-mount if a newer view was requested mid-load
  // so the last-clicked view wins (guards against fast switching).
  async function showAux(v: AuxView): Promise<void> {
    auxDesired = v
    if (auxLoading) return
    auxLoading = true
    try {
      while (auxDesired) {
        const t: AuxView = auxDesired
        auxView.innerHTML = ''
        if (t === 'search') await mountSearch(auxView)
        else if (t === 'graph') await mountGraph(auxView)
        else await mountConnections(auxView)
        if (auxDesired === t) break
      }
    } finally {
      auxLoading = false
    }
  }

  toggle.querySelectorAll<HTMLButtonElement>('.shell-tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      const v = btn.dataset['view'] as 'list' | AuxView
      if (v === current) return
      current = v
      toggle.querySelectorAll('.shell-tab').forEach(b => b.removeAttribute('aria-current'))
      btn.setAttribute('aria-current', 'true')
      if (v === 'list') {
        // Stop any pending aux mount and reveal the preserved list. Don't clear
        // aux content here — an in-flight mount may still be writing into it.
        auxDesired = null
        auxView.hidden = true
        listView.hidden = false
      } else {
        listView.hidden = true
        auxView.hidden = false
        await showAux(v)
      }
    })
  })

  // Deep-links: /inbox?view=search|graph|verbindingen (used by the old
  // /search and /graph routes, Vandaag's CTA's, and "Bekijk in graaf" entries).
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
  const requestedView = params.get('view')
  const viewAlias: Record<string, string> = { zoeken: 'search', graaf: 'graph', verbindingen: 'connections' }
  const view = requestedView ? (viewAlias[requestedView] ?? requestedView) : null
  if (view === 'search' || view === 'graph' || view === 'connections') {
    toggle.querySelector<HTMLButtonElement>(`[data-view="${view}"]`)?.click()
  }

  await mountInboxList(listView)
}

export async function mountInboxList(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="inbox-body">
      ${renderGuidanceBanner('Pak er één uit. Lees het. Geef het een plek.')}
      <div class="inbox-tabs focus-hide">
        <button class="inbox-tab" data-status="" aria-current="true">Alle</button>
        <button class="inbox-tab" data-status="inbox">Vangbak</button>
        <button class="inbox-tab" data-status="verwerkt">Verwerkt</button>
        <button class="inbox-tab" data-status="archief">Archief</button>
      </div>
      <div class="inbox-type-pills focus-hide" id="inbox-type-pills">
        <button class="type-pill active" data-note-type="">Alle types</button>
        ${NOTE_TYPE_ORDER.map(t => {
          const m = NOTE_TYPES[t]
          return `<button class="type-pill" data-note-type="${t}" style="--pill-color:${m.color}">${escHtml(m.label)}</button>`
        }).join('')}
        <button class="type-pill orphan-pill" id="orphan-pill" title="Notities zonder enkele link of thema">⚓ Wees-notities</button>
      </div>
      <div class="orphan-banner focus-hide" id="orphan-banner" hidden></div>
      <div class="inbox-toolbar">
        <input type="text" id="inbox-filter" placeholder="Filter deze lijst…" title="Filtert de geladen notities. Diep zoeken? Gebruik Zoek in de bovenbalk." class="inbox-filter" />
        <label class="inbox-select-all"><input type="checkbox" id="select-all" /> alles</label>
      </div>
      <div class="inbox-bulkbar" id="inbox-bulkbar" hidden>
        <span id="bulk-count" class="muted"></span>
        <button class="btn btn-ghost" data-bulk="archive">Archiveer</button>
        <button class="btn btn-ghost" data-bulk="restore">→ Vangbak</button>
        <button class="btn btn-danger" data-bulk="delete">Verwijder</button>
        <button class="btn btn-ghost" id="bulk-clear">Annuleer</button>
      </div>
      <div id="inbox-list" class="inbox-list">
        <div class="inbox-loading">Laden…</div>
      </div>
      <button class="btn btn-ghost inbox-load-more" id="load-more" style="display:none">Meer laden</button>
    </div>
  `

  injectInboxStyles()

  let page = 0
  let allNotes: Note[] = []
  let searchText = ''
  let statusFilter: NoteStatus | undefined = undefined
  let noteTypeFilter: NoteType | undefined = undefined
  let orphanMode = false
  let connectedIds: Set<string> | null = null
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

  // Pure client-side filter over the already-loaded rows — instant, no
  // refetch. Deep search (full corpus, relevance-ranked, semantic mode) lives
  // behind the Zoek button in the topbar.
  filterInput.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce)
    searchDebounce = setTimeout(() => {
      searchText = filterInput.value.trim().toLowerCase()
      renderList()
    }, 120)
  })

  selectAllEl.addEventListener('change', () => {
    if (selectAllEl.checked) {
      visibleNotes().forEach(n => selected.add(n.id))
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

  const orphanPill = document.getElementById('orphan-pill') as HTMLButtonElement
  orphanPill.addEventListener('click', async () => {
    orphanMode = !orphanMode
    orphanPill.classList.toggle('active', orphanMode)
    page = 0
    allNotes = []
    selected.clear()
    updateBulkBar()
    await loadNotes()
  })

  await loadNotes()
  void initOrphanBanner()

  async function ensureConnected(): Promise<Set<string>> {
    if (!connectedIds) connectedIds = await fetchConnectedNoteIds()
    return connectedIds
  }

  async function loadNotes(): Promise<void> {
    try {
      if (orphanMode) {
        // Orphans = notes with no link and no theme. Filter a wide recent pool
        // client-side; no pagination (the pile is meant to be drained, not browsed).
        const connected = await ensureConnected()
        const pool = await fetchNotes(0, 300, statusFilter, undefined, noteTypeFilter)
        allNotes = pool.filter(n => !connected.has(n.id))
        loadMoreBtn.style.display = 'none'
        renderList()
        return
      }
      const notes = await fetchNotes(page, 50, statusFilter, undefined, noteTypeFilter)
      allNotes = page === 0 ? notes : [...allNotes, ...notes]
      loadMoreBtn.style.display = notes.length === 50 ? 'flex' : 'none'
      renderList()
    } catch (err) {
      listEl.innerHTML = `<div class="inbox-error">Laden mislukt: ${escHtml(errMsg(err))}</div>`
      console.error(err)
    }
  }

  async function initOrphanBanner(): Promise<void> {
    const banner = document.getElementById('orphan-banner')
    if (!banner) return
    if (localStorage.getItem('orphan_banner_dismissed') === '1') return
    try {
      const connected = await ensureConnected()
      const pool = await fetchNotes(0, 300)
      const orphans = pool.filter(n => n.status !== 'archief' && !connected.has(n.id))
      if (orphans.length === 0) return
      const capped = pool.length === 300 ? '+' : ''
      banner.hidden = false
      banner.innerHTML = `
        <span>Je hebt <strong>${orphans.length}${capped}</strong> losse notities zonder enkele verbinding.</span>
        <button class="btn btn-ghost btn-sm" id="orphan-show">Toon</button>
        <button class="orphan-dismiss" id="orphan-dismiss" title="Verberg">✕</button>
      `
      document.getElementById('orphan-show')?.addEventListener('click', async () => {
        if (!orphanMode) orphanPill.click()
        banner.hidden = true
      })
      document.getElementById('orphan-dismiss')?.addEventListener('click', () => {
        localStorage.setItem('orphan_banner_dismissed', '1')
        banner.hidden = true
      })
    } catch { /* best-effort */ }
  }

  function visibleNotes(): Note[] {
    if (!searchText) return allNotes
    return allNotes.filter(n =>
      [n.content, n.ai_title, n.ai_summary, ...(n.tags ?? [])]
        .filter(Boolean)
        .some(t => (t as string).toLowerCase().includes(searchText))
    )
  }

  function renderList(): void {
    const notes = visibleNotes()
    if (notes.length === 0) {
      listEl.innerHTML = searchText
        ? '<div class="inbox-empty">Niets in de geladen lijst. Diep zoeken? Gebruik Zoek in de bovenbalk.</div>'
        : '<div class="inbox-empty">Geen notities gevonden.</div>'
      selectAllEl.checked = false
      return
    }
    listEl.innerHTML = notes.map(note => renderNoteRow(note, selected.has(note.id))).join('')
    attachRowListeners()
    selectAllEl.checked = notes.length > 0 && notes.every(n => selected.has(n.id))
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

        showUndoToast(`${ids.length} nota${ids.length === 1 ? '' : "'s"} verwijderd`,
          async () => {
            try { await bulkDelete(ids) } catch { showToast('Verwijderen mislukt.') }
          },
          () => {
            allNotes = [...removed, ...allNotes].sort(
              (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
            )
            renderList()
            updateBulkBar()
          })
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

      const header = row.querySelector<HTMLElement>('.row-header')
      header?.addEventListener('click', () => {
        const expanded = row.classList.toggle('expanded')
        row.querySelector('.row-detail')!.setAttribute('aria-hidden', String(!expanded))
        header.setAttribute('aria-expanded', String(expanded))
      })
      // role="button" promises Enter/Space activation
      header?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); header.click() }
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

        showUndoToast('Nota verwijderd',
          async () => {
            try { await deleteNote(id) } catch { showToast('Verwijderen mislukt.') }
          },
          () => {
            allNotes.splice(noteIdx, 0, note)
            renderList()
          })
      })
    })
  }

}

function renderNoteRow(note: Note, isSelected: boolean): string {
  const preview = note.ai_title ?? note.content.slice(0, 200)
  const date = formatRelative(note.created_at)
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
      padding-bottom: calc(var(--bottom-nav-h) + var(--s-4));
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
    .orphan-pill { border-style: dashed; }
    .orphan-banner {
      display: flex;
      align-items: center;
      gap: var(--s-2);
      flex-wrap: wrap;
      padding: var(--s-2) var(--s-3);
      background: var(--surface);
      border: 1px solid var(--accent);
      border-radius: var(--r-sm);
      font-size: var(--fs-sm);
      color: var(--text);
    }
    .orphan-banner .btn { width: auto; min-height: 32px; padding: var(--s-1) var(--s-3); }
    .orphan-dismiss {
      margin-left: auto;
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: var(--fs-base);
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
