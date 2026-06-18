import { fetchNotes, type Note } from '../lib/notes'
import { renderTopbar, attachTopbar } from '../lib/nav'
import { navigateTo } from '../router'

interface Source {
  url: string | null
  title: string | null
  author: string | null
  notes: Note[]
}

export async function renderSources(app: HTMLElement): Promise<void> {
  app.innerHTML = `
    ${renderTopbar('Bronnen', 'sources')}
    <div class="sources-body">
      <div class="sources-loading">Laden…</div>
    </div>
    <div class="toast" id="toast"></div>
  `

  injectSourcesStyles()
  attachTopbar()

  const body = document.querySelector('.sources-body') as HTMLDivElement

  try {
    // Fetch all notes to group by source
    const notes = await fetchNotes(0, 500)
    const { sourced, unsourced } = groupBySources(notes)

    if (sourced.length === 0 && unsourced.length === 0) {
      body.innerHTML = '<div class="sources-empty"><p class="muted">Nog geen nota\'s met bronnen. Voeg bronvelden toe via de inbox.</p></div>'
      return
    }

    body.innerHTML = `
      ${sourced.length > 0 ? `
        <section class="sources-section">
          <header class="sources-section-header">
            <h2>Bronnen (${sourced.length})</h2>
            <span class="muted">${sourced.reduce((n, s) => n + s.notes.length, 0)} nota's met bron</span>
          </header>
          <div class="sources-list">
            ${sourced.map(source => renderSourceCard(source)).join('')}
          </div>
        </section>
      ` : ''}

      ${unsourced.length > 0 ? `
        <section class="sources-section">
          <details class="unsourced-details">
            <summary class="sources-section-header">
              <h2>Zonder bron (${unsourced.length})</h2>
              <span class="muted">klik om te tonen</span>
            </summary>
            <div class="unsourced-list">
              ${unsourced.map(n => renderUnsourcedRow(n)).join('')}
            </div>
          </details>
        </section>
      ` : ''}
    `

    // Wire up click-through to inbox with filter
    body.querySelectorAll<HTMLElement>('[data-note-content]').forEach(el => {
      el.addEventListener('click', () => {
        // Navigate to inbox; for now just show the inbox
        navigateTo('/inbox')
      })
    })

  } catch (err) {
    body.innerHTML = `<div class="sources-error">Laden mislukt: ${escHtml(errMsg(err))}</div>`
  }
}

function groupBySources(notes: Note[]): { sourced: Source[]; unsourced: Note[] } {
  const map = new Map<string, Source>()
  const unsourced: Note[] = []

  for (const note of notes) {
    if (!note.source_url && !note.source_title && !note.source_author) {
      unsourced.push(note)
      continue
    }
    // Key by url if present, otherwise by title
    const key = note.source_url ?? note.source_title ?? note.source_author ?? '__unknown__'
    if (!map.has(key)) {
      map.set(key, {
        url: note.source_url,
        title: note.source_title,
        author: note.source_author,
        notes: []
      })
    }
    map.get(key)!.notes.push(note)
  }

  const sourced = Array.from(map.values()).sort((a, b) => b.notes.length - a.notes.length)
  return { sourced, unsourced }
}

function renderSourceCard(source: Source): string {
  const displayTitle = source.title ?? source.url ?? 'Onbekende bron'
  const authorLine = source.author ? `<span class="source-author">${escHtml(source.author)}</span>` : ''
  const urlLine = source.url
    ? `<a class="source-url" href="${escHtml(source.url)}" target="_blank" rel="noopener">${escHtml(source.url.slice(0, 60))}${source.url.length > 60 ? '…' : ''}</a>`
    : ''

  return `
    <details class="source-card">
      <summary class="source-summary">
        <span class="source-title">${escHtml(displayTitle)}</span>
        ${authorLine}
        <span class="source-count">${source.notes.length} nota${source.notes.length === 1 ? '' : "'s"}</span>
      </summary>
      <div class="source-body">
        ${urlLine ? `<div class="source-meta">${urlLine}</div>` : ''}
        <div class="source-notes-list">
          ${source.notes.map(n => `
            <div class="source-note-row">
              <span class="source-note-title">${escHtml(n.ai_title ?? n.content.slice(0, 80))}</span>
              <span class="source-note-status source-status-${n.status}">${statusLabel(n.status)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    </details>
  `
}

function renderUnsourcedRow(note: Note): string {
  return `
    <div class="unsourced-row">
      <span class="unsourced-content">${escHtml(note.ai_title ?? note.content.slice(0, 80))}</span>
      <span class="source-note-status source-status-${note.status}">${statusLabel(note.status)}</span>
    </div>
  `
}

function statusLabel(status: string): string {
  if (status === 'inbox')    return 'inbox'
  if (status === 'verwerkt') return 'verwerkt'
  if (status === 'archief')  return 'archief'
  return status
}

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'onbekende fout'
}

function injectSourcesStyles(): void {
  if (document.getElementById('sources-styles')) return
  const style = document.createElement('style')
  style.id = 'sources-styles'
  style.textContent = `
    .sources-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: var(--s-4);
      padding: var(--s-4);
      max-width: 760px;
      width: 100%;
      margin: 0 auto;
    }
    .sources-section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-4);
    }
    .sources-section-header {
      display: flex;
      align-items: baseline;
      gap: var(--s-3);
      margin-bottom: var(--s-3);
      flex-wrap: wrap;
      list-style: none;
      cursor: pointer;
    }
    .sources-section-header h2 {
      font-size: var(--fs-lg);
      font-weight: 600;
    }
    .sources-section-header::-webkit-details-marker { display: none; }
    .sources-list {
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }
    .source-card {
      border: 1px solid var(--border);
      border-radius: var(--r-sm);
      overflow: hidden;
      background: var(--bg);
    }
    .source-summary {
      list-style: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: var(--s-3);
      padding: var(--s-3);
      flex-wrap: wrap;
    }
    .source-summary::-webkit-details-marker { display: none; }
    .source-title {
      flex: 1;
      font-weight: 500;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .source-author {
      font-size: var(--fs-sm);
      color: var(--text-muted);
    }
    .source-count {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      white-space: nowrap;
    }
    .source-body {
      padding: var(--s-3);
      border-top: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }
    .source-meta {}
    .source-url {
      font-size: var(--fs-sm);
      color: var(--accent);
      word-break: break-all;
    }
    .source-notes-list {
      display: flex;
      flex-direction: column;
      gap: var(--s-1);
    }
    .source-note-row {
      display: flex;
      align-items: center;
      gap: var(--s-2);
      padding: var(--s-1) 0;
    }
    .source-note-title {
      flex: 1;
      font-size: var(--fs-sm);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .source-note-status {
      font-size: 11px;
      padding: 2px var(--s-2);
      border-radius: var(--r-sm);
      font-weight: 500;
      white-space: nowrap;
    }
    .source-status-inbox    { background: #E8F0FF; color: #1A3A8B; }
    .source-status-verwerkt { background: #E8F5EE; color: #1A6B40; }
    .source-status-archief  { background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); }
    .unsourced-details { }
    .unsourced-list {
      display: flex;
      flex-direction: column;
      gap: var(--s-1);
      margin-top: var(--s-3);
    }
    .unsourced-row {
      display: flex;
      align-items: center;
      gap: var(--s-2);
      padding: var(--s-1) 0;
      font-size: var(--fs-sm);
      color: var(--text-muted);
    }
    .unsourced-content {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sources-loading,
    .sources-error,
    .sources-empty {
      text-align: center;
      padding: var(--s-7);
      color: var(--text-muted);
    }
    .muted { color: var(--text-muted); font-size: var(--fs-sm); }
  `
  document.head.appendChild(style)
}
