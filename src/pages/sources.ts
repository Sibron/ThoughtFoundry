import { fetchSources, createSource, updateSource, deleteSource, SOURCE_TYPES, SOURCE_TYPE_ORDER, type Source, type SourceInsert, type SourceType } from '../lib/sources'
import { fetchNotes, type Note } from '../lib/notes'
import { renderTopbar, attachTopbar } from '../lib/nav'

export async function renderSources(app: HTMLElement): Promise<void> {
  app.innerHTML = `
    ${renderTopbar('Bronnen', 'sources')}
    <div id="src-root"></div>
    <div class="toast" id="toast"></div>
  `
  attachTopbar()
  await mountSources(document.getElementById('src-root')!)
}

export async function mountSources(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="src-body" id="src-body">
      <div class="src-loading">Laden…</div>
    </div>
  `
  injectStyles()
  await reload()
}

async function reload(): Promise<void> {
  const body = document.getElementById('src-body') as HTMLDivElement
  body.innerHTML = '<div class="src-loading">Laden…</div>'
  try {
    const [sources, allNotes] = await Promise.all([fetchSources(), fetchNotes(0, 500)])
    mount(body, sources, allNotes)
  } catch (err) {
    body.innerHTML = `<div class="src-loading">Laden mislukt: ${esc(msg(err))}</div>`
  }
}

function mount(body: HTMLDivElement, sources: Source[], allNotes: Note[]): void {
  let editing: Source | null = null
  let detailSourceId: string | null = null
  let typeFilter: SourceType | 'all' = 'all'
  let searchText = ''
  let formData: SourceInsert & { type: SourceType } = emptyForm()

  const notesBySource = new Map<string, Note[]>()
  for (const note of allNotes) {
    if (note.source_id) {
      const arr = notesBySource.get(note.source_id) ?? []
      arr.push(note)
      notesBySource.set(note.source_id, arr)
    }
  }

  const render = () => {
    if (detailSourceId) {
      renderDetail()
    } else {
      renderList()
    }
  }

  const renderList = () => {
    const filtered = sources.filter(s => {
      if (typeFilter !== 'all' && s.type !== typeFilter) return false
      if (searchText) {
        const hay = [s.title, s.author, s.summary, ...(s.tags ?? [])].filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(searchText.toLowerCase())) return false
      }
      return true
    })

    body.innerHTML = `
      <div class="src-layout">
        <aside class="src-sidebar">
          <div class="src-form-wrap">
            <h2>${editing ? 'Bron bewerken' : 'Nieuwe bron'}</h2>
            ${renderForm(formData, editing)}
          </div>
        </aside>
        <main class="src-main">
          <div class="src-toolbar">
            <input type="text" id="src-search" class="src-search" placeholder="Zoeken…" value="${esc(searchText)}" />
            <div class="src-type-pills">
              <button class="src-pill${typeFilter === 'all' ? ' active' : ''}" data-type="all">Alle</button>
              ${SOURCE_TYPE_ORDER.map(t =>
                `<button class="src-pill${typeFilter === t ? ' active' : ''}" data-type="${t}">${SOURCE_TYPES[t].label}</button>`
              ).join('')}
            </div>
          </div>
          ${filtered.length === 0
            ? `<p class="src-empty">${sources.length === 0 ? 'Nog geen bronnen. Voeg er een toe via het formulier.' : 'Geen bronnen gevonden.'}</p>`
            : `<div class="src-list">${filtered.map(s => renderCard(s, notesBySource.get(s.id)?.length ?? 0)).join('')}</div>`
          }
        </main>
      </div>
    `
    wireListEvents()
  }

  const renderDetail = () => {
    const source = sources.find(s => s.id === detailSourceId)
    if (!source) { detailSourceId = null; renderList(); return }
    const notes = notesBySource.get(source.id) ?? []
    const meta = SOURCE_TYPES[source.type]
    body.innerHTML = `
      <div class="src-detail-wrap">
        <button class="btn btn-ghost src-back" id="src-back">← Terug</button>
        <div class="src-detail">
          <div class="src-detail-header">
            <span class="src-type-badge">${esc(meta.label)}</span>
            <h2 class="src-detail-title">${esc(source.title)}</h2>
            ${source.author ? `<p class="src-detail-author">${esc(source.author)}${source.year ? ` · ${esc(source.year)}` : ''}</p>` : ''}
            ${source.url ? `<a class="src-detail-url" href="${esc(source.url)}" target="_blank" rel="noopener">${esc(source.url.slice(0, 70))}${source.url.length > 70 ? '…' : ''}</a>` : ''}
            ${source.summary ? `<p class="src-detail-summary">${esc(source.summary)}</p>` : ''}
            ${(source.tags ?? []).length ? `<div class="src-detail-tags">${source.tags.map(t => `<span class="badge">${esc(t)}</span>`).join('')}</div>` : ''}
          </div>
          <div class="src-detail-actions">
            <button class="btn btn-ghost" id="src-edit-btn">Bewerken</button>
            <button class="btn btn-danger" id="src-delete-btn">Verwijderen</button>
          </div>
          <section class="src-detail-notes">
            <h3>${notes.length} nota${notes.length === 1 ? '' : "'s"}</h3>
            ${notes.length === 0
              ? '<p class="muted">Nog geen nota\'s gekoppeld aan deze bron.</p>'
              : notes.map(n => `
                <div class="src-note-row">
                  <span class="src-note-title">${esc(n.ai_title ?? n.core_idea ?? n.content.slice(0, 80))}</span>
                  <span class="badge badge-${n.status}">${esc(n.status)}</span>
                </div>
              `).join('')
            }
          </section>
        </div>
      </div>
    `
    document.getElementById('src-back')?.addEventListener('click', () => { detailSourceId = null; render() })
    document.getElementById('src-edit-btn')?.addEventListener('click', () => {
      editing = source
      formData = {
        title: source.title, author: source.author ?? '', type: source.type,
        year: source.year ?? '', url: source.url ?? '',
        summary: source.summary ?? '', tags: source.tags ?? []
      }
      detailSourceId = null
      render()
    })
    document.getElementById('src-delete-btn')?.addEventListener('click', async () => {
      if (!confirm(`Bron "${source.title}" verwijderen? Nota's die eraan gekoppeld zijn verliezen de koppeling, maar blijven bestaan.`)) return
      try {
        await deleteSource(source.id)
        const idx = sources.findIndex(s => s.id === source.id)
        if (idx !== -1) sources.splice(idx, 1)
        detailSourceId = null
        showToast('Bron verwijderd')
        render()
      } catch { showToast('Verwijderen mislukt') }
    })
  }

  const wireListEvents = () => {
    document.getElementById('src-search')?.addEventListener('input', (e) => {
      searchText = (e.target as HTMLInputElement).value
      render()
    })

    document.querySelectorAll<HTMLButtonElement>('[data-type]').forEach(btn => {
      btn.addEventListener('click', () => {
        typeFilter = btn.dataset['type'] as SourceType | 'all'
        render()
      })
    })

    document.querySelectorAll<HTMLElement>('[data-source-id]').forEach(el => {
      el.addEventListener('click', () => {
        detailSourceId = el.dataset['sourceId']!
        render()
      })
    })

    document.getElementById('src-form')?.addEventListener('submit', async (e) => {
      e.preventDefault()
      const form = e.target as HTMLFormElement
      const get = (id: string) => (form.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)?.value.trim() ?? ''
      const input: SourceInsert & { type: SourceType } = {
        title: get('sf-title'),
        author: get('sf-author') || undefined,
        type: (get('sf-type') as SourceType) || 'book',
        year: get('sf-year') || undefined,
        url: get('sf-url') || undefined,
        summary: get('sf-summary') || undefined,
        tags: get('sf-tags').split(',').map(t => t.trim()).filter(Boolean)
      }
      if (!input.title) { showToast('Titel is verplicht'); return }
      const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
      submitBtn.disabled = true
      try {
        if (editing) {
          const updated = await updateSource(editing.id, input)
          const idx = sources.findIndex(s => s.id === editing!.id)
          if (idx !== -1) sources[idx] = updated
          editing = null
          showToast('Bron bijgewerkt')
        } else {
          const created = await createSource(input)
          sources.unshift(created)
          showToast('Bron aangemaakt')
        }
        formData = emptyForm()
        render()
      } catch (err) {
        showToast(`Mislukt: ${msg(err)}`)
      } finally {
        submitBtn.disabled = false
      }
    })

    document.getElementById('sf-cancel')?.addEventListener('click', () => {
      editing = null
      formData = emptyForm()
      render()
    })
  }

  render()
}

function renderCard(source: Source, noteCount: number): string {
  const meta = SOURCE_TYPES[source.type]
  return `
    <div class="src-card" data-source-id="${source.id}" role="button" tabindex="0">
      <div class="src-card-type">${esc(meta.label)}</div>
      <div class="src-card-title">${esc(source.title)}</div>
      ${source.author ? `<div class="src-card-author">${esc(source.author)}${source.year ? ` · ${esc(source.year)}` : ''}</div>` : ''}
      <div class="src-card-count">${noteCount} nota${noteCount === 1 ? '' : "'s"}</div>
    </div>
  `
}

function renderForm(data: SourceInsert & { type: SourceType }, editing: Source | null): string {
  const tagsVal = (data.tags ?? []).join(', ')
  return `
    <form id="src-form" class="src-form" novalidate>
      <div class="sf-field">
        <label class="sf-label" for="sf-title">Titel *</label>
        <input id="sf-title" type="text" value="${esc(data.title ?? '')}" required />
      </div>
      <div class="sf-row">
        <div class="sf-field">
          <label class="sf-label" for="sf-author">Auteur</label>
          <input id="sf-author" type="text" value="${esc(data.author ?? '')}" />
        </div>
        <div class="sf-field">
          <label class="sf-label" for="sf-year">Jaar</label>
          <input id="sf-year" type="text" value="${esc(data.year ?? '')}" style="width:80px" />
        </div>
      </div>
      <div class="sf-field">
        <label class="sf-label" for="sf-type">Type</label>
        <select id="sf-type">
          ${SOURCE_TYPE_ORDER.map(t =>
            `<option value="${t}" ${data.type === t ? 'selected' : ''}>${SOURCE_TYPES[t].label}</option>`
          ).join('')}
        </select>
      </div>
      <div class="sf-field">
        <label class="sf-label" for="sf-url">URL</label>
        <input id="sf-url" type="url" value="${esc(data.url ?? '')}" />
      </div>
      <div class="sf-field">
        <label class="sf-label" for="sf-summary">Samenvatting</label>
        <textarea id="sf-summary" rows="3">${esc(data.summary ?? '')}</textarea>
      </div>
      <div class="sf-field">
        <label class="sf-label" for="sf-tags">Tags (kommagescheiden)</label>
        <input id="sf-tags" type="text" value="${esc(tagsVal)}" />
      </div>
      <div class="sf-actions">
        <button type="submit" class="btn btn-primary">${editing ? 'Opslaan' : 'Aanmaken'}</button>
        ${editing ? `<button type="button" class="btn btn-ghost" id="sf-cancel">Annuleren</button>` : ''}
      </div>
    </form>
  `
}

function emptyForm(): SourceInsert & { type: SourceType } {
  return { title: '', author: '', type: 'book', year: '', url: '', summary: '', tags: [] }
}

function showToast(msg: string): void {
  const t = document.getElementById('toast') as HTMLDivElement | null
  if (!t) return
  t.textContent = msg
  t.classList.add('show')
  setTimeout(() => t.classList.remove('show'), 2500)
}

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : 'onbekende fout'
}

function injectStyles(): void {
  if (document.getElementById('src-styles')) return
  const style = document.createElement('style')
  style.id = 'src-styles'
  style.textContent = `
    .src-body {
      flex: 1;
      padding: var(--s-4);
      padding-bottom: calc(var(--bottom-nav-h) + var(--s-4));
      max-width: 1100px;
      width: 100%;
      margin: 0 auto;
    }
    .src-loading {
      text-align: center;
      padding: var(--s-7);
      color: var(--text-muted);
    }
    .src-layout {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: var(--s-5);
      align-items: start;
    }
    @media (max-width: 720px) {
      .src-layout { grid-template-columns: 1fr; }
    }
    .src-sidebar {
      position: sticky;
      top: var(--s-4);
    }
    .src-form-wrap {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-4);
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
    }
    .src-form-wrap h2 { font-size: var(--fs-lg); font-weight: 600; }
    .src-form { display: flex; flex-direction: column; gap: var(--s-3); }
    .sf-field { display: flex; flex-direction: column; gap: var(--s-1); }
    .sf-label { font-size: var(--fs-sm); color: var(--text-muted); font-weight: 500; }
    .sf-row { display: grid; grid-template-columns: 1fr auto; gap: var(--s-2); }
    .sf-actions { display: flex; gap: var(--s-2); flex-wrap: wrap; }
    .sf-actions .btn { width: auto; }
    .src-main { display: flex; flex-direction: column; gap: var(--s-3); }
    .src-toolbar { display: flex; flex-direction: column; gap: var(--s-2); }
    .src-search { width: 100%; }
    .src-type-pills { display: flex; gap: var(--s-1); flex-wrap: wrap; }
    .src-pill {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-sm);
      padding: 4px var(--s-3);
      font-size: var(--fs-sm);
      cursor: pointer;
      color: var(--text-muted);
    }
    .src-pill.active {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    .src-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: var(--s-3); }
    .src-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-3);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: var(--s-1);
      transition: border-color 0.15s;
    }
    .src-card:hover { border-color: var(--accent); }
    .src-card-type { font-size: 11px; color: var(--accent); text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
    .src-card-title { font-size: var(--fs-base); font-weight: 500; color: var(--text); }
    .src-card-author { font-size: var(--fs-sm); color: var(--text-muted); }
    .src-card-count { font-size: var(--fs-sm); color: var(--text-muted); margin-top: var(--s-1); }
    .src-empty { color: var(--text-muted); font-size: var(--fs-sm); text-align: center; padding: var(--s-7) 0; }
    .src-detail-wrap { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--s-4); }
    .src-back { width: auto; }
    .src-detail { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md); padding: var(--s-5); }
    .src-detail-header { display: flex; flex-direction: column; gap: var(--s-2); margin-bottom: var(--s-4); }
    .src-type-badge { font-size: 11px; color: var(--accent); text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
    .src-detail-title { font-size: var(--fs-xl); font-weight: 600; color: var(--text); }
    .src-detail-author { font-size: var(--fs-sm); color: var(--text-muted); }
    .src-detail-url { font-size: var(--fs-sm); color: var(--accent); word-break: break-all; }
    .src-detail-summary { font-size: var(--fs-base); color: var(--text); line-height: 1.6; white-space: pre-wrap; }
    .src-detail-tags { display: flex; gap: var(--s-1); flex-wrap: wrap; }
    .src-detail-actions { display: flex; gap: var(--s-2); margin-bottom: var(--s-4); }
    .src-detail-actions .btn { width: auto; }
    .src-detail-notes h3 { font-size: var(--fs-base); font-weight: 600; margin-bottom: var(--s-3); }
    .src-note-row {
      display: flex; align-items: center; gap: var(--s-2);
      padding: var(--s-2) 0; border-bottom: 1px solid var(--border);
    }
    .src-note-row:last-child { border-bottom: none; }
    .src-note-title { flex: 1; font-size: var(--fs-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .muted { color: var(--text-muted); font-size: var(--fs-sm); }
  `
  document.head.appendChild(style)
}
