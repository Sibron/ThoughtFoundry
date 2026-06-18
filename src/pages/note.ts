import {
  fetchNoteById,
  fetchNotes,
  fetchNotesByIds,
  updateNote,
  deleteNote,
  type Note,
  type NoteStatus,
  type NoteType,
  type NoteUpdate
} from '../lib/notes'
import { NOTE_TYPES, NOTE_TYPE_ORDER } from '../lib/noteTypes'
import {
  fetchThemes,
  fetchThemesForNote,
  setThemesForNote,
  type Theme
} from '../lib/themes'
import {
  fetchLinksForNote,
  createLink,
  updateLink,
  deleteLink,
  LINK_TYPE_LABELS,
  type LinkType,
  type NoteLink
} from '../lib/links'
import { fetchSources, type Source } from '../lib/sources'
import { SECTIONS } from '../lib/sections'
import { processNote } from '../lib/ai'
import { renderTopbar, attachTopbar, isAiEnabled } from '../lib/nav'
import { navigateTo } from '../router'

const STATUS_LABELS: Record<NoteStatus, string> = {
  inbox: 'Inbox',
  verwerkt: 'Verwerkt',
  archief: 'Archief'
}

export async function renderNoteDetail(app: HTMLElement): Promise<void> {
  const id: string = noteIdFromHash() ?? ''
  if (!id) { navigateTo('/inbox'); return }

  app.innerHTML = `
    ${renderTopbar('Nota bewerken', 'inbox')}
    <div class="note-body"><div class="note-loading">Laden…</div></div>
    <div class="toast" id="toast"></div>
  `
  injectNoteStyles()
  attachTopbar()

  let note: Note | null = null
  let themes: Theme[] = []
  let noteThemeIds: string[] = []
  let links: NoteLink[] = []
  let sources: Source[] = []
  let allNotes: Note[] = []

  try {
    [note, themes, noteThemeIds, links, sources] = await Promise.all([
      fetchNoteById(id),
      fetchThemes(),
      fetchThemesForNote(id),
      fetchLinksForNote(id),
      fetchSources()
    ])
  } catch (err) {
    document.querySelector('.note-body')!.innerHTML =
      `<div class="note-error">Laden mislukt: ${escHtml(errMsg(err))}</div>`
    return
  }

  if (!note) {
    document.querySelector('.note-body')!.innerHTML =
      `<div class="note-error">Nota niet gevonden. <button class="btn-inline" id="back-inbox">Naar inbox</button></div>`
    document.getElementById('back-inbox')?.addEventListener('click', () => navigateTo('/inbox'))
    return
  }
  const current = note

  // Labels for linked notes (the "other side" of each link).
  const linkedIds = Array.from(new Set(links.flatMap(l => [l.source_id, l.target_id]))).filter(x => x !== id)
  const labelMap = new Map<string, string>()
  if (linkedIds.length) {
    try {
      const linked = await fetchNotesByIds(linkedIds)
      linked.forEach(n => labelMap.set(n.id, n.ai_title ?? n.content.slice(0, 60)))
    } catch { /* best-effort */ }
  }

  // Notes for the link-search picker (loaded lazily on first use).
  let allNotesLoaded = false
  let tagsState: string[] = [...(current.tags ?? [])]
  let linkTargetId: string | null = null

  renderForm()

  function renderForm(): void {
    const body = document.querySelector('.note-body') as HTMLElement
    const typeOptions = NOTE_TYPE_ORDER.map(t =>
      `<option value="${t}"${current.note_type === t ? ' selected' : ''}>${escHtml(NOTE_TYPES[t].label)}</option>`
    ).join('')
    const statusOptions = (Object.keys(STATUS_LABELS) as NoteStatus[]).map(s =>
      `<option value="${s}"${current.status === s ? ' selected' : ''}>${STATUS_LABELS[s]}</option>`
    ).join('')
    const sectionOptions = SECTIONS.map(sec =>
      `<option value="${sec.slug}"${current.section === sec.slug ? ' selected' : ''}>${escHtml(sec.label)}</option>`
    ).join('')
    const sourceOptions = sources.map(s =>
      `<option value="${s.id}"${current.source_id === s.id ? ' selected' : ''}>${escHtml(s.title)}${s.author ? ' — ' + escHtml(s.author) : ''}</option>`
    ).join('')
    const themeChecks = themes.length
      ? themes.map(t =>
          `<label class="chip-check"><input type="checkbox" class="theme-check" value="${t.id}" ${noteThemeIds.includes(t.id) ? 'checked' : ''}/> ${escHtml(t.name)}</label>`
        ).join('')
      : '<span class="muted">Nog geen thema\'s. Maak ze aan via Thema\'s.</span>'

    body.innerHTML = `
      <article class="note-card">
        <header class="note-head">
          <h1 class="note-h1">Nota</h1>
          <span class="muted">Aangemaakt ${formatDate(current.created_at)}${current.processed_at ? ` · verwerkt ${formatDate(current.processed_at)}` : ''}</span>
        </header>

        <div class="note-row note-row-2">
          <label class="field">
            <span class="field-label">Type</span>
            <select id="f-type">${typeOptions}</select>
          </label>
          <label class="field">
            <span class="field-label">Status</span>
            <select id="f-status">${statusOptions}</select>
          </label>
        </div>

        <label class="field">
          <span class="field-label">Titel</span>
          <input type="text" id="f-title" value="${escHtml(current.ai_title ?? '')}" placeholder="Korte kop…" />
        </label>

        <label class="field">
          <span class="field-label">Kernidee</span>
          <textarea id="f-core" rows="2" placeholder="De essentie in één zin…">${escHtml(current.core_idea ?? '')}</textarea>
        </label>

        <label class="field">
          <span class="field-label">Gebruik voor</span>
          <input type="text" id="f-usefor" value="${escHtml(current.use_for ?? '')}" placeholder="Waarvoor wil je dit gebruiken?" />
        </label>

        <label class="field">
          <span class="field-label">Uitwerking</span>
          <textarea id="f-content" rows="6">${escHtml(current.content)}</textarea>
        </label>

        <label class="field">
          <span class="field-label">Samenvatting</span>
          <textarea id="f-summary" rows="3" placeholder="1-2 zinnen kerngedachte…">${escHtml(current.ai_summary ?? '')}</textarea>
        </label>

        <label class="field">
          <span class="field-label">Extra notitie</span>
          <textarea id="f-mini" rows="2">${escHtml(current.mini_notes ?? '')}</textarea>
        </label>

        <fieldset class="field">
          <legend class="field-label">Tags</legend>
          <div class="tag-editor" id="tag-editor"></div>
          <input type="text" id="tag-input" class="tag-input" placeholder="Typ een tag en druk Enter…" />
        </fieldset>

        <label class="field">
          <span class="field-label">Hoofdstuk-sectie</span>
          <select id="f-section">
            <option value=""${!current.section ? ' selected' : ''}>(geen)</option>
            ${sectionOptions}
          </select>
        </label>

        <fieldset class="field">
          <legend class="field-label">Thema's</legend>
          <div class="chip-group">${themeChecks}</div>
        </fieldset>

        <fieldset class="field">
          <legend class="field-label">Bron</legend>
          <select id="f-source">
            <option value=""${!current.source_id ? ' selected' : ''}>— Geen gekoppelde bron —</option>
            ${sourceOptions}
          </select>
          <input type="text" id="f-source-url" value="${escHtml(current.source_url ?? '')}" placeholder="URL (losse bronverwijzing)" />
          <input type="text" id="f-source-title" value="${escHtml(current.source_title ?? '')}" placeholder="Titel" />
          <input type="text" id="f-source-author" value="${escHtml(current.source_author ?? '')}" placeholder="Auteur" />
        </fieldset>

        <fieldset class="field">
          <legend class="field-label">Links (Zettelkasten)</legend>
          <div class="link-list" id="link-list"></div>
          <div class="link-add">
            <input type="text" id="link-search" class="link-search" placeholder="Zoek nota om te koppelen…" autocomplete="off" />
            <div class="link-suggestions" id="link-suggestions"></div>
            <div class="link-add-row" id="link-add-row" hidden>
              <span class="link-target-label" id="link-target-label"></span>
              <select id="link-add-type">
                ${Object.entries(LINK_TYPE_LABELS).map(([k, v]) => `<option value="${k}">${escHtml(v)}</option>`).join('')}
              </select>
              <button class="btn btn-ghost btn-sm" id="link-add-btn">Koppel</button>
            </div>
          </div>
        </fieldset>

        ${isAiEnabled() ? `
        <div class="note-ai">
          <button class="btn btn-ghost btn-sm" id="ai-prefill">AI-suggesties ophalen</button>
          <span class="muted">Vult titel, samenvatting, tags en sectie voor. Niets wordt opgeslagen tot je opslaat.</span>
        </div>` : ''}

        <div class="note-actions">
          <button class="btn btn-primary" id="save-btn">Opslaan</button>
          <button class="btn btn-ghost" id="mark-processed">Markeer als verwerkt</button>
          <button class="btn btn-ghost" id="back-btn">Terug</button>
          <button class="btn btn-danger" id="delete-btn">Verwijderen</button>
        </div>
      </article>
    `

    renderTagChips()
    renderLinkList()
    wireTagInput()
    wireLinkSearch()
    wireActions()
  }

  // ── Tags ──────────────────────────────────────────────────────────────────
  function renderTagChips(): void {
    const el = document.getElementById('tag-editor')!
    if (tagsState.length === 0) { el.innerHTML = '<span class="muted">Nog geen tags</span>'; return }
    el.innerHTML = tagsState.map((t, i) =>
      `<span class="tag-chip">${escHtml(t)} <button class="tag-remove" data-idx="${i}" title="Verwijder">✕</button></span>`
    ).join('')
    el.querySelectorAll<HTMLButtonElement>('.tag-remove').forEach(b => {
      b.addEventListener('click', () => {
        tagsState.splice(Number(b.dataset['idx']), 1)
        renderTagChips()
      })
    })
  }

  function wireTagInput(): void {
    const input = document.getElementById('tag-input') as HTMLInputElement
    const commit = () => {
      const raw = input.value.trim().toLowerCase().replace(/,$/, '').trim()
      if (raw && !tagsState.includes(raw)) {
        tagsState.push(raw)
        renderTagChips()
      }
      input.value = ''
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit() }
    })
    input.addEventListener('blur', commit)
  }

  // ── Links ───────────────────────────────────────────────────────────────--
  function renderLinkList(): void {
    const el = document.getElementById('link-list')!
    if (links.length === 0) { el.innerHTML = '<span class="muted">Nog geen links</span>'; return }
    el.innerHTML = links.map(l => {
      const otherId = l.source_id === id ? l.target_id : l.source_id
      const dir = l.source_id === id ? '→' : '←'
      const label = labelMap.get(otherId) ?? otherId
      const typeOpts = Object.entries(LINK_TYPE_LABELS).map(([k, v]) =>
        `<option value="${k}"${k === l.type ? ' selected' : ''}>${escHtml(v)}</option>`
      ).join('')
      return `
        <div class="link-row" data-link-id="${l.id}">
          <span class="link-dir">${dir}</span>
          <span class="link-label">${escHtml(label)}</span>
          <select class="link-type" data-link-id="${l.id}"${l.source_id === id ? '' : ' disabled title="Richting wordt vanaf de bron-nota bepaald"'}>${typeOpts}</select>
          <button class="link-del btn-ghost btn-sm" data-link-id="${l.id}" title="Verwijder link">✕</button>
        </div>`
    }).join('')

    el.querySelectorAll<HTMLSelectElement>('.link-type:not([disabled])').forEach(sel => {
      sel.addEventListener('change', async () => {
        const linkId = sel.dataset['linkId']!
        try {
          await updateLink(linkId, { type: sel.value as LinkType })
          const l = links.find(x => x.id === linkId)
          if (l) l.type = sel.value as LinkType
          showToast('Link bijgewerkt')
        } catch (err) { showToast(`Mislukt: ${errMsg(err)}`) }
      })
    })
    el.querySelectorAll<HTMLButtonElement>('.link-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const linkId = btn.dataset['linkId']!
        try {
          await deleteLink(linkId)
          links = links.filter(x => x.id !== linkId)
          renderLinkList()
          showToast('Link verwijderd')
        } catch (err) { showToast(`Mislukt: ${errMsg(err)}`) }
      })
    })
  }

  function wireLinkSearch(): void {
    const search = document.getElementById('link-search') as HTMLInputElement
    const sugg = document.getElementById('link-suggestions')!
    const addRow = document.getElementById('link-add-row') as HTMLDivElement
    const targetLabel = document.getElementById('link-target-label')!
    let debounce: ReturnType<typeof setTimeout> | null = null

    const ensureNotes = async () => {
      if (allNotesLoaded) return
      try { allNotes = await fetchNotes(0, 200) } catch { allNotes = [] }
      allNotesLoaded = true
    }

    search.addEventListener('input', () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(async () => {
        const q = search.value.trim().toLowerCase()
        if (!q) { sugg.innerHTML = ''; return }
        await ensureNotes()
        const linkedSet = new Set(links.flatMap(l => [l.source_id, l.target_id]))
        const matches = allNotes
          .filter(n => n.id !== id && !linkedSet.has(n.id) &&
            ((n.ai_title ?? '') + ' ' + n.content).toLowerCase().includes(q))
          .slice(0, 6)
        sugg.innerHTML = matches.length
          ? matches.map(n => `<button class="link-suggestion" data-id="${n.id}">${escHtml((n.ai_title ?? n.content).slice(0, 80))}</button>`).join('')
          : '<span class="muted">Geen resultaten</span>'
        sugg.querySelectorAll<HTMLButtonElement>('.link-suggestion').forEach(b => {
          b.addEventListener('click', () => {
            linkTargetId = b.dataset['id']!
            targetLabel.textContent = b.textContent
            addRow.hidden = false
            sugg.innerHTML = ''
            search.value = ''
          })
        })
      }, 200)
    })

    document.getElementById('link-add-btn')?.addEventListener('click', async () => {
      const targetId = linkTargetId
      if (!targetId) return
      const type = (document.getElementById('link-add-type') as HTMLSelectElement).value as LinkType
      try {
        const link = await createLink({ sourceId: id, targetId, type })
        links.push(link)
        if (!labelMap.has(targetId)) labelMap.set(targetId, targetLabel.textContent ?? targetId)
        linkTargetId = null
        addRow.hidden = true
        renderLinkList()
        showToast('Gekoppeld')
      } catch (err) { showToast(`Mislukt: ${errMsg(err)}`) }
    })
  }

  // ── Actions ─────────────────────────────────────────────────────────────--
  function collectUpdate(): NoteUpdate {
    const val = (sel: string) => (document.getElementById(sel) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value
    return {
      note_type: val('f-type') as NoteType,
      status: val('f-status') as NoteStatus,
      ai_title: val('f-title').trim() || null,
      core_idea: val('f-core').trim() || null,
      use_for: val('f-usefor').trim() || null,
      content: val('f-content').trim(),
      ai_summary: val('f-summary').trim() || null,
      mini_notes: val('f-mini').trim() || null,
      tags: tagsState,
      section: val('f-section') || null,
      source_id: val('f-source') || null,
      source_url: val('f-source-url').trim() || null,
      source_title: val('f-source-title').trim() || null,
      source_author: val('f-source-author').trim() || null
    }
  }

  async function save(extra?: Partial<NoteUpdate>): Promise<boolean> {
    const updates = { ...collectUpdate(), ...extra }
    if (!updates.content) { showToast('Uitwerking mag niet leeg zijn.'); return false }
    const themeIds = Array.from(document.querySelectorAll<HTMLInputElement>('.theme-check:checked')).map(c => c.value)
    try {
      const saved = await updateNote(id, updates)
      Object.assign(current, saved)
      tagsState = [...(current.tags ?? [])]
      await setThemesForNote(id, themeIds)
      noteThemeIds = themeIds
      return true
    } catch (err) {
      showToast(`Opslaan mislukt: ${errMsg(err)}`)
      return false
    }
  }

  function wireActions(): void {
    document.getElementById('save-btn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget as HTMLButtonElement
      btn.disabled = true
      if (await save()) showToast('Opgeslagen')
      btn.disabled = false
    })

    document.getElementById('mark-processed')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget as HTMLButtonElement
      btn.disabled = true
      const extra: Partial<NoteUpdate> = { status: 'verwerkt' }
      if (!current.processed_at) extra.processed_at = new Date().toISOString()
      if (await save(extra)) { showToast('Gemarkeerd als verwerkt'); renderForm() }
      btn.disabled = false
    })

    document.getElementById('back-btn')?.addEventListener('click', () => navigateTo('/inbox'))

    document.getElementById('delete-btn')?.addEventListener('click', async () => {
      if (!confirm('Deze nota definitief verwijderen?')) return
      try { await deleteNote(id); navigateTo('/inbox') }
      catch (err) { showToast(`Verwijderen mislukt: ${errMsg(err)}`) }
    })

    document.getElementById('ai-prefill')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget as HTMLButtonElement
      btn.disabled = true
      btn.textContent = 'Bezig…'
      try {
        const { suggestion } = await processNote(id)
        const set = (sel: string, v: string) => { (document.getElementById(sel) as HTMLInputElement | HTMLTextAreaElement).value = v }
        if (suggestion.title) set('f-title', suggestion.title)
        if (suggestion.summary) set('f-summary', suggestion.summary)
        if (suggestion.section) (document.getElementById('f-section') as HTMLSelectElement).value = suggestion.section
        for (const tag of suggestion.tags ?? []) {
          if (!tagsState.includes(tag)) tagsState.push(tag)
        }
        renderTagChips()
        // Pre-check matched existing themes (don't auto-create new ones here).
        suggestion.matched_theme_ids?.forEach(tid => {
          const cb = document.querySelector<HTMLInputElement>(`.theme-check[value="${tid}"]`)
          if (cb) cb.checked = true
        })
        showToast('Suggesties ingevuld — controleer en sla op')
      } catch (err) {
        showToast(`AI mislukt: ${errMsg(err)}`)
      } finally {
        btn.disabled = false
        btn.textContent = 'AI-suggesties ophalen'
      }
    })
  }
}

function noteIdFromHash(): string | null {
  const hash = window.location.hash.slice(1)
  const qIndex = hash.indexOf('?')
  if (qIndex === -1) return null
  return new URLSearchParams(hash.slice(qIndex + 1)).get('id')
}

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'onbekende fout'
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' })
}

function showToast(msg: string): void {
  const toast = document.getElementById('toast') as HTMLDivElement | null
  if (!toast) return
  toast.textContent = msg
  toast.classList.add('show')
  setTimeout(() => toast.classList.remove('show'), 2500)
}

function injectNoteStyles(): void {
  if (document.getElementById('note-styles')) return
  const style = document.createElement('style')
  style.id = 'note-styles'
  style.textContent = `
    .note-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      padding: var(--s-4);
      max-width: 760px;
      width: 100%;
      margin: 0 auto;
    }
    .note-loading, .note-error { color: var(--text-muted); text-align: center; padding: var(--s-7) 0; }
    .note-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-4);
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
    }
    .note-head { display: flex; flex-direction: column; gap: 2px; }
    .note-h1 { font-size: var(--fs-lg); font-weight: 600; }
    .note-row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-3); }
    .field { display: flex; flex-direction: column; gap: var(--s-1); border: none; padding: 0; margin: 0; }
    .field-label { font-size: var(--fs-sm); color: var(--text-muted); font-weight: 500; }
    .field textarea, .field input, .field select { width: 100%; }
    fieldset.field { display: flex; flex-direction: column; gap: var(--s-2); }
    .chip-group { display: flex; flex-wrap: wrap; gap: var(--s-2); }
    .chip-check {
      display: inline-flex; align-items: center; gap: var(--s-1);
      padding: 4px var(--s-3); border-radius: var(--r-sm);
      background: var(--bg); border: 1px solid var(--border);
      font-size: var(--fs-sm); cursor: pointer;
    }
    .tag-editor { display: flex; flex-wrap: wrap; gap: var(--s-1); min-height: 1.4rem; }
    .tag-chip {
      display: inline-flex; align-items: center; gap: 4px;
      background: var(--accent); color: #fff;
      border-radius: var(--r-sm); padding: 2px var(--s-2); font-size: var(--fs-sm);
    }
    .tag-remove { background: none; border: none; color: inherit; cursor: pointer; padding: 0; font-size: 12px; }
    .tag-input { font-size: var(--fs-sm); }
    .link-list { display: flex; flex-direction: column; gap: var(--s-1); }
    .link-row { display: flex; align-items: center; gap: var(--s-2); flex-wrap: wrap; }
    .link-dir { color: var(--text-muted); font-weight: 600; }
    .link-label { flex: 1; min-width: 0; font-size: var(--fs-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .link-type { width: auto; font-size: var(--fs-sm); }
    .link-del { background: none; border: 1px solid var(--border); border-radius: var(--r-sm); cursor: pointer; color: var(--danger); padding: 2px 8px; }
    .link-add { display: flex; flex-direction: column; gap: var(--s-1); margin-top: var(--s-1); }
    .link-search { font-size: var(--fs-sm); }
    .link-suggestions { display: flex; flex-direction: column; gap: 2px; }
    .link-suggestion {
      background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-sm);
      padding: var(--s-1) var(--s-2); font-size: var(--fs-sm); cursor: pointer; text-align: left;
    }
    .link-suggestion:hover { background: var(--surface); }
    .link-add-row { display: flex; align-items: center; gap: var(--s-2); flex-wrap: wrap; }
    .link-target-label { flex: 1; min-width: 0; font-size: var(--fs-sm); font-weight: 500; }
    .note-ai { display: flex; align-items: center; gap: var(--s-2); flex-wrap: wrap; }
    .note-ai .btn { width: auto; }
    .note-actions { display: flex; gap: var(--s-2); flex-wrap: wrap; margin-top: var(--s-2); }
    .note-actions .btn { width: auto; }
    .btn-sm { min-height: unset; font-size: var(--fs-sm); padding: var(--s-1) var(--s-3); }
    .muted { color: var(--text-muted); font-size: var(--fs-sm); }
    .btn-inline { background: none; border: 1px solid currentColor; border-radius: var(--r-sm); padding: 2px var(--s-2); cursor: pointer; color: var(--accent); }
    @media (max-width: 600px) { .note-row-2 { grid-template-columns: 1fr; } }
  `
  document.head.appendChild(style)
}
