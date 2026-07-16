import { insertNote, queueOfflineNote, flushOfflineQueue, offlineQueueSize, fetchNotes, fetchNotesByIds, fetchRandomNote, fetchOnThisDay, getNoteTitle, type NoteInsert, type Note } from '../lib/notes'
import { fetchSemanticBridges, hasEmbeddings, fetchDismissedPairKeys, type BridgePair } from '../lib/semantic'
import { fetchSources, createSource, SOURCE_TYPES, SOURCE_TYPE_ORDER, type Source, type SourceType } from '../lib/sources'
import { fetchLinks, createLink } from '../lib/links'
import { openLinkModal } from '../lib/link-modal'
import { fetchAllNoteThemes } from '../lib/themes'
import { findSurprisingPair, pairKey, rankBySimilarity, type SurprisingPair } from '../lib/similarity'
import { embedNote, frameSource, generateSourceInsights, fetchSupadataUsage, type FrameSourceResult, type SourceFraming, type SourceInsightProposal, type SourceCount } from '../lib/ai'
import { createAiAction } from '../lib/ai-action'
import { AI_PHASES } from '../lib/ai-thinking'
import { renderTopbar, attachTopbar, renderGuidanceBanner } from '../lib/nav'
import { navigateTo, onRouteLeave } from '../router'
import { esc as escHtml, showToast, formatRelative } from '../lib/crud-list'

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

  // Sources for the picker — fetched below, once populateSources exists.
  let sources: Source[] = []

  app.innerHTML = `
    ${renderTopbar('ThoughtFoundry', 'capture', '<span class="online-indicator" id="online-indicator" title=""></span>')}
    <div class="capture-body">

      ${renderGuidanceBanner('Schrijf op wat er nu in je hoofd zit. Niets beslissen — gewoon vastleggen.', 'anchor')}

      <textarea
        id="capture-content"
        class="capture-textarea"
        placeholder="Gooi het erin. Half is goed genoeg. Later wordt het iets."
      ></textarea>
      <p class="duplicate-hint" id="duplicate-hint"></p>
      <div class="related-card" id="related-card" hidden></div>

      <details class="capture-extra" id="analyse-details">
        <summary class="capture-extra-toggle">Bron analyseren (AI)</summary>
        <div class="analyze-fields">
          <input type="url" id="analyze-url" placeholder="Plak een URL (website of YouTube-video)…" />
          <div class="analyze-fallback" id="analyze-fallback" hidden>
            <p class="analyze-hint" id="analyze-hint"></p>
            <textarea id="analyze-pasted" rows="5" placeholder="Plak hier het transcript of de tekst…"></textarea>
          </div>
          <div id="analyze-action"></div>
          <p class="analyze-usage" id="analyze-usage" hidden></p>
          <div class="analyze-proposal" id="analyze-questions" hidden></div>
          <div class="analyze-proposal" id="analyze-proposal" hidden></div>
        </div>
      </details>

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
        <span class="capture-session" id="capture-session" hidden></span>
        <button class="btn btn-ghost btn-sm" id="btn-surprise">Verras me</button>
        <button class="btn btn-ghost btn-sm" id="btn-onthisday">Op deze dag</button>
        <button class="btn btn-ghost btn-sm" id="btn-connect">Verbind twee</button>
      </div>

      <div class="capture-recent" id="capture-recent"></div>
    </div>

    <div id="random-note-panel" class="random-note-panel" hidden>
      <div class="random-note-card">
        <p class="random-note-label" id="random-note-label" hidden></p>
        <p class="random-note-content" id="random-note-content"></p>
        <div class="random-note-actions">
          <button class="btn btn-ghost btn-sm" id="btn-open-surfaced">Openen</button>
          <button class="btn btn-ghost btn-sm" id="btn-reroll">Nog eentje</button>
          <button class="btn btn-ghost btn-sm" id="btn-close-random">Sluiten</button>
        </div>
      </div>
    </div>

    <div id="connect-pair-panel" class="random-note-panel" hidden>
      <div class="random-note-card">
        <p class="random-note-label">Verrassende verbinding · lijken verwant, nog niet gekoppeld</p>
        <div class="pair-notes">
          <p class="random-note-content pair-note" id="pair-a"></p>
          <span class="pair-link-icon">↔</span>
          <p class="random-note-content pair-note" id="pair-b"></p>
        </div>
        <div class="random-note-actions">
          <button class="btn btn-primary btn-sm" id="btn-pair-link">Koppel deze twee</button>
          <button class="btn btn-ghost btn-sm" id="btn-pair-next">Andere suggestie</button>
          <button class="btn btn-ghost btn-sm" id="btn-pair-close">Sluiten</button>
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
  const sessionEl = document.getElementById('capture-session') as HTMLSpanElement

  // Session counter: persisted via localStorage, keyed by calendar date.
  const TODAY_KEY = `tf_today_count_${new Date().toDateString()}`
  const getTodayCount = (): number => parseInt(localStorage.getItem(TODAY_KEY) ?? '0', 10)
  const incrementTodayCount = (): number => {
    const n = getTodayCount() + 1
    localStorage.setItem(TODAY_KEY, String(n))
    return n
  }
  const updateSessionIndicator = () => {
    const n = getTodayCount()
    if (n === 0) { sessionEl.hidden = true; return }
    sessionEl.hidden = false
    sessionEl.textContent = n === 1 ? '1 gedachte vandaag' : `${n} gedachten vandaag`
  }
  updateSessionIndicator()

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
  // Populate when the fetch actually lands (a fixed timeout loses the race on
  // slow connections and would leave the picker empty until a full reload).
  if (navigator.onLine) {
    fetchSources().then(s => { sources = s; populateSources() }).catch(() => { /* picker stays minimal */ })
  }

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
        // Keep the semantic substrate current from the moment of capture
        // (free, fire-and-forget — a failure must never block saving).
        void embedNote(saved.id).catch(() => {})
        showRelatedCard(saved, recentNotes)
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
      incrementTodayCount()
      updateSessionIndicator()
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

  // Surfacing panel — "Verras me" (random, unprocessed-first) and "Op deze dag".
  const panel = document.getElementById('random-note-panel') as HTMLDivElement
  const randomContent = document.getElementById('random-note-content') as HTMLParagraphElement
  const randomLabel = document.getElementById('random-note-label') as HTMLParagraphElement
  let surfacedId: string | null = null
  let lastSurfaceMode: 'surprise' | 'onthisday' = 'surprise'

  const renderSurfaced = (note: Note | null, label: string): boolean => {
    if (!note) return false
    surfacedId = note.id
    randomLabel.textContent = label
    randomLabel.hidden = label === ''
    randomContent.textContent = note.ai_title
      ? `${note.ai_title}\n\n${note.content.slice(0, 300)}${note.content.length > 300 ? '…' : ''}`
      : note.content.slice(0, 300) + (note.content.length > 300 ? '…' : '')
    document.getElementById('connect-pair-panel')?.setAttribute('hidden', '')
    panel.hidden = false
    return true
  }

  const showSurprise = async () => {
    lastSurfaceMode = 'surprise'
    // Prefer an unprocessed note (the pile that wants attention), else anything.
    let note = await fetchRandomNote('inbox').catch(() => null)
    if (!note) note = await fetchRandomNote().catch(() => null)
    if (!renderSurfaced(note, '')) showToast('Geen nota\'s gevonden')
  }

  const showOnThisDay = async () => {
    lastSurfaceMode = 'onthisday'
    const note = await fetchOnThisDay().catch(() => null)
    if (!renderSurfaced(note, note ? formatRelative(note.created_at) : '')) {
      showToast('Nog geen oudere nota om terug te halen')
    }
  }

  document.getElementById('btn-surprise')?.addEventListener('click', showSurprise)
  document.getElementById('btn-onthisday')?.addEventListener('click', showOnThisDay)
  document.getElementById('btn-reroll')?.addEventListener('click', () =>
    lastSurfaceMode === 'onthisday' ? showOnThisDay() : showSurprise())
  document.getElementById('btn-open-surfaced')?.addEventListener('click', () => {
    if (surfacedId) navigateTo('/note?id=' + surfacedId)
  })
  document.getElementById('btn-close-random')?.addEventListener('click', () => { panel.hidden = true })

  // "Verbind twee" — surface two notes that look related (shared words/tags) yet
  // are not linked and share no theme. The cross-theme bridge that sparks a book.
  const pairPanel = document.getElementById('connect-pair-panel') as HTMLDivElement
  const pairAEl = document.getElementById('pair-a') as HTMLParagraphElement
  const pairBEl = document.getElementById('pair-b') as HTMLParagraphElement
  let currentPair: SurprisingPair | null = null
  let pairData: { pool: Note[]; linkedPairs: Set<string>; themeMap: Map<string, Set<string>> } | null = null

  const pairPreview = (n: Note): string =>
    n.ai_title ?? (n.content.slice(0, 120) + (n.content.length > 120 ? '…' : ''))

  const loadPairData = async (): Promise<void> => {
    const [pool, allLinks, noteThemes] = await Promise.all([
      fetchNotes(0, 300),
      fetchLinks(),
      fetchAllNoteThemes()
    ])
    const linkedPairs = new Set<string>()
    allLinks.forEach(l => linkedPairs.add(pairKey(l.source_id, l.target_id)))
    const themeMap = new Map<string, Set<string>>()
    noteThemes.forEach(({ note_id, theme_id }) => {
      const s = themeMap.get(note_id) ?? new Set<string>()
      s.add(theme_id)
      themeMap.set(note_id, s)
    })
    pairData = { pool, linkedPairs, themeMap }
  }

  // Prefer semantic bridges (meaning-based, cross-theme, minus dismissed) when
  // embeddings exist; the lexical findSurprisingPair stays as the fallback.
  let semanticPairs: BridgePair[] | null = null
  const loadSemanticPairs = async (): Promise<BridgePair[]> => {
    if (semanticPairs) return semanticPairs
    if (!(await hasEmbeddings())) { semanticPairs = []; return semanticPairs }
    const [bridges, dismissed] = await Promise.all([
      fetchSemanticBridges({ bandLo: 0.55, bandHi: 0.72, max: 20 }),
      fetchDismissedPairKeys().catch(() => new Set<string>())
    ])
    semanticPairs = bridges.filter(p => !dismissed.has(`${p.a_id}|${p.b_id}`))
    return semanticPairs
  }

  const showSurprisingPair = async (): Promise<void> => {
    panel.hidden = true
    try {
      const sem = await loadSemanticPairs().catch(() => [] as BridgePair[])
      if (sem.length > 0) {
        const p = sem[Math.floor(Math.random() * sem.length)]
        const notes = await fetchNotesByIds([p.a_id, p.b_id])
        const a = notes.find(n => n.id === p.a_id)
        const b = notes.find(n => n.id === p.b_id)
        if (a && b) {
          if (!pairData) await loadPairData().catch(() => {})
          currentPair = { a, b, score: p.similarity }
          pairAEl.textContent = pairPreview(a)
          pairBEl.textContent = pairPreview(b)
          pairPanel.hidden = false
          return
        }
      }

      if (!pairData) await loadPairData()
      const pair = findSurprisingPair(pairData!.pool, pairData!.linkedPairs, pairData!.themeMap)
      if (!pair) {
        pairPanel.hidden = true
        showToast('Nog geen verrassende verbinding gevonden')
        return
      }
      currentPair = pair
      pairAEl.textContent = pairPreview(pair.a as Note)
      pairBEl.textContent = pairPreview(pair.b as Note)
      pairPanel.hidden = false
    } catch {
      showToast('Kon geen suggestie laden')
    }
  }

  document.getElementById('btn-connect')?.addEventListener('click', showSurprisingPair)
  document.getElementById('btn-pair-next')?.addEventListener('click', showSurprisingPair)
  document.getElementById('btn-pair-close')?.addEventListener('click', () => { pairPanel.hidden = true })
  document.getElementById('btn-pair-link')?.addEventListener('click', () => {
    if (!currentPair || !pairData) return
    const pair = currentPair
    const data = pairData
    openLinkModal({
      sourceId: pair.a.id,
      sourceLabel: pairPreview(pair.a as Note),
      target: { id: pair.b.id, label: pairPreview(pair.b as Note) },
      defaultType: 'related',
      defaultReason: 'Verrassende verbinding',
      onLinked: () => {
        data.linkedPairs.add(pairKey(pair.a.id, pair.b.id))
        if (semanticPairs) {
          semanticPairs = semanticPairs.filter(p =>
            !(p.a_id === pair.a.id && p.b_id === pair.b.id) &&
            !(p.a_id === pair.b.id && p.b_id === pair.a.id))
        }
        showToast('Gekoppeld')
        void showSurprisingPair() // roll the next bridge
      }
    })
  })

  // "Bron analyseren (AI)" — paste a URL (website/YouTube), get a PROPOSAL of
  // potential insights back, review with checkboxes, save the accepted ones to
  // the Vangbak as literature notes linked to a fresh source record.
  setupSourceAnalysis()

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
  // Window listeners outlive the page's DOM — without this, every visit to
  // Capture stacked another pair, so one reconnect flushed/toasted N times.
  onRouteLeave(() => {
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
  })
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

/**
 * Instant "Lijkt verwant aan …" card right after a save: lexical ranking over
 * the already-loaded recent notes (zero network, works offline-ish), with a
 * one-tap Koppel that creates a 'related' link. Dismisses on Weiger or the
 * next save.
 */
function showRelatedCard(saved: Note, pool: Note[]): void {
  const card = document.getElementById('related-card') as HTMLDivElement | null
  if (!card) return
  card.hidden = true

  const candidates = pool.filter(n => n.id !== saved.id)
  const [best] = rankBySimilarity(saved, candidates, 1)
  if (!best || best.score < 3) return

  const title = getNoteTitle(best.note, 70)
  card.innerHTML = `
    <span class="related-card-text">Lijkt verwant aan: «${escHtml(title)}»</span>
    <span class="related-card-actions">
      <button class="btn btn-ghost btn-sm" id="related-link-btn">Koppel</button>
      <button class="btn btn-ghost btn-sm" id="related-dismiss-btn">Weiger</button>
    </span>
  `
  card.hidden = false

  document.getElementById('related-dismiss-btn')?.addEventListener('click', () => { card.hidden = true })
  document.getElementById('related-link-btn')?.addEventListener('click', async () => {
    try {
      await createLink({ sourceId: saved.id, targetId: best.note.id, type: 'related', reason: 'Bij vastleggen gekoppeld' })
      showToast('Gekoppeld')
    } catch {
      showToast('Koppelen mislukt (bestaat de link al?)')
    }
    card.hidden = true
  })
}

/**
 * Wires the "Bron analyseren (AI)" section: URL in → analyze-source proposal →
 * review panel (checkboxes, editable) → createSource + one literature note per
 * accepted insight, straight into the Vangbak. When the server can't retrieve
 * the content (blocked page, video without captions) a paste-it-yourself
 * textarea appears and the same button re-analyzes with the pasted text.
 */
function setupSourceAnalysis(): void {
  const analyseDetails = document.getElementById('analyse-details') as HTMLDetailsElement
  const urlEl = document.getElementById('analyze-url') as HTMLInputElement
  const fallbackEl = document.getElementById('analyze-fallback') as HTMLDivElement
  const hintEl = document.getElementById('analyze-hint') as HTMLParagraphElement
  const pastedEl = document.getElementById('analyze-pasted') as HTMLTextAreaElement
  const proposalEl = document.getElementById('analyze-proposal') as HTMLDivElement
  const actionHost = document.getElementById('analyze-action') as HTMLDivElement
  const usageEl = document.getElementById('analyze-usage') as HTMLParagraphElement

  // Supadata credit counter (YouTube-transcript quota). Hidden when no key is
  // configured or the lookup fails, so nothing shows if the feature is off.
  const refreshUsage = async (): Promise<void> => {
    try {
      const { usage } = await fetchSupadataUsage()
      if (usage && usage.used != null && usage.limit != null) {
        usageEl.textContent = `Supadata: ${usage.used} / ${usage.limit} credits deze maand`
        usageEl.hidden = false
      } else if (usage && usage.remaining != null) {
        usageEl.textContent = `Supadata: nog ${usage.remaining} credits deze maand`
        usageEl.hidden = false
      } else {
        usageEl.hidden = true
      }
    } catch { usageEl.hidden = true }
  }
  void refreshUsage()

  // Retrieved source state, held between the two stages. `content` is the text
  // the frame stage fetched; the insights stage reuses it (no re-fetch/credit).
  let meta: FrameSourceResult['meta'] | null = null
  let content: string | null = null

  const questionsEl = document.getElementById('analyze-questions') as HTMLDivElement

  const isHttpUrl = (raw: string): boolean => {
    try {
      const u = new URL(raw)
      return u.protocol === 'http:' || u.protocol === 'https:'
    } catch { return false }
  }

  // Share-target / draft prefill: a shared URL lands one tap away from analysis.
  const draft = loadDraftObj()
  if (draft.url && isHttpUrl(draft.url)) {
    urlEl.value = draft.url
    analyseDetails.open = true
  }

  const showFallback = (reason?: string): void => {
    hintEl.textContent = reason === 'no_captions'
      ? 'Geen ondertitels gevonden bij deze video. Plak het transcript hieronder en analyseer opnieuw.'
      : 'Kon de inhoud niet ophalen (mogelijk afgeschermd). Plak de tekst hieronder en analyseer opnieuw.'
    fallbackEl.hidden = false
    pastedEl.focus()
  }

  // Stage 1: retrieve + frame the source, then show the question panel.
  const action = createAiAction(actionHost, {
    label: 'Analyseer bron',
    expectedOutputTokens: 600,
    // The page size is unknown before the fetch — assume the server-side
    // content budget unless the user pasted the text themselves.
    estimateInputChars: () => pastedEl.value.trim().length || 18_000,
    phases: AI_PHASES.sourceFrame,
    beforeRun: () => {
      const url = urlEl.value.trim()
      const pasted = pastedEl.value.trim()
      if (!url && !pasted) { showToast('Plak eerst een URL'); return false }
      if (url && !isHttpUrl(url)) { showToast('Dat lijkt geen geldige URL (http/https)'); return false }
      return true
    },
    run: async (model, overrideCap) => {
      proposalEl.hidden = true
      questionsEl.hidden = true
      const res = await frameSource({
        url: urlEl.value.trim() || undefined,
        pastedText: pastedEl.value.trim() || undefined,
        model,
        overrideCap,
      })
      // A YouTube frame may have spent a Supadata credit — refresh the counter.
      void refreshUsage()
      if (res.needsManualText) {
        meta = res.meta ?? null
        showFallback(res.reason)
        return undefined
      }
      fallbackEl.hidden = true
      meta = res.meta ?? null
      content = res.content ?? ''
      renderQuestions(res.framing ?? { summary: '', angles: [] })
      return res.usage
    },
  })
  pastedEl.addEventListener('input', () => action.refreshEstimate())

  function resetAnalysis(): void {
    proposalEl.hidden = true
    proposalEl.innerHTML = ''
    questionsEl.hidden = true
    questionsEl.innerHTML = ''
    fallbackEl.hidden = true
    urlEl.value = ''
    pastedEl.value = ''
    meta = null
    content = null
    action.refreshEstimate()
  }

  const COUNT_OPTIONS: { value: SourceCount; label: string }[] = [
    { value: 'auto',   label: 'Auto' },
    { value: 'few',    label: 'Weinig (2-3)' },
    { value: 'medium', label: 'Gemiddeld (4-6)' },
    { value: 'many',   label: 'Veel (7-10)' },
  ]

  // Stage 2 panel: editable source header + count/focus questions + a second AI
  // action that generates the insight list from the already-retrieved content.
  function renderQuestions(framing: SourceFraming): void {
    const title = meta?.title ?? ''
    const author = meta?.author ?? ''
    const type = (meta?.source_type && SOURCE_TYPE_ORDER.includes(meta.source_type as SourceType))
      ? meta.source_type as SourceType : 'article'

    questionsEl.innerHTML = `
      <p class="analyze-proposal-label">Bron — verfijn en genereer</p>
      <div class="analyze-source-head">
        <input type="text" id="ap-title" value="${escHtml(title)}" placeholder="Titel" />
        <div class="analyze-source-row">
          <input type="text" id="ap-author" value="${escHtml(author)}" placeholder="Auteur" />
          <select id="ap-type">
            ${SOURCE_TYPE_ORDER.map(t =>
              `<option value="${t}"${t === type ? ' selected' : ''}>${SOURCE_TYPES[t].label}</option>`
            ).join('')}
          </select>
        </div>
        <textarea id="ap-summary" rows="2" placeholder="Samenvatting">${escHtml(framing.summary)}</textarea>
      </div>
      <div class="analyze-q">
        <span class="analyze-q-label">Aantal inzichten</span>
        <div class="analyze-chip-grid">
          ${COUNT_OPTIONS.map((o, i) => `
            <label class="analyze-chip${i === 0 ? ' selected' : ''}">
              <input type="radio" name="analyze-count" value="${o.value}" ${i === 0 ? 'checked' : ''} />${escHtml(o.label)}
            </label>`).join('')}
        </div>
      </div>
      ${framing.angles.length > 0 ? `
      <div class="analyze-q">
        <span class="analyze-q-label">Focus — invalshoeken uit deze bron</span>
        <div class="analyze-chip-grid">
          ${framing.angles.map((a, i) => `
            <label class="analyze-chip selected">
              <input type="checkbox" class="angle-check" data-angle="${escHtml(a)}" value="${i}" checked />${escHtml(a)}
            </label>`).join('')}
        </div>
      </div>` : '<p class="analyze-hint">Geen specifieke invalshoeken gevonden — de AI kiest zelf de sterkste.</p>'}
      <div id="analyze-insight-action"></div>
    `
    questionsEl.hidden = false

    // Chip visual state: single-select radios (count), multi-select checks (angles).
    questionsEl.querySelectorAll<HTMLInputElement>('input[name="analyze-count"]').forEach(radio => {
      radio.addEventListener('change', () => {
        questionsEl.querySelectorAll<HTMLInputElement>('input[name="analyze-count"]').forEach(r =>
          (r.closest('.analyze-chip') as HTMLElement | null)?.classList.toggle('selected', r.checked))
      })
    })
    questionsEl.querySelectorAll<HTMLInputElement>('.angle-check').forEach(cb => {
      cb.addEventListener('change', () =>
        (cb.closest('.analyze-chip') as HTMLElement | null)?.classList.toggle('selected', cb.checked))
    })

    const insightHost = questionsEl.querySelector('#analyze-insight-action') as HTMLDivElement
    createAiAction(insightHost, {
      label: 'Genereer inzichten',
      expectedOutputTokens: 2200,
      estimateInputChars: () => (content?.length ?? 0) || 4000,
      phases: AI_PHASES.analyzeSource,
      run: async (model, overrideCap) => {
        const count = ((questionsEl.querySelector('input[name="analyze-count"]:checked') as HTMLInputElement | null)?.value ?? 'auto') as SourceCount
        const angles = Array.from(questionsEl.querySelectorAll<HTMLInputElement>('.angle-check:checked'))
          .map(c => c.dataset['angle'] ?? '').filter(Boolean)
        const res = await generateSourceInsights({ content: content ?? '', count, angles, model, overrideCap })
        renderInsights(res.insights ?? [])
        return res.usage
      },
    })
  }

  // Stage 2 result: the insight list + save-to-Vangbak footer.
  function renderInsights(insights: SourceInsightProposal[]): void {
    proposalEl.innerHTML = `
      <p class="analyze-proposal-label">Voorstel — kies wat naar de Vangbak gaat</p>
      ${insights.length === 0 ? '<p class="analyze-hint">Geen bruikbare inzichten gevonden. Pas de focus aan en genereer opnieuw.</p>' : ''}
      <ul class="analyze-insights">
        ${insights.map((ins, i) => `
          <li class="analyze-insight">
            <input type="checkbox" class="ap-check" data-idx="${i}" checked />
            <div class="analyze-insight-body">
              <textarea class="ap-content" data-idx="${i}" rows="3">${escHtml(ins.content)}</textarea>
              ${ins.core_idea || ins.tags.length > 0
                ? `<p class="analyze-insight-meta">${escHtml(ins.core_idea ?? '')}${
                    ins.tags.length > 0 ? `${ins.core_idea ? ' · ' : ''}${ins.tags.map(t => '#' + escHtml(t)).join(' ')}` : ''
                  }</p>`
                : ''}
            </div>
          </li>`).join('')}
      </ul>
      <div class="analyze-proposal-footer">
        <button class="btn btn-primary" id="ap-save"></button>
        <button class="btn btn-ghost btn-sm" id="ap-cancel">Annuleer</button>
      </div>
    `
    proposalEl.hidden = false

    const saveBtn = proposalEl.querySelector('#ap-save') as HTMLButtonElement
    const checks = Array.from(proposalEl.querySelectorAll<HTMLInputElement>('.ap-check'))

    const updateCount = (): void => {
      const n = checks.filter(c => c.checked).length
      saveBtn.textContent = n === 1 ? 'Bewaar 1 inzicht in Vangbak' : `Bewaar ${n} inzichten in Vangbak`
      saveBtn.disabled = n === 0
    }
    checks.forEach(c => c.addEventListener('change', updateCount))
    updateCount()

    proposalEl.querySelector('#ap-cancel')?.addEventListener('click', () => {
      proposalEl.hidden = true
      proposalEl.innerHTML = ''
    })

    saveBtn.addEventListener('click', async () => {
      const selected = checks.filter(c => c.checked).map(c => Number(c.dataset['idx']))
      if (selected.length === 0) return
      saveBtn.disabled = true

      try {
        // Header lives in the questions panel (still in the DOM above).
        const title = (questionsEl.querySelector('#ap-title') as HTMLInputElement).value.trim() || 'Onbekende bron'
        const author = (questionsEl.querySelector('#ap-author') as HTMLInputElement).value.trim()
        const type = (questionsEl.querySelector('#ap-type') as HTMLSelectElement).value as SourceType
        const summary = (questionsEl.querySelector('#ap-summary') as HTMLTextAreaElement).value.trim()
        const analyzedUrl = urlEl.value.trim() || meta?.url || ''

        const src = await createSource({
          title,
          author: author || undefined,
          type,
          url: analyzedUrl || undefined,
          summary: summary || undefined,
        })

        let saved = 0
        for (const idx of selected) {
          const contentEl = proposalEl.querySelector(`.ap-content[data-idx="${idx}"]`) as HTMLTextAreaElement | null
          const c = contentEl?.value.trim()
          if (!c) continue
          const ins = insights[idx]
          const note = await insertNote({
            content: c,
            note_type: 'literature',
            core_idea: ins?.core_idea || undefined,
            tags: ins && ins.tags.length > 0 ? ins.tags : undefined,
            source_id: src.id,
            source_url: analyzedUrl || undefined,
            source_title: title,
            source_author: author || undefined,
          })
          // Keep the semantic substrate current — free and fire-and-forget.
          void embedNote(note.id).catch(() => {})
          saved++
        }

        showToast(saved === 1 ? '1 inzicht opgeslagen in Vangbak' : `${saved} inzichten opgeslagen in Vangbak`)
        resetAnalysis()
        await refreshRecent()
      } catch (err) {
        showToast('Opslaan mislukt. Probeer opnieuw.')
        console.error(err)
        saveBtn.disabled = false
      }
    })
  }
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
      padding-bottom: calc(var(--bottom-nav-h) + var(--s-4));
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
    .related-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--s-2);
      flex-wrap: wrap;
      background: var(--surface);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      border-radius: var(--r-sm);
      padding: var(--s-2) var(--s-3);
      font-size: var(--fs-sm);
    }
    .related-card-actions { display: inline-flex; gap: var(--s-1); }
    .related-card .btn { width: auto; }
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
    .analyze-fields {
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
      padding: var(--s-3) var(--s-4);
    }
    .analyze-fields textarea { padding: var(--s-2); }
    .analyze-fallback {
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }
    .analyze-hint {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      margin: 0;
    }
    .analyze-usage {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      margin: 0;
    }
    .analyze-usage:empty { display: none; }
    .analyze-proposal {
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
      background: var(--surface);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      border-radius: var(--r-sm);
      padding: var(--s-3);
    }
    .analyze-proposal-label {
      font-size: 12px;
      color: var(--text-muted);
      margin: 0;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .analyze-source-head {
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }
    .analyze-source-row {
      display: flex;
      gap: var(--s-2);
    }
    .analyze-source-row input { flex: 1; min-width: 0; }
    .analyze-q {
      display: flex;
      flex-direction: column;
      gap: var(--s-1);
    }
    .analyze-q-label {
      font-size: var(--fs-sm);
      color: var(--text-muted);
    }
    .analyze-chip-grid {
      display: flex;
      flex-wrap: wrap;
      gap: var(--s-2);
    }
    .analyze-chip {
      position: relative;
      border: 1px solid var(--border);
      border-radius: var(--r-sm);
      background: var(--bg);
      color: var(--text-muted);
      padding: 4px var(--s-3);
      font-size: var(--fs-sm);
      cursor: pointer;
      user-select: none;
    }
    .analyze-chip.selected {
      border-color: var(--accent);
      color: var(--accent);
      background: var(--surface);
      font-weight: 600;
    }
    .analyze-chip input {
      position: absolute;
      opacity: 0;
      width: 0;
      height: 0;
    }
    .analyze-insights {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
      margin: 0;
      padding: 0;
    }
    .analyze-insight {
      display: flex;
      align-items: flex-start;
      gap: var(--s-2);
    }
    .analyze-insight input[type="checkbox"] {
      margin-top: var(--s-2);
      flex-shrink: 0;
    }
    .analyze-insight-body {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: var(--s-1);
    }
    .analyze-insight-body textarea { width: 100%; font-size: var(--fs-sm); }
    .analyze-insight-meta {
      font-size: 12px;
      color: var(--text-muted);
      margin: 0;
    }
    .analyze-proposal-footer {
      display: flex;
      gap: var(--s-2);
      align-items: center;
      flex-wrap: wrap;
    }
    .analyze-proposal-footer .btn { width: auto; }
    .capture-use-for { font-size: var(--fs-sm); }
    .capture-source-select { font-size: var(--fs-sm); }
    .capture-footer {
      position: sticky;
      bottom: 0;
      /* sits above bottom nav via padding-bottom on .capture-body */
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
    .capture-session {
      font-size: var(--fs-sm);
      color: var(--accent-hover);
      font-weight: 500;
      white-space: nowrap;
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

    /* Random note panel — fixed bottom strip, sits above the bottom nav */
    .random-note-panel {
      position: fixed;
      bottom: var(--bottom-nav-h);
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
    .random-note-label {
      font-size: 12px;
      color: var(--text-muted);
      margin: 0;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
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
      flex-wrap: wrap;
    }
    .random-note-actions .btn { width: auto; }
    .pair-notes {
      display: flex;
      align-items: stretch;
      gap: var(--s-2);
    }
    .pair-note {
      flex: 1;
      min-width: 0;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--r-sm);
      padding: var(--s-2);
      max-height: 6rem;
    }
    .pair-link-icon {
      align-self: center;
      color: var(--accent);
      font-weight: 700;
      font-size: var(--fs-lg);
    }
  `
  document.head.appendChild(style)
}
