import { fetchNotes, type Note } from '../lib/notes'
import { renderTopbar, attachTopbar } from '../lib/nav'
import { navigateTo } from '../router'

// Fast full-text search across content / title / summary. The single most
// important re-finding tool: "I know I wrote this down somewhere" must always
// resolve in one screen, or trust in the system collapses.

export async function renderSearch(app: HTMLElement): Promise<void> {
  app.innerHTML = `
    ${renderTopbar('Zoeken', 'search')}
    <div class="search-body">
      <input
        type="text"
        id="search-input"
        class="search-input"
        placeholder="Zoek in al je notities…"
        autocomplete="off"
        autocapitalize="off"
      />
      <div id="search-results" class="search-results">
        <p class="search-hint">Typ om te zoeken in content, titel en samenvatting.</p>
      </div>
    </div>
    <div class="toast" id="toast"></div>
  `

  injectSearchStyles()
  attachTopbar()

  const input = document.getElementById('search-input') as HTMLInputElement
  const resultsEl = document.getElementById('search-results') as HTMLDivElement
  let debounce: ReturnType<typeof setTimeout> | null = null
  let lastQuery = ''

  // Allow ?q= deep-links (e.g. from a shortcut) to pre-fill the search.
  const hash = window.location.hash.slice(1)
  const qIndex = hash.indexOf('?')
  if (qIndex !== -1) {
    const preset = new URLSearchParams(hash.slice(qIndex + 1)).get('q')
    if (preset) input.value = preset
  }

  input.focus()

  const run = async () => {
    const q = input.value.trim()
    lastQuery = q
    if (q.length < 2) {
      resultsEl.innerHTML = '<p class="search-hint">Typ om te zoeken in content, titel en samenvatting.</p>'
      return
    }
    resultsEl.innerHTML = '<p class="search-hint">Zoeken…</p>'
    try {
      const notes = await fetchNotes(0, 50, undefined, q)
      if (q !== lastQuery) return // a newer query already superseded this one
      renderResults(notes, q)
    } catch (err) {
      resultsEl.innerHTML = `<p class="search-hint">Zoeken mislukt: ${escHtml(errMsg(err))}</p>`
    }
  }

  input.addEventListener('input', () => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(run, 220)
  })

  if (input.value.trim()) run()

  function renderResults(notes: Note[], q: string): void {
    if (notes.length === 0) {
      resultsEl.innerHTML = `<p class="search-hint">Niets gevonden voor "${escHtml(q)}".</p>`
      return
    }
    resultsEl.innerHTML = `
      <p class="search-count">${notes.length} resultaat${notes.length === 1 ? '' : 'en'}</p>
      <ul class="search-list">
        ${notes.map(n => {
          const title = n.ai_title ?? n.content.slice(0, 70)
          const snippet = highlight(snippetAround(n.content, q), q)
          return `
            <li class="search-item" data-id="${n.id}">
              <div class="search-item-title">${highlight(escHtml(title), q)}</div>
              <div class="search-item-snippet">${snippet}</div>
              <div class="search-item-meta">
                <span class="badge badge-${n.status}">${escHtml(n.status)}</span>
                <span class="search-item-date">${formatDate(n.created_at)}</span>
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

/** Pull a ~160-char window of content centred on the first match. */
function snippetAround(content: string, q: string): string {
  const lower = content.toLowerCase()
  const idx = lower.indexOf(q.toLowerCase())
  if (idx === -1) return escHtml(content.slice(0, 160)) + (content.length > 160 ? '…' : '')
  const start = Math.max(0, idx - 60)
  const end = Math.min(content.length, idx + q.length + 100)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < content.length ? '…' : ''
  return escHtml(prefix + content.slice(start, end) + suffix)
}

/** Wrap matches of q (already-escaped haystack) in <mark>. */
function highlight(escaped: string, q: string): string {
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try {
    return escaped.replace(new RegExp(`(${safe})`, 'gi'), '<mark>$1</mark>')
  } catch {
    return escaped
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' })
}

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'onbekende fout'
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
