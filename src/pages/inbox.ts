import {
  fetchNotes,
  updateNote,
  deleteNote,
  type Note,
  type NoteUpdate
} from '../lib/notes'
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
        <button class="topbar-btn" id="logout-btn" title="Afmelden">&#x238B;</button>
      </div>
    </div>
    <div class="inbox-body">
      <div class="inbox-tabs">
        <button class="inbox-tab" data-status="" aria-current="true">Alle</button>
        <button class="inbox-tab" data-status="inbox">Inbox</button>
        <button class="inbox-tab" data-status="verwerkt">Verwerkt</button>
        <button class="inbox-tab" data-status="archief">Archief</button>
      </div>
      <input type="text" id="inbox-filter" placeholder="Zoeken…" class="inbox-filter" />
      <div id="inbox-list" class="inbox-list">
        <div class="inbox-loading">Laden…</div>
      </div>
      <button class="btn btn-ghost inbox-load-more" id="load-more" style="display:none">Meer laden</button>
    </div>
  `

  injectInboxStyles()

  document.getElementById('goto-capture')?.addEventListener('click', () => navigateTo('/capture'))
  document.getElementById('goto-process')?.addEventListener('click', () => navigateTo('/process'))
  document.getElementById('goto-graph')?.addEventListener('click', () => navigateTo('/graph'))
  document.getElementById('goto-book')?.addEventListener('click', () => navigateTo('/book'))
  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    await signOut()
    navigateTo('/login')
  })

  let page = 0
  let allNotes: Note[] = []
  let filterText = ''
  let statusFilter: 'inbox' | 'verwerkt' | 'archief' | undefined = undefined

  const listEl = document.getElementById('inbox-list') as HTMLDivElement
  const loadMoreBtn = document.getElementById('load-more') as HTMLButtonElement
  const filterInput = document.getElementById('inbox-filter') as HTMLInputElement

  document.querySelectorAll<HTMLButtonElement>('.inbox-tab').forEach(tab => {
    tab.addEventListener('click', async () => {
      document.querySelectorAll('.inbox-tab').forEach(t => t.removeAttribute('aria-current'))
      tab.setAttribute('aria-current', 'true')
      const v = tab.dataset['status']
      statusFilter = v ? (v as 'inbox' | 'verwerkt' | 'archief') : undefined
      page = 0
      allNotes = []
      await loadNotes()
    })
  })

  async function loadNotes(): Promise<void> {
    try {
      const notes = await fetchNotes(page, 50, statusFilter)
      allNotes = page === 0 ? notes : [...allNotes, ...notes]
      loadMoreBtn.style.display = notes.length === 50 ? 'flex' : 'none'
      renderList()
    } catch (err) {
      listEl.innerHTML = '<div class="inbox-error">Laden mislukt.</div>'
      console.error(err)
    }
  }

  function renderList(): void {
    const filtered = filterText
      ? allNotes.filter(n => n.content.toLowerCase().includes(filterText.toLowerCase()))
      : allNotes

    if (filtered.length === 0) {
      listEl.innerHTML = '<div class="inbox-empty">Geen notities gevonden.</div>'
      return
    }

    listEl.innerHTML = filtered.map(note => renderNoteRow(note)).join('')
    attachRowListeners()
  }

  filterInput.addEventListener('input', () => {
    filterText = filterInput.value
    renderList()
  })

  loadMoreBtn.addEventListener('click', async () => {
    page++
    await loadNotes()
  })

  await loadNotes()

  function attachRowListeners(): void {
    listEl.querySelectorAll<HTMLElement>('.inbox-row').forEach(row => {
      const id = row.dataset['id']!

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
          renderList()
        } catch {
          alert('Verwijderen mislukt.')
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
      if (miniEl) updates.mini_notes = miniEl.value.trim() || undefined
      updateNote(id, updates)
        .then(updated => {
          const idx = allNotes.findIndex(n => n.id === id)
          if (idx !== -1) allNotes[idx] = updated
          renderList()
        })
        .catch(() => alert('Opslaan mislukt.'))
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
          renderList()
        } catch {
          alert('Verwijderen mislukt.')
        }
      })
    }
  }
}

function renderNoteRow(note: Note): string {
  const preview = note.content.slice(0, 200)
  const date = relativeDate(note.created_at)
  const badgeClass = `badge badge-${note.status}`
  return `
    <div class="inbox-row" data-id="${note.id}">
      <div class="row-header" role="button" tabindex="0" aria-expanded="false">
        <div class="row-preview">${escHtml(preview)}${note.content.length > 200 ? '…' : ''}</div>
        <div class="row-meta">
          <span class="${badgeClass}">${escHtml(note.status)}</span>
          <span class="row-date">${date}</span>
        </div>
      </div>
      <div class="row-detail" aria-hidden="true">
        <div class="row-full-content">${escHtml(note.content)}</div>
        ${note.mini_notes ? `<div class="row-mini">${escHtml(note.mini_notes)}</div>` : ''}
        ${note.source_url ? `<a class="row-source" href="${escHtml(note.source_url)}" target="_blank" rel="noopener">${escHtml(note.source_title ?? note.source_url)}</a>` : ''}
        <div class="row-actions">
          <button class="btn btn-ghost row-edit-btn" style="width:auto;min-height:36px">Bewerken</button>
          <button class="btn btn-danger row-delete-btn" style="width:auto;min-height:36px">Verwijderen</button>
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
      max-width: 720px;
      width: 100%;
      margin: 0 auto;
    }
    .inbox-filter {
      flex-shrink: 0;
    }
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
    }
    .row-header {
      padding: var(--s-4);
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
  `
  document.head.appendChild(style)
}
