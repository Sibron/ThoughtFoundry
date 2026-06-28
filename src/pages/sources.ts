import { fetchSources, createSource, updateSource, deleteSource, SOURCE_TYPES, SOURCE_TYPE_ORDER, type Source, type SourceInsert, type SourceType } from '../lib/sources'
import { fetchAllNotes, type Note } from '../lib/notes'
import { renderTopbar, attachTopbar } from '../lib/nav'
import { createCrudList, injectCrudStyles, showToast, esc, errMsg, type CrudListConfig } from '../lib/crud-list'

type SourceForm = SourceInsert & { type: SourceType }

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
    <div class="crud-body" id="src-body">
      <div class="crud-loading">Laden…</div>
    </div>
  `
  injectCrudStyles()
  injectSourceStyles()
  await reload()
}

async function reload(): Promise<void> {
  const body = document.getElementById('src-body') as HTMLDivElement
  body.innerHTML = '<div class="crud-loading">Laden…</div>'
  try {
    const [sources, allNotes] = await Promise.all([fetchSources(), fetchAllNotes()])
    mount(body, sources, allNotes)
  } catch (err) {
    body.innerHTML = `<div class="crud-loading">Laden mislukt: ${esc(errMsg(err))}</div>`
  }
}

function mount(body: HTMLDivElement, sources: Source[], allNotes: Note[]): void {
  let typeFilter: SourceType | 'all' = 'all'
  let searchText = ''

  const notesBySource = new Map<string, Note[]>()
  for (const note of allNotes) {
    if (note.source_id) {
      const arr = notesBySource.get(note.source_id) ?? []
      arr.push(note)
      notesBySource.set(note.source_id, arr)
    }
  }

  const config: CrudListConfig<Source, SourceForm> = {
    newTitle: 'Nieuwe bron',
    editTitle: 'Bron bewerken',
    createdMsg: 'Bron aangemaakt',
    updatedMsg: 'Bron bijgewerkt',
    emptyForm,
    idOf: (s) => s.id,
    toForm: (s) => ({
      title: s.title, author: s.author ?? '', type: s.type,
      year: s.year ?? '', url: s.url ?? '',
      summary: s.summary ?? '', tags: s.tags ?? []
    }),
    renderForm,
    parseForm: (form) => {
      const get = (id: string) => (form.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)?.value.trim() ?? ''
      const input: SourceForm = {
        title: get('sf-title'),
        author: get('sf-author') || undefined,
        type: (get('sf-type') as SourceType) || 'book',
        year: get('sf-year') || undefined,
        url: get('sf-url') || undefined,
        summary: get('sf-summary') || undefined,
        tags: get('sf-tags').split(',').map(t => t.trim()).filter(Boolean)
      }
      if (!input.title) { showToast('Titel is verplicht'); return null }
      return input
    },
    create: createSource,
    update: updateSource,
    renderMain: (items) => {
      const filtered = items.filter(s => {
        if (typeFilter !== 'all' && s.type !== typeFilter) return false
        if (searchText) {
          const hay = [s.title, s.author, s.summary, ...(s.tags ?? [])].filter(Boolean).join(' ').toLowerCase()
          if (!hay.includes(searchText.toLowerCase())) return false
        }
        return true
      })
      return `
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
          ? `<p class="crud-empty">${items.length === 0 ? 'Nog geen bronnen. Voeg er een toe via het formulier.' : 'Geen bronnen gevonden.'}</p>`
          : `<div class="src-list">${filtered.map(s => renderCard(s, notesBySource.get(s.id)?.length ?? 0)).join('')}</div>`
        }
      `
    },
    wireMain: (rerender) => {
      document.getElementById('src-search')?.addEventListener('input', (e) => {
        searchText = (e.target as HTMLInputElement).value
        rerender()
      })
      document.querySelectorAll<HTMLButtonElement>('[data-type]').forEach(btn => {
        btn.addEventListener('click', () => {
          typeFilter = btn.dataset['type'] as SourceType | 'all'
          rerender()
        })
      })
    },
    renderDetail: (source, host, ctx) => {
      const notes = notesBySource.get(source.id) ?? []
      const meta = SOURCE_TYPES[source.type]
      host.innerHTML = `
        <div class="crud-detail-wrap">
          <button class="btn btn-ghost crud-back" id="src-back">← Terug</button>
          <div class="crud-detail">
            <div class="crud-detail-header">
              <span class="src-type-badge">${esc(meta.label)}</span>
              <h2 class="crud-detail-title">${esc(source.title)}</h2>
              ${source.author ? `<p class="src-detail-author">${esc(source.author)}${source.year ? ` · ${esc(source.year)}` : ''}</p>` : ''}
              ${source.url ? `<a class="src-detail-url" href="${esc(source.url)}" target="_blank" rel="noopener">${esc(source.url.slice(0, 70))}${source.url.length > 70 ? '…' : ''}</a>` : ''}
              ${source.summary ? `<p class="src-detail-summary">${esc(source.summary)}</p>` : ''}
              ${(source.tags ?? []).length ? `<div class="src-detail-tags">${source.tags.map(t => `<span class="badge">${esc(t)}</span>`).join('')}</div>` : ''}
            </div>
            <div class="crud-detail-actions">
              <button class="btn btn-ghost" id="src-edit-btn">Bewerken</button>
              <button class="btn btn-danger" id="src-delete-btn">Verwijderen</button>
            </div>
            <section class="src-detail-notes">
              <h3>${notes.length} nota${notes.length === 1 ? '' : "'s"}</h3>
              ${notes.length === 0
                ? '<p class="muted">Nog geen nota\'s gekoppeld aan deze bron.</p>'
                : notes.map(n => `
                  <div class="crud-note-row">
                    <span class="crud-note-title">${esc(n.ai_title ?? n.core_idea ?? n.content.slice(0, 80))}</span>
                    <span class="badge badge-${n.status}">${esc(n.status)}</span>
                  </div>
                `).join('')
              }
            </section>
          </div>
        </div>
      `
      document.getElementById('src-back')?.addEventListener('click', () => ctx.back())
      document.getElementById('src-edit-btn')?.addEventListener('click', () => ctx.edit(source))
      document.getElementById('src-delete-btn')?.addEventListener('click', async () => {
        if (!confirm(`Bron "${source.title}" verwijderen? Nota's die eraan gekoppeld zijn verliezen de koppeling, maar blijven bestaan.`)) return
        try {
          await deleteSource(source.id)
          showToast('Bron verwijderd')
          ctx.remove(source.id)
        } catch { showToast('Verwijderen mislukt') }
      })
    }
  }

  createCrudList(config, sources).mount(body)
}

function renderCard(source: Source, noteCount: number): string {
  const meta = SOURCE_TYPES[source.type]
  return `
    <div class="crud-card" data-crud-id="${source.id}" role="button" tabindex="0">
      <div class="src-card-type">${esc(meta.label)}</div>
      <div class="src-card-title">${esc(source.title)}</div>
      ${source.author ? `<div class="src-card-author">${esc(source.author)}${source.year ? ` · ${esc(source.year)}` : ''}</div>` : ''}
      <div class="src-card-count">${noteCount} nota${noteCount === 1 ? '' : "'s"}</div>
    </div>
  `
}

function renderForm(data: SourceForm, editing: boolean): string {
  const tagsVal = (data.tags ?? []).join(', ')
  return `
    <form id="crud-form" class="crud-form" novalidate>
      <div class="crud-field">
        <label class="crud-label" for="sf-title">Titel *</label>
        <input id="sf-title" type="text" value="${esc(data.title ?? '')}" required />
      </div>
      <div class="crud-row">
        <div class="crud-field">
          <label class="crud-label" for="sf-author">Auteur</label>
          <input id="sf-author" type="text" value="${esc(data.author ?? '')}" />
        </div>
        <div class="crud-field">
          <label class="crud-label" for="sf-year">Jaar</label>
          <input id="sf-year" type="text" value="${esc(data.year ?? '')}" style="width:80px" />
        </div>
      </div>
      <div class="crud-field">
        <label class="crud-label" for="sf-type">Type</label>
        <select id="sf-type">
          ${SOURCE_TYPE_ORDER.map(t =>
            `<option value="${t}" ${data.type === t ? 'selected' : ''}>${SOURCE_TYPES[t].label}</option>`
          ).join('')}
        </select>
      </div>
      <div class="crud-field">
        <label class="crud-label" for="sf-url">URL</label>
        <input id="sf-url" type="url" value="${esc(data.url ?? '')}" />
      </div>
      <div class="crud-field">
        <label class="crud-label" for="sf-summary">Samenvatting</label>
        <textarea id="sf-summary" rows="3">${esc(data.summary ?? '')}</textarea>
      </div>
      <div class="crud-field">
        <label class="crud-label" for="sf-tags">Tags (kommagescheiden)</label>
        <input id="sf-tags" type="text" value="${esc(tagsVal)}" />
      </div>
      <div class="crud-actions">
        <button type="submit" class="btn btn-primary">${editing ? 'Opslaan' : 'Aanmaken'}</button>
        ${editing ? `<button type="button" class="btn btn-ghost" id="crud-cancel">Annuleren</button>` : ''}
      </div>
    </form>
  `
}

function emptyForm(): SourceForm {
  return { title: '', author: '', type: 'book', year: '', url: '', summary: '', tags: [] }
}

function injectSourceStyles(): void {
  if (document.getElementById('src-styles')) return
  const style = document.createElement('style')
  style.id = 'src-styles'
  style.textContent = `
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
    .src-card-type { font-size: 11px; color: var(--accent); text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
    .src-card-title { font-size: var(--fs-base); font-weight: 500; color: var(--text); }
    .src-card-author { font-size: var(--fs-sm); color: var(--text-muted); }
    .src-card-count { font-size: var(--fs-sm); color: var(--text-muted); margin-top: var(--s-1); }
    .src-type-badge { font-size: 11px; color: var(--accent); text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
    .src-detail-author { font-size: var(--fs-sm); color: var(--text-muted); }
    .src-detail-url { font-size: var(--fs-sm); color: var(--accent); word-break: break-all; }
    .src-detail-summary { font-size: var(--fs-base); color: var(--text); line-height: 1.6; white-space: pre-wrap; }
    .src-detail-tags { display: flex; gap: var(--s-1); flex-wrap: wrap; }
    .src-detail-notes h3 { font-size: var(--fs-base); font-weight: 600; margin-bottom: var(--s-3); }
  `
  document.head.appendChild(style)
}
