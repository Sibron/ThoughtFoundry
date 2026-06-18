import { insertNote, queueOfflineNote, flushOfflineQueue, offlineQueueSize, fetchNotes, fetchRandomNote, type NoteInsert, type Note } from '../lib/notes'
import { fetchSources, type Source } from '../lib/sources'
import { renderTopbar, attachTopbar } from '../lib/nav'
import { navigateTo } from '../router'

const DRAFT_KEY = 'capture_draft'

interface Draft {
  content?: string
  mini?: string
  useFor?: string
  sourceId?: string
  url?: string
  title?: string
  author?: string
}

export async function renderCapture(app: HTMLElement): Promise<void> {
  // Best-effort flush on render — the helper itself returns silently if offline.
  flushOfflineQueue().catch(() => { /* silent */ })

  // Load sources for the picker (non-blocking)
  let sources: Source[] = []
  if (navigator.onLine) {
    fetchSources().then(s => { sources = s }).catch(() => {})
  }

  app.innerHTML = `
    ${renderTopbar('ThoughtFoundry', 'capture', '<span class="online-indicator" id="online-indicator" title=""></span>')}
    <div class="capture-body">

      <textarea
        id="capture-content"
        class="capture-textarea"
        placeholder="Gooi het erin. Half is goed genoeg. Later wordt het iets."
      ></textarea>
      <p class="duplicate-hint" id="duplicate-hint"></p>

      <details class="capture-extra" id="meer-details">
        <summary class="capture-extra-toggle">Meer velden</summary>
        <div class="meer-fields">
          <input type="text" id="capture-use-for" class="capture-use-for" placeholder="Gebruik voor…" />

          <details class="capture-extra" id="extra-details">
            <summary class="capture-extra-toggle">+ Extra notitie</summary>
            <textarea
              id="capture-mini"
              class="capture-mini-textarea"
              placeholder="Aanvullende context…"
              rows="3"
            ></textarea>
          </details>

          <details class="capture-extra" id="bron-details">
            <summary class="capture-extra-toggle">+ Bron</summary>
            <div class="capture-bron-fields">
              <select id="capture-source-id" class="capture-source-select">
                <option value="">— Geen gekoppelde bron —</option>
              </select>
              <input type="text" id="capture-source-url" placeholder="URL (losse bronverwijzing)" />
              <input type="text" id="capture-source-title" placeholder="Titel" />
              <input type="text" id="capture-source-author" placeholder="Auteur" />
            </div>
          </details>
        </div>
      </details>

      <div class="capture-footer">
        <button class="btn btn-primary" id="save-btn" disabled>Opslaan</button>
        <button class="btn btn-ghost btn-sm" id="btn-random-note">Toon een oude nota</button>
      </div>

      <div class="capture-recent" id="capture-recent"></div>
    </div>

    <div id="random-note-panel" class="random-note-panel" hidden>
      <div class="random-note-card">
        <p class="random-note-content" id="random-note-content"></p>
        <div class="random-note-actions">
          <button class="btn btn-ghost btn-sm" id="btn-reroll">Nog eentje</button>
          <button class="btn btn-ghost btn-sm" id="btn-close-random">Sluiten</button>
        </div>
      </div>
    </div>

    <div class="toast" id="toast"></div>
  `

  injectCaptureStyles()
  attachTopbar()

  const textarea = document.getElementById('capture-content') as HTMLTextAreaElement
  const useForEl = document.getElementById('capture-use-for') as HTMLInputElement
  const miniTextarea = document.getElementById('capture-mini') as HTMLTextAreaElement
  const sourceIdEl = document.getElementById('capture-source-id') as HTMLSelectElement
  const sourceUrl = document.getElementById('capture-source-url') as HTMLInputElement
  const sourceTitle = document.getElementById('capture-source-title') as HTMLInputElement
  const sourceAuthor = document.getElementById('capture-source-author') as HTMLInputElement
  const saveBtn = document.getElementById('save-btn') as HTMLButtonElement
  const duplicateHint = document.getElementById('duplicate-hint') as HTMLParagraphElement
  const meerDetails = document.getElementById('meer-details') as HTMLDetailsElement

  // Restore an in-progress draft so a reload never loses a thought.
  restoreDraft({ textarea, useForEl, miniTextarea, sourceUrl, sourceTitle, sourceAuthor })

  saveBtn.disabled = textarea.value.trim() === ''

  // Open meer-details (and nested sections) if any optional field has saved content.
  const savedDraft = loadDraftObj()
  if (savedDraft.useFor?.trim() || savedDraft.mini?.trim() || savedDraft.url || savedDraft.title || savedDraft.author || savedDraft.sourceId) {
    meerDetails.open = true
    if (savedDraft.mini?.trim()) (document.getElementById('extra-details') as HTMLDetailsElement).open = true
    if (savedDraft.url || savedDraft.title || savedDraft.author) (document.getElementById('bron-details') as HTMLDetailsElement).open = true
  }

  // Populate source picker after it loads; restore sourceId from draft if present.
  const populateSources = () => {
    if (sources.length === 0) return
    const existing = Array.from(sourceIdEl.options).map(o => o.value)
    sources.forEach(s => {
      if (existing.includes(s.id)) return
      const opt = document.createElement('option')
      opt.value = s.id
      opt.textContent = `${s.title}${s.author ? ` — ${s.author}` : ''}`
      sourceIdEl.appendChild(opt)
    })
    const draft = loadDraftObj()
    if (draft.sourceId) sourceIdEl.value = draft.sourceId
  }
  setTimeout(populateSources, 800)

  // Load recent notes once for similarity checking (zero-cost, client-side only)
  let recentNotes: Note[] = []
  if (navigator.onLine) {
    fetchNotes(0, 50).then(notes => { recentNotes = notes }).catch(() => {})
  }

  const saveDraft = () => {
    const draft: Draft = {
      content: textarea.value,
      useFor: useForEl.value,
      mini: miniTextarea.value,
      sourceId: sourceIdEl.value || undefined,
      url: sourceUrl.value,
      title: sourceTitle.value,
      author: sourceAuthor.value
    }
    const empty = !draft.content?.trim() && !draft.mini?.trim() && !draft.url && !draft.title && !draft.author
    if (empty) localStorage.removeItem(DRAFT_KEY)
    else localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  }

  // Debounced duplicate hint check — no API calls, pure client-side word overlap
  let hintTimer: ReturnType<typeof setTimeout> | null = null
  const checkDuplicates = () => {
    if (hintTimer) clearTimeout(hintTimer)
    hintTimer = setTimeout(() => {
      const text = textarea.value.trim()
      if (text.length < 20 || recentNotes.length === 0) {
        duplicateHint.textContent = ''
        return
      }
      const match = findSimilarNote(text, recentNotes)
      if (match) {
        const preview = (match.ai_title ?? match.content).slice(0, 60)
        duplicateHint.textContent = `Lijkt op: "${preview}${preview.length === 60 ? '…' : ''}"`
      } else {
        duplicateHint.textContent = ''
      }
    }, 1000)
  }

  const onInput = () => {
    saveBtn.disabled = textarea.value.trim() === ''
    saveDraft()
    checkDuplicates()
  }
  textarea.addEventListener('input', onInput)
  ;[miniTextarea, sourceUrl, sourceTitle, sourceAuthor, useForEl].forEach(el => el.addEventListener('input', saveDraft))

  textarea.focus()

  textarea.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      if (!saveBtn.disabled) saveBtn.click()
    }
  })

  saveBtn.addEventListener('click', async () => {
    const content = textarea.value.trim()
    if (!content) return

    saveBtn.disabled = true

    const note: NoteInsert = { content, note_type: 'fleeting' }
    if (useForEl.value.trim())      note.use_for = useForEl.value.trim()
    if (miniTextarea.value.trim())  note.mini_notes = miniTextarea.value.trim()
    if (sourceIdEl.value)           note.source_id = sourceIdEl.value
    if (sourceUrl.value.trim())     note.source_url = sourceUrl.value.trim()
    if (sourceTitle.value.trim())   note.source_title = sourceTitle.value.trim()
    if (sourceAuthor.value.trim())  note.source_author = sourceAuthor.value.trim()

    try {
      if (navigator.onLine) {
        const saved = await insertNote(note)
        recentNotes = [saved, ...recentNotes].slice(0, 50)
      } else {
        await queueOfflineNote(note)
      }
      // Reset form
      textarea.value = ''
      useForEl.value = ''
      miniTextarea.value = ''
      sourceIdEl.value = ''
      sourceUrl.value = ''
      sourceTitle.value = ''
      sourceAuthor.value = ''
      duplicateHint.textContent = ''
      localStorage.removeItem(DRAFT_KEY)
      ;(document.getElementById('extra-details') as HTMLDetailsElement).open = false
      ;(document.getElementById('bron-details') as HTMLDetailsElement).open = false
      meerDetails.open = false
      showToast(navigator.onLine ? 'Opgeslagen' : 'Opgeslagen (offline wachtrij)')
      await refreshOnlineIndicator()
      await refreshRecent()
    } catch (err) {
      showToast('Opslaan mislukt. Probeer opnieuw.')
      console.error(err)
    } finally {
      saveBtn.disabled = textarea.value.trim() === ''
      textarea.focus()
    }
  })

  // Random note panel
  const panel = document.getElementById('random-note-panel') as HTMLDivElement
  const randomContent = document.getElementById('random-note-content') as HTMLParagraphElement

  const showRandomNote = async () => {
    const note = await fetchRandomNote().catch(() => null)
    if (!note) { showToast('Geen nota\'s gevonden'); return }
    randomContent.textContent = note.ai_title
      ? `${note.ai_title}\n\n${note.content.slice(0, 300)}${note.content.length > 300 ? '…' : ''}`
      : note.content.slice(0, 300) + (note.content.length > 300 ? '…' : '')
    panel.hidden = false
  }

  document.getElementById('btn-random-note')?.addEventListener('click', showRandomNote)
  document.getElementById('btn-reroll')?.addEventListener('click', showRandomNote)
  document.getElementById('btn-close-random')?.addEventListener('click', () => { panel.hidden = true })

  // Online/offline indicator + auto-flush on reconnect
  await refreshOnlineIndicator()
  await refreshRecent()

  const onOnline = async () => {
    const flushed = await flushOfflineQueue()
    if (flushed > 0) showToast(`${flushed} offline-nota('s) gesynchroniseerd`)
    recentNotes = await fetchNotes(0, 50).catch(() => recentNotes)
    await refreshOnlineIndicator()
    await refreshRecent()
  }
  const onOffline = () => refreshOnlineIndicator()
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
}

function loadDraftObj(): Draft {
  const raw = localStorage.getItem(DRAFT_KEY)
  if (!raw) return {}
  try { return JSON.parse(raw) as Draft } catch { return {} }
}

function findSimilarNote(input: string, notes: Note[]): Note | null {
  const inputWords = tokenize(input)
  if (inputWords.size === 0) return null

  let bestNote: Note | null = null
  let bestScore = 0

  for (const note of notes) {
    const noteWords = tokenize(note.ai_title ? note.ai_title + ' ' + note.content : note.content)
    const intersection = countIntersection(inputWords, noteWords)
    const union = inputWords.size + noteWords.size - intersection
    const score = union > 0 ? intersection / union : 0
    if (score > bestScore) {
      bestScore = score
      bestNote = note
    }
  }

  return bestScore > 0.25 ? bestNote : null
}

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9À-ɏ\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 4)
  )
}

function countIntersection(a: Set<string>, b: Set<string>): number {
  let count = 0
  for (const w of a) if (b.has(w)) count++
  return count
}

function restoreDraft(els: {
  textarea: HTMLTextAreaElement
  useForEl: HTMLInputElement
  miniTextarea: HTMLTextAreaElement
  sourceUrl: HTMLInputElement
  sourceTitle: HTMLInputElement
  sourceAuthor: HTMLInputElement
}): void {
  const raw = localStorage.getItem(DRAFT_KEY)
  if (!raw) return
  try {
    const d = JSON.parse(raw) as Draft
    els.textarea.value = d.content ?? ''
    els.useForEl.value = d.useFor ?? ''
    els.miniTextarea.value = d.mini ?? ''
    els.sourceUrl.value = d.url ?? ''
    els.sourceTitle.value = d.title ?? ''
    els.sourceAuthor.value = d.author ?? ''
  } catch {
    localStorage.removeItem(DRAFT_KEY)
  }
}

async function refreshRecent(): Promise<void> {
  const el = document.getElementById('capture-recent')
  if (!el) return
  if (!navigator.onLine) { el.innerHTML = ''; return }
  try {
    const recent = await fetchNotes(0, 3)
    if (recent.length === 0) { el.innerHTML = ''; return }
    el.innerHTML = `
      <div class="recent-head">
        <span>Recent opgeslagen</span>
        <button class="recent-all" id="recent-all">alles in Vangbak →</button>
      </div>
      <ul class="recent-list">
        ${recent.map(n => `<li class="recent-item">${escHtml((n.ai_title ?? n.content).slice(0, 90))}</li>`).join('')}
      </ul>
    `
    document.getElementById('recent-all')?.addEventListener('click', () => navigateTo('/inbox'))
  } catch {
    el.innerHTML = ''
  }
}

async function refreshOnlineIndicator(): Promise<void> {
  const el = document.getElementById('online-indicator')
  if (!el) return
  const queue = await offlineQueueSize().catch(() => 0)
  if (!navigator.onLine) {
    el.textContent = queue > 0 ? `⚫ offline (${queue})` : '⚫ offline'
    el.className = 'online-indicator offline'
    el.title = `Offline${queue > 0 ? ` — ${queue} nota('s) wachten op sync` : ''}`
  } else if (queue > 0) {
    el.textContent = `🟡 sync (${queue})`
    el.className = 'online-indicator sync'
    el.title = `${queue} nota('s) wachten op sync`
  } else {
    el.textContent = '🟢 online'
    el.className = 'online-indicator online'
    el.title = 'Online'
  }
}

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function showToast(msg: string): void {
  const toast = document.getElementById('toast') as HTMLDivElement
  toast.textContent = msg
  toast.classList.add('show')
  setTimeout(() => toast.classList.remove('show'), 2500)
}

function injectCaptureStyles(): void {
  if (document.getElementById('capture-styles')) return
  const style = document.createElement('style')
  style.id = 'capture-styles'
  style.textContent = `
    .capture-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      padding: var(--s-4);
      gap: var(--s-3);
      max-width: 640px;
      width: 100%;
      margin: 0 auto;
      padding-bottom: calc(var(--s-7) + env(safe-area-inset-bottom));
    }
    .capture-textarea {
      min-height: 40vh;
      font-size: var(--fs-lg);
      line-height: 1.6;
      resize: none;
    }
    .duplicate-hint {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      min-height: 1.2em;
      margin: 0;
    }
    .capture-mini-textarea {
      margin-top: var(--s-2);
    }
    .capture-extra {
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      overflow: hidden;
    }
    .capture-extra-toggle {
      padding: var(--s-3) var(--s-4);
      cursor: pointer;
      font-size: var(--fs-sm);
      color: var(--text-muted);
      list-style: none;
      user-select: none;
    }
    .capture-extra-toggle::-webkit-details-marker { display: none; }
    .capture-extra[open] .capture-extra-toggle {
      border-bottom: 1px solid var(--border);
    }
    .capture-extra textarea,
    .capture-bron-fields {
      padding: var(--s-3) var(--s-4);
    }
    .capture-bron-fields {
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }
    .meer-fields {
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
      padding: var(--s-3) var(--s-4);
    }
    .capture-use-for { font-size: var(--fs-sm); }
    .capture-source-select { font-size: var(--fs-sm); }
    .capture-footer {
      position: sticky;
      bottom: 0;
      background: var(--bg);
      padding: var(--s-3) 0;
      display: flex;
      gap: var(--s-2);
      align-items: center;
    }
    .capture-footer .btn {
      min-height: 52px;
      font-size: var(--fs-base);
    }
    .capture-footer .btn-sm {
      min-height: unset;
      font-size: var(--fs-sm);
      padding: var(--s-2) var(--s-3);
    }
    .capture-recent {
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }
    .capture-recent:empty { display: none; }
    .recent-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: var(--fs-sm);
      color: var(--text-muted);
    }
    .recent-all {
      background: none;
      border: none;
      color: var(--accent);
      cursor: pointer;
      font-size: var(--fs-sm);
    }
    .recent-list { list-style: none; display: flex; flex-direction: column; gap: var(--s-1); }
    .recent-item {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-sm);
      padding: var(--s-2) var(--s-3);
      font-size: var(--fs-sm);
      color: var(--text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .online-indicator {
      font-size: 12px;
      padding: 2px var(--s-2);
      border-radius: var(--r-sm);
      color: var(--text-muted);
      cursor: default;
    }
    .online-indicator.offline { color: var(--danger); }
    .online-indicator.sync    { color: #B57C00; }
    .online-indicator.online  { color: var(--accent-hover); }

    /* Random note panel — fixed bottom strip, not a modal */
    .random-note-panel {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 100;
      padding: var(--s-3) var(--s-4);
      background: var(--surface);
      border-top: 1px solid var(--border);
      box-shadow: 0 -2px 12px rgba(0,0,0,0.08);
    }
    .random-note-card {
      max-width: 640px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }
    .random-note-content {
      font-size: var(--fs-sm);
      line-height: 1.6;
      white-space: pre-wrap;
      color: var(--text);
      margin: 0;
      max-height: 8rem;
      overflow-y: auto;
    }
    .random-note-actions {
      display: flex;
      gap: var(--s-2);
    }
    .random-note-actions .btn { width: auto; }
  `
  document.head.appendChild(style)
}
