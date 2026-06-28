// Shared note-link workflow.
//
// Linking two notes happens in two places — the note detail editor (manually
// search for a note to link) and Capture's "Verbind twee" (link a surfaced
// surprising pair). Both boil down to the same decision: pick a target, choose
// one of the six relation types, optionally say why. This modal is that single
// workflow, so the two entry points stay in sync.

import { createLink, LINK_TYPE_LABELS, type LinkType, type NoteLink } from './links'
import { fetchNotes, getNoteTitle, type Note } from './notes'
import { showToast, esc } from './crud-list'

export interface LinkModalOptions {
  sourceId: string
  sourceLabel: string
  /** Pre-chosen target. When set, the search picker is hidden. */
  target?: { id: string; label: string }
  /** Note ids to keep out of the search results (self + already-linked). */
  excludeIds?: string[]
  defaultType?: LinkType
  defaultReason?: string
  /** Called after the link is created. `targetLabel` lets the caller update its own label cache. */
  onLinked: (link: NoteLink, targetLabel: string) => void
}

export function openLinkModal(opts: LinkModalOptions): void {
  injectLinkModalStyles()

  const exclude = new Set([opts.sourceId, ...(opts.excludeIds ?? [])])
  let chosenId: string | null = opts.target?.id ?? null
  let chosenLabel = opts.target?.label ?? ''

  const typeOptions = Object.entries(LINK_TYPE_LABELS)
    .map(([k, v]) => `<option value="${k}"${k === (opts.defaultType ?? 'related') ? ' selected' : ''}>${esc(v)}</option>`)
    .join('')

  const scrim = document.createElement('div')
  scrim.className = 'link-modal-scrim'
  scrim.innerHTML = `
    <div class="link-modal" role="dialog" aria-modal="true" aria-label="Nota koppelen">
      <h3 class="link-modal-title">Nota koppelen</h3>
      <div class="link-modal-note"><span class="link-modal-lbl">Van</span><span>${esc(opts.sourceLabel)}</span></div>
      ${opts.target
        ? `<div class="link-modal-note"><span class="link-modal-lbl">Naar</span><span>${esc(opts.target.label)}</span></div>`
        : `<div class="link-modal-field">
             <span class="link-modal-lbl">Naar</span>
             <div class="link-modal-chosen" id="link-modal-chosen" hidden></div>
             <input type="text" id="link-modal-search" class="link-modal-search" placeholder="Zoek nota om te koppelen…" autocomplete="off" />
             <div class="link-modal-results" id="link-modal-results"></div>
           </div>`
      }
      <label class="link-modal-field">
        <span class="link-modal-lbl">Relatie</span>
        <select id="link-modal-type">${typeOptions}</select>
      </label>
      <label class="link-modal-field">
        <span class="link-modal-lbl">Reden (optioneel)</span>
        <input type="text" id="link-modal-reason" value="${esc(opts.defaultReason ?? '')}" />
      </label>
      <div class="link-modal-actions">
        <button class="btn btn-primary" id="link-modal-confirm"${chosenId ? '' : ' disabled'}>Koppel</button>
        <button class="btn btn-ghost" id="link-modal-cancel">Annuleren</button>
      </div>
    </div>
  `
  document.body.appendChild(scrim)

  const confirmBtn = scrim.querySelector<HTMLButtonElement>('#link-modal-confirm')!

  const close = () => {
    document.removeEventListener('keydown', onKey)
    scrim.remove()
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close() })
  scrim.querySelector('#link-modal-cancel')?.addEventListener('click', close)

  // Target search (only when no preset target).
  if (!opts.target) {
    const search = scrim.querySelector<HTMLInputElement>('#link-modal-search')!
    const results = scrim.querySelector<HTMLDivElement>('#link-modal-results')!
    const chosenBox = scrim.querySelector<HTMLDivElement>('#link-modal-chosen')!
    let debounce: ReturnType<typeof setTimeout> | null = null

    search.addEventListener('input', () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(async () => {
        const q = search.value.trim()
        if (!q) { results.innerHTML = ''; return }
        let found: Note[] = []
        try { found = await fetchNotes(0, 20, undefined, q) } catch { found = [] }
        const matches = found.filter(n => !exclude.has(n.id)).slice(0, 6)
        results.innerHTML = matches.length
          ? matches.map(n => `<button type="button" class="link-modal-result" data-id="${n.id}">${esc(getNoteTitle(n, 80))}</button>`).join('')
          : '<span class="muted">Geen resultaten</span>'
        results.querySelectorAll<HTMLButtonElement>('.link-modal-result').forEach(b => {
          b.addEventListener('click', () => {
            chosenId = b.dataset['id']!
            chosenLabel = b.textContent ?? ''
            chosenBox.hidden = false
            chosenBox.textContent = `Gekozen: ${chosenLabel}`
            results.innerHTML = ''
            search.value = ''
            confirmBtn.disabled = false
          })
        })
      }, 200)
    })
    search.focus()
  }

  confirmBtn.addEventListener('click', async () => {
    if (!chosenId) return
    confirmBtn.disabled = true
    const type = (scrim.querySelector('#link-modal-type') as HTMLSelectElement).value as LinkType
    const reason = (scrim.querySelector('#link-modal-reason') as HTMLInputElement).value.trim()
    try {
      const link = await createLink({ sourceId: opts.sourceId, targetId: chosenId, type, reason: reason || undefined })
      close()
      opts.onLinked(link, chosenLabel)
    } catch (err) {
      confirmBtn.disabled = false
      showToast(`Koppelen mislukt: ${err instanceof Error ? err.message : 'onbekende fout'}`)
    }
  })
}

function injectLinkModalStyles(): void {
  if (document.getElementById('link-modal-styles')) return
  const style = document.createElement('style')
  style.id = 'link-modal-styles'
  style.textContent = `
    .link-modal-scrim {
      position: fixed; inset: 0; z-index: 200;
      background: rgba(0,0,0,0.45);
      display: flex; align-items: center; justify-content: center;
      padding: var(--s-4);
    }
    .link-modal {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-4);
      width: 100%; max-width: 440px;
      display: flex; flex-direction: column; gap: var(--s-3);
      max-height: 90vh; overflow-y: auto;
    }
    .link-modal-title { font-size: var(--fs-lg); font-weight: 600; }
    .link-modal-note { display: flex; gap: var(--s-2); align-items: baseline; font-size: var(--fs-sm); }
    .link-modal-field { display: flex; flex-direction: column; gap: var(--s-1); }
    .link-modal-lbl { font-size: var(--fs-sm); color: var(--text-muted); font-weight: 500; }
    .link-modal-search { width: 100%; }
    .link-modal-results { display: flex; flex-direction: column; gap: 2px; }
    .link-modal-result {
      background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-sm);
      padding: var(--s-1) var(--s-2); font-size: var(--fs-sm); cursor: pointer; text-align: left;
    }
    .link-modal-result:hover { background: var(--surface); border-color: var(--accent); }
    .link-modal-chosen { font-size: var(--fs-sm); color: var(--accent-hover); font-weight: 500; }
    .link-modal-actions { display: flex; gap: var(--s-2); margin-top: var(--s-1); }
    .link-modal-actions .btn { width: auto; }
  `
  document.head.appendChild(style)
}
