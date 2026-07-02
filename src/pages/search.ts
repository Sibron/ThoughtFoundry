import { fetchNotes, fetchNotesByIds, getNoteTitle, type Note } from '../lib/notes'
import { rankByQuery } from '../lib/similarity'
import { embedText, matchNotes, hasEmbeddings } from '../lib/semantic'
import { navigateTo } from '../router'
import { formatDate, esc as escHtml, errMsg } from '../lib/crud-list'

// Fast full-text search across content / title / summary. The single most
// important re-finding tool: "I know I wrote this down somewhere" must always
// resolve in one screen, or trust in the system collapses.
//
// Two modes: Woorden (lexical, live while typing) and Betekenis (semantic —
// embed the query with the free edge model + match_notes; runs on Enter, not
// per keystroke, since it's a network round-trip).

export async function mountSearch(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="search-body">
      <input
        type="text"
        id="search-input"
        class="search-input"
        placeholder="Zoek in al je notities…"
        autocomplete="off"
        autocapitalize="off"
      />
      <div class="search-modes" role="radiogroup" aria-label="Zoekmodus">
        <button class="search-mode active" data-mode="words" role="radio" aria-checked="true">Woorden</button>
        <button class="search-mode" data-mode="meaning" role="radio" aria-checked="false">Betekenis</button>
        <span class="search-mode-hint" id="search-mode-hint"></span>
      </div>
      <div id="search-results" class="search-results">
        <p class="search-hint">Typ om te zoeken in content, titel en samenvatting.</p>
      </div>
    </div>
  `

  injectSearchStyles()

  const input = document.getElementById('search-input') as HTMLInputElement
  const resultsEl = document.getElementById('search-results') as HTMLDivElement
  const modeHint = document.getElementById('search-mode-hint') as HTMLElement
  let debounce: ReturnType<typeof setTimeout> | null = null
  let lastQuery = ''
  let mode: 'words' | 'meaning' = 'words'

  // Allow ?q= deep-links (e.g. from a shortcut) to pre-fill the search.
  const hash = window.location.hash.slice(1)
  const qIndex = hash.indexOf('?')
  if (qIndex !== -1) {
    const preset = new URLSearchParams(hash.slice(qIndex + 1)).get('q')
    if (preset) input.value = preset
  }

  input.focus()

  const runWords = async () => {
    const q = input.value.trim()
    lastQuery = q
    if (q.length < 2) {
      resultsEl.innerHTML = '<p class="search-hint">Typ om te zoeken in content, titel en samenvatting.</p>'
      return
    }
    resultsEl.innerHTML = '<p class="search-hint">Zoeken…</p>'
    try {
      // Fetch a wide candidate set, then rank by relevance client-side so the
      // best match leads — not merely the most recent note containing a word.
      const notes = await fetchNotes(0, 80, undefined, q)
      if (q !== lastQuery) return // a newer query already superseded this one
      const ranked = rankByQuery(q, notes).map(s => s.note)
      renderResults(ranked, q)
    } catch (err) {
      resultsEl.innerHTML = `<p class="search-hint">Zoeken mislukt: ${escHtml(errMsg(err))}</p>`
    }
  }

  const runMeaning = async () => {
    const q = input.value.trim()
    lastQuery = q
    if (q.length < 2) {
      resultsEl.innerHTML = '<p class="search-hint">Typ een vraag of gedachte en druk op Enter.</p>'
      return
    }
    resultsEl.innerHTML = '<p class="search-hint">Zoeken op betekenis…</p>'
    try {
      if (!(await hasEmbeddings())) {
        resultsEl.innerHTML = '<p class="search-hint">Nog geen semantische index — activeer embeddings via Instellingen.</p>'
        return
      }
      const vec = await embedText(q)
      const hits = await matchNotes(vec, 20)
      if (q !== lastQuery) return
      const strong = hits.filter(h => h.similarity >= 0.45)
      if (strong.length === 0) {
        resultsEl.innerHTML = `<p class="search-hint">Niets gevonden dat lijkt op "${escHtml(q)}".</p>`
        return
      }
      const notes = await fetchNotesByIds(strong.map(h => h.id))
      const simById = new Map(strong.map(h => [h.id, h.similarity]))
      notes.sort((a, b) => (simById.get(b.id) ?? 0) - (simById.get(a.id) ?? 0))
      renderResults(notes, q, simById)
    } catch (err) {
      resultsEl.innerHTML = `<p class="search-hint">Zoeken mislukt: ${escHtml(errMsg(err))}</p>`
    }
  }

  const run = () => (mode === 'words' ? runWords() : runMeaning())

  input.addEventListener('input', () => {
    if (mode !== 'words') return // meaning mode runs on Enter, not per keystroke
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(runWords, 220)
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run()
  })

  root.querySelectorAll<HTMLButtonElement>('.search-mode').forEach(btn => {
    btn.addEventListener('click', () => {
      mode = btn.dataset['mode'] as 'words' | 'meaning'
      root.querySelectorAll('.search-mode').forEach(b => {
        b.classList.toggle('active', b === btn)
        b.setAttribute('aria-checked', String(b === btn))
      })
      modeHint.textContent = mode === 'meaning'
        ? 'Vindt nota\'s met andere woorden maar dezelfde gedachte. Enter om te zoeken.'
        : ''
      input.focus()
      if (input.value.trim()) run()
    })
  })

  if (input.value.trim()) run()

  function renderResults(notes: Note[], q: string, similarity?: Map<string, number>): void {
    if (notes.length === 0) {
      resultsEl.innerHTML = `<p class="search-hint">Niets gevonden voor "${escHtml(q)}".</p>`
      return
    }
    resultsEl.innerHTML = `
      <p class="search-count">${notes.length} resultaat${notes.length === 1 ? '' : 'en'}${similarity ? ' · op betekenis' : ''}</p>
      <ul class="search-list">
        ${notes.map(n => {
          const title = getNoteTitle(n, 70)
          const snippet = similarity
            ? escHtml(n.content.slice(0, 160)) + (n.content.length > 160 ? '…' : '')
            : highlight(snippetAround(n.content, q), q)
          const sim = similarity?.get(n.id)
          return `
            <li class="search-item" data-id="${n.id}">
              <div class="search-item-title">${similarity ? escHtml(title) : highlight(escHtml(title), q)}</div>
              <div class="search-item-snippet">${snippet}</div>
              <div class="search-item-meta">
                <span class="badge badge-${n.status}">${escHtml(n.status)}</span>
                <span class="search-item-date">${formatDate(n.created_at)}</span>
                ${sim != null ? `<span class="search-item-sim">${Math.round(sim * 100)}% verwant</span>` : ''}
              </div>
            </li>`
        }).join('')}
      </ul>
    `
    resultsEl.querySelectorAll<HTMLElement>('.search-item').forEach(item => {
      item.addEventListener('click', () => navigateTo('/note?id=' + item.dataset['id']))
    })
  }
}

/** Pull a ~160-char window of content centred on the first matching word. */
function snippetAround(content: string, q: string): string {
  const lower = content.toLowerCase()
  // Centre on whichever query word appears first in the body.
  let idx = -1, matchLen = q.length
  for (const w of queryWords(q)) {
    const at = lower.indexOf(w)
    if (at !== -1 && (idx === -1 || at < idx)) { idx = at; matchLen = w.length }
  }
  if (idx === -1) return escHtml(content.slice(0, 160)) + (content.length > 160 ? '…' : '')
  const start = Math.max(0, idx - 60)
  const end = Math.min(content.length, idx + matchLen + 100)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < content.length ? '…' : ''
  return escHtml(prefix + content.slice(start, end) + suffix)
}

/** Wrap matches of each query word (already-escaped haystack) in <mark>. */
function highlight(escaped: string, q: string): string {
  const words = queryWords(q)
  if (words.length === 0) return escaped
  const safe = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  try {
    return escaped.replace(new RegExp(`(${safe})`, 'gi'), '<mark>$1</mark>')
  } catch {
    return escaped
  }
}

/** Split a query into the words worth matching/highlighting. */
function queryWords(q: string): string[] {
  return Array.from(new Set(q.toLowerCase().split(/\s+/).map(w => w.trim()).filter(w => w.length >= 2)))
}




function injectSearchStyles(): void {
  if (document.getElementById('search-styles')) return
  const style = document.createElement('style')
  style.id = 'search-styles'
  style.textContent = `
    .search-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
      padding: var(--s-4);
      padding-bottom: calc(var(--bottom-nav-h) + var(--s-4));
      max-width: 760px;
      width: 100%;
      margin: 0 auto;
    }
    .search-input {
      font-size: var(--fs-lg);
      padding: var(--s-3) var(--s-4);
    }
    .search-modes {
      display: flex;
      align-items: center;
      gap: var(--s-1);
      flex-wrap: wrap;
    }
    .search-mode {
      border: 1px solid var(--border); border-radius: var(--r-sm);
      background: var(--bg); color: var(--text-muted);
      padding: 4px var(--s-3); font-size: var(--fs-sm); cursor: pointer;
    }
    .search-mode.active {
      border-color: var(--accent); color: var(--accent);
      background: var(--surface); font-weight: 600;
    }
    .search-mode-hint { font-size: var(--fs-sm); color: var(--text-muted); }
    .search-item-sim { font-size: var(--fs-sm); color: var(--accent); font-weight: 600; }
    .search-hint, .search-count {
      color: var(--text-muted);
      font-size: var(--fs-sm);
      text-align: center;
      padding: var(--s-4) 0;
    }
    .search-count { text-align: left; padding: var(--s-1) 0; }
    .search-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }
    .search-item {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-3) var(--s-4);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: var(--s-1);
    }
    .search-item:hover { border-color: var(--accent); }
    .search-item-title { font-weight: 600; }
    .search-item-snippet {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      line-height: 1.5;
      white-space: pre-wrap;
    }
    .search-item-meta {
      display: flex;
      align-items: center;
      gap: var(--s-2);
    }
    .search-item-date { font-size: var(--fs-sm); color: var(--text-muted); }
    .search-results mark {
      background: #FFF1A8;
      color: inherit;
      border-radius: 2px;
      padding: 0 1px;
    }
    @media (prefers-color-scheme: dark) {
      .search-results mark { background: #6b5a00; color: #fff; }
    }
  `
  document.head.appendChild(style)
}
