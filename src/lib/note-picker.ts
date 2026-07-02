// Reusable multi-select note picker (modeled on link-modal.ts).
//
// Used wherever a set of notes gets attached to a container (book project,
// chapter section, …): search rows, tick checkboxes, optionally let the
// semantic layer pre-check its best matches via "Stel voor op betekenis"
// (embed the seed text with the free edge model + match_notes). Selection
// survives searching — ticked notes stay ticked while the list changes.

import { fetchNotes, fetchNotesByIds, getNoteTitle, type Note } from './notes'
import { embedText, matchNotes, hasEmbeddings } from './semantic'
import { showToast, esc, errMsg } from './crud-list'

export interface NotePickerOptions {
  title: string
  /** Text that seeds the semantic suggestions (e.g. a project's kernvraag). */
  seedText?: string
  /** Note ids to keep out of the list (already attached). */
  excludeIds?: string[]
  confirmLabel?: string
  /** Called with the chosen ids; the modal closes after it resolves. */
  onConfirm: (noteIds: string[]) => Promise<void> | void
}

export function openNotePicker(opts: NotePickerOptions): void {
  injectNotePickerStyles()

  const exclude = new Set(opts.excludeIds ?? [])
  const selected = new Map<string, string>() // id -> label
  let listed: Note[] = []

  const scrim = document.createElement('div')
  scrim.className = 'note-picker-scrim'
  scrim.innerHTML = `
    <div class="note-picker" role="dialog" aria-modal="true" aria-label="${esc(opts.title)}">
      <h3 class="note-picker-title">${esc(opts.title)}</h3>
      <div class="note-picker-tools">
        <input type="text" id="note-picker-search" placeholder="Zoek nota's…" autocomplete="off" />
        ${opts.seedText ? '<button type="button" class="btn btn-ghost" id="note-picker-suggest">Stel voor op betekenis</button>' : ''}
      </div>
      <div class="note-picker-list" id="note-picker-list"><span class="muted">Laden…</span></div>
      <div class="note-picker-actions">
        <span class="muted" id="note-picker-count">0 geselecteerd</span>
        <button class="btn btn-primary" id="note-picker-confirm" disabled>${esc(opts.confirmLabel ?? 'Koppel')}</button>
        <button class="btn btn-ghost" id="note-picker-cancel">Annuleren</button>
      </div>
    </div>
  `
  document.body.appendChild(scrim)

  const listEl = scrim.querySelector<HTMLDivElement>('#note-picker-list')!
  const countEl = scrim.querySelector<HTMLElement>('#note-picker-count')!
  const confirmBtn = scrim.querySelector<HTMLButtonElement>('#note-picker-confirm')!
  const searchEl = scrim.querySelector<HTMLInputElement>('#note-picker-search')!

  const close = () => {
    document.removeEventListener('keydown', onKey)
    scrim.remove()
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close() })
  scrim.querySelector('#note-picker-cancel')?.addEventListener('click', close)

  function updateCount(): void {
    countEl.textContent = `${selected.size} geselecteerd`
    confirmBtn.disabled = selected.size === 0
  }

  function renderList(): void {
    if (listed.length === 0 && selected.size === 0) {
      listEl.innerHTML = '<span class="muted">Geen nota\'s gevonden.</span>'
      return
    }
    // Selected-but-not-listed notes stay visible on top so unticking is
    // always possible, whatever the current search shows.
    const listedIds = new Set(listed.map(n => n.id))
    const pinned = [...selected.entries()].filter(([id]) => !listedIds.has(id))
    listEl.innerHTML = [
      ...pinned.map(([id, label]) => rowHtml(id, label, true)),
      ...listed.map(n => rowHtml(n.id, getNoteTitle(n, 90), selected.has(n.id), n.status))
    ].join('')
    listEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = cb.dataset['id']!
        if (cb.checked) selected.set(id, cb.dataset['label'] ?? id)
        else selected.delete(id)
        updateCount()
      })
    })
  }

  function rowHtml(id: string, label: string, checked: boolean, status?: string): string {
    return `
      <label class="note-picker-row">
        <input type="checkbox" data-id="${id}" data-label="${esc(label)}" ${checked ? 'checked' : ''} />
        <span class="note-picker-label">${esc(label)}</span>
        ${status ? `<span class="badge badge-${status}">${esc(status)}</span>` : ''}
      </label>`
  }

  async function load(query?: string): Promise<void> {
    try {
      const notes = await fetchNotes(0, 30, undefined, query)
      listed = notes.filter(n => !exclude.has(n.id))
      renderList()
    } catch (err) {
      listEl.innerHTML = `<span class="muted">Laden mislukt: ${esc(errMsg(err))}</span>`
    }
  }

  let debounce: ReturnType<typeof setTimeout> | null = null
  searchEl.addEventListener('input', () => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => load(searchEl.value.trim() || undefined), 220)
  })

  scrim.querySelector('#note-picker-suggest')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement
    btn.disabled = true
    btn.textContent = 'Zoeken op betekenis…'
    try {
      if (!(await hasEmbeddings())) {
        showToast('Nog geen semantische index — activeer embeddings via Instellingen')
        return
      }
      const vec = await embedText(opts.seedText!)
      const hits = (await matchNotes(vec, 12)).filter(h => h.similarity >= 0.45 && !exclude.has(h.id))
      if (hits.length === 0) { showToast('Geen passende nota\'s gevonden'); return }
      const notes = await fetchNotesByIds(hits.map(h => h.id))
      const order = new Map(hits.map((h, i) => [h.id, i]))
      notes.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99))
      // Pre-check the suggestions; the user still reviews before confirming.
      notes.forEach(n => selected.set(n.id, getNoteTitle(n, 90)))
      listed = notes
      renderList()
      updateCount()
    } catch (err) {
      showToast(`Voorstellen mislukt: ${errMsg(err)}`)
    } finally {
      btn.disabled = false
      btn.textContent = 'Stel voor op betekenis'
    }
  })

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true
    try {
      await opts.onConfirm([...selected.keys()])
      close()
    } catch (err) {
      confirmBtn.disabled = false
      showToast(`Koppelen mislukt: ${errMsg(err)}`)
    }
  })

  void load()
  searchEl.focus()
}

function injectNotePickerStyles(): void {
  if (document.getElementById('note-picker-styles')) return
  const style = document.createElement('style')
  style.id = 'note-picker-styles'
  style.textContent = `
    .note-picker-scrim {
      position: fixed; inset: 0; z-index: 200;
      background: rgba(0,0,0,0.45);
      display: flex; align-items: center; justify-content: center;
      padding: var(--s-4);
    }
    .note-picker {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-4);
      width: 100%; max-width: 520px;
      display: flex; flex-direction: column; gap: var(--s-3);
      max-height: 90vh;
    }
    .note-picker-title { font-size: var(--fs-lg); font-weight: 600; }
    .note-picker-tools { display: flex; gap: var(--s-2); flex-wrap: wrap; }
    .note-picker-tools input { flex: 1; min-width: 180px; }
    .note-picker-tools .btn { width: auto; }
    .note-picker-list {
      display: flex; flex-direction: column; gap: 2px;
      overflow-y: auto; min-height: 120px; max-height: 46vh;
    }
    .note-picker-row {
      display: flex; align-items: center; gap: var(--s-2);
      background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-sm);
      padding: var(--s-1) var(--s-2); font-size: var(--fs-sm); cursor: pointer;
    }
    .note-picker-row:hover { border-color: var(--accent); }
    .note-picker-label { flex: 1; }
    .note-picker-actions { display: flex; gap: var(--s-2); align-items: center; }
    .note-picker-actions .btn { width: auto; }
    .note-picker-actions .muted { flex: 1; }
  `
  document.head.appendChild(style)
}
