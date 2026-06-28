import {
  fetchProjects, createProject, updateProject, deleteProject,
  fetchProjectNoteIds,
  BOOK_STATUSES, type BookProject, type BookProjectInsert, type ProjectStatus
} from '../lib/projects'
import { fetchNotesByIds, type Note } from '../lib/notes'
import { renderTopbar, attachTopbar, isAiEnabled } from '../lib/nav'
import { getPersona } from '../lib/persona'
import { supabase } from '../lib/supabase'
import { getCostStatus } from '../lib/cost'
import { createCrudList, injectCrudStyles, showToast, esc, errMsg, type CrudListConfig, type CrudDetailCtx } from '../lib/crud-list'

type ProjectForm = BookProjectInsert & { status: ProjectStatus }

export async function renderProjects(app: HTMLElement): Promise<void> {
  app.innerHTML = `
    ${renderTopbar('Projecten', 'projects')}
    <div id="proj-root"></div>
    <div class="toast" id="toast"></div>
  `
  attachTopbar()
  await mountProjects(document.getElementById('proj-root')!)
}

export async function mountProjects(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="crud-body" id="proj-body">
      <div class="crud-loading">Laden…</div>
    </div>
  `
  injectCrudStyles()
  injectProjectStyles()
  await reloadProjects()
}

async function reloadProjects(): Promise<void> {
  const body = document.getElementById('proj-body') as HTMLDivElement
  body.innerHTML = '<div class="crud-loading">Laden…</div>'
  try {
    const projects = await fetchProjects()
    mount(body, projects)
  } catch (err) {
    body.innerHTML = `<div class="crud-loading">Laden mislukt: ${esc(errMsg(err))}</div>`
  }
}

function mount(body: HTMLDivElement, projects: BookProject[]): void {
  const config: CrudListConfig<BookProject, ProjectForm> = {
    newTitle: 'Nieuw project',
    editTitle: 'Project bewerken',
    createdMsg: 'Project aangemaakt',
    updatedMsg: 'Project bijgewerkt',
    emptyForm,
    idOf: (p) => p.id,
    toForm: (p) => ({
      title: p.title,
      core_question: p.core_question,
      description: p.description ?? '',
      status: p.status
    }),
    renderForm,
    parseForm: (form) => {
      const get = (id: string) => (form.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement)?.value.trim() ?? ''
      const input: ProjectForm = {
        title: get('pf-title'),
        core_question: get('pf-question'),
        description: get('pf-desc') || undefined,
        status: (form.querySelector('[name="pf-status"]:checked') as HTMLInputElement)?.value as ProjectStatus ?? 'exploring'
      }
      if (!input.title || !input.core_question) { showToast('Titel en kernvraag zijn verplicht'); return null }
      return input
    },
    create: createProject,
    update: updateProject,
    renderMain: (items) => `
      <p class="muted proj-intro">Boekprojecten zijn ideegedreven containers. Elke noot kan aan meerdere projecten gekoppeld worden. AI-gap-analyse werkt per project.</p>
      ${items.length === 0
        ? '<p class="crud-empty">Nog geen projecten. Maak er een aan via het formulier.</p>'
        : items.map(p => renderProjectCard(p)).join('')
      }
    `,
    renderDetail: mountDetail
  }

  createCrudList(config, projects).mount(body)
}

// ── Detail view ─────────────────────────────────────────────────────────────

async function mountDetail(project: BookProject, host: HTMLElement, ctx: CrudDetailCtx<BookProject>): Promise<void> {
  let tab: 'notes' | 'gaps' = 'notes'
  let noteIds: string[] = []
  let notes: Note[] = []
  let gapResult: string | null = null
  let gapLoading = false

  try {
    noteIds = await fetchProjectNoteIds(project.id)
    notes = noteIds.length > 0 ? await fetchNotesByIds(noteIds) : []
  } catch { /* show empty */ }

  const status = BOOK_STATUSES[project.status]

  const render = () => {
    host.innerHTML = `
      <div class="crud-detail-wrap">
        <button class="btn btn-ghost crud-back" id="proj-back">← Terug</button>
        <div class="crud-detail">
          <div class="crud-detail-header">
            <span class="proj-status-label" style="color:${status.color}">${esc(status.label)}</span>
            <h2 class="crud-detail-title">${esc(project.title)}</h2>
            <blockquote class="proj-core-question">${esc(project.core_question)}</blockquote>
            ${project.description ? `<p class="proj-desc">${esc(project.description)}</p>` : ''}
          </div>
          <div class="crud-detail-actions">
            <button class="btn btn-ghost" id="pd-edit-btn">Bewerken</button>
            <button class="btn btn-danger" id="pd-delete-btn">Verwijderen</button>
          </div>
          <div class="proj-tabs">
            <button class="proj-tab${tab === 'notes' ? ' active' : ''}" data-tab="notes">Noten (${notes.length})</button>
            <button class="proj-tab${tab === 'gaps' ? ' active' : ''}" data-tab="gaps">Gap-analyse</button>
          </div>
          <div class="proj-tab-content">
            ${tab === 'notes' ? renderNotesTab(notes) : renderGapTab(gapLoading, gapResult)}
          </div>
        </div>
      </div>
    `

    document.getElementById('proj-back')?.addEventListener('click', () => ctx.back())
    document.getElementById('pd-edit-btn')?.addEventListener('click', () => ctx.edit(project))
    document.getElementById('pd-delete-btn')?.addEventListener('click', async () => {
      if (!confirm(`Project "${project.title}" verwijderen? Nota's blijven bestaan.`)) return
      try {
        await deleteProject(project.id)
        showToast('Project verwijderd')
        ctx.remove(project.id)
      } catch { showToast('Verwijderen mislukt') }
    })

    document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        tab = btn.dataset['tab'] as 'notes' | 'gaps'
        render()
      })
    })

    document.getElementById('gap-run-btn')?.addEventListener('click', async () => {
      if (notes.length === 0) { showToast('Voeg eerst noten toe aan dit project'); return }
      if (!isAiEnabled()) { showToast('Zet AI aan in Instellingen voor gap-analyse'); return }
      const costStatus = await getCostStatus().catch(() => null)
      if (costStatus?.block) { showToast('Maandelijkse AI-cap bereikt. Verhoog de cap in Instellingen.'); return }
      if (costStatus?.warn) {
        if (!confirm(`Let op: je hebt ${(costStatus.ratio * 100).toFixed(0)}% van je AI-budget gebruikt. Doorgaan?`)) return
      }
      gapLoading = true
      gapResult = null
      render()
      try {
        gapResult = await runGapAnalysis(project)
      } catch (err) {
        gapResult = `Fout: ${errMsg(err)}`
      }
      gapLoading = false
      render()
    })
  }

  render()
}

function renderNotesTab(notes: Note[]): string {
  if (notes.length === 0) return '<p class="muted">Nog geen noten gekoppeld aan dit project.</p>'
  return `
    <div class="proj-notes-list">
      ${notes.map(n => `
        <div class="crud-note-row">
          <span class="crud-note-title">${esc(n.ai_title ?? n.core_idea ?? n.content.slice(0, 80))}</span>
          <span class="badge badge-${n.status}">${esc(n.status)}</span>
        </div>
      `).join('')}
    </div>
  `
}

function renderGapTab(loading: boolean, result: string | null): string {
  return `
    <div class="gap-wrap">
      <p class="muted">AI analyseert je huidige noten en wijst op witte plekken, ontbrekende tegenargumenten en risico's. Vereist minimaal 1 noot.</p>
      <button class="btn btn-primary" id="gap-run-btn" ${loading ? 'disabled' : ''}>
        ${loading ? 'Analyseren…' : 'Gap-analyse uitvoeren'}
      </button>
      ${result ? `
        <div class="gap-result">
          <pre class="gap-text">${esc(result)}</pre>
        </div>
      ` : ''}
    </div>
  `
}

async function runGapAnalysis(project: BookProject): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Niet aangemeld')

  const persona = getPersona()
  const { data: urlData } = supabase.storage.from('_').getPublicUrl('')
  const supabaseUrl = (urlData.publicUrl as string).split('/storage')[0]

  const resp = await fetch(`${supabaseUrl}/functions/v1/gap-analysis`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`
    },
    body: JSON.stringify({ projectId: project.id, persona })
  })

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }))
    throw new Error(err.error ?? resp.statusText)
  }

  const data = await resp.json()
  return data.analysis ?? data.text ?? 'Geen resultaat ontvangen'
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function renderProjectCard(project: BookProject): string {
  const status = BOOK_STATUSES[project.status]
  return `
    <div class="crud-card proj-card" data-crud-id="${project.id}" role="button" tabindex="0" style="border-left:3px solid ${status.color}">
      <div class="proj-card-status" style="color:${status.color}">${esc(status.label)}</div>
      <div class="proj-card-title">${esc(project.title)}</div>
      <div class="proj-card-question">${esc(project.core_question)}</div>
    </div>
  `
}

function renderForm(data: ProjectForm, editing: boolean): string {
  const statuses: ProjectStatus[] = ['exploring', 'active', 'dormant', 'archived']
  return `
    <form id="crud-form" class="crud-form" novalidate>
      <div class="crud-field">
        <label class="crud-label" for="pf-title">Werktitel *</label>
        <input id="pf-title" type="text" value="${esc(data.title ?? '')}" required />
      </div>
      <div class="crud-field">
        <label class="crud-label" for="pf-question">Kernvraag *</label>
        <input id="pf-question" type="text" value="${esc(data.core_question ?? '')}" placeholder="Wat wil dit boek beantwoorden?" required />
      </div>
      <div class="crud-field">
        <label class="crud-label" for="pf-desc">Beschrijving (optioneel)</label>
        <textarea id="pf-desc" rows="3">${esc(data.description ?? '')}</textarea>
      </div>
      <div class="crud-field">
        <span class="crud-label">Status</span>
        <div class="pf-status-btns">
          ${statuses.map(s => {
            const meta = BOOK_STATUSES[s]
            const checked = data.status === s
            return `<label class="pf-status-btn${checked ? ' active' : ''}" style="${checked ? `background:${meta.color};color:#fff;border-color:${meta.color}` : ''}">
              <input type="radio" name="pf-status" value="${s}" ${checked ? 'checked' : ''} style="display:none" />
              ${esc(meta.label)}
            </label>`
          }).join('')}
        </div>
      </div>
      <div class="crud-actions">
        <button type="submit" class="btn btn-primary">${editing ? 'Opslaan' : 'Aanmaken'}</button>
        ${editing ? `<button type="button" class="btn btn-ghost" id="crud-cancel">Annuleren</button>` : ''}
      </div>
    </form>
  `
}

function emptyForm(): ProjectForm {
  return { title: '', core_question: '', description: '', status: 'exploring' }
}

function injectProjectStyles(): void {
  if (document.getElementById('proj-styles')) return
  const style = document.createElement('style')
  style.id = 'proj-styles'
  style.textContent = `
    .proj-intro { margin-bottom: var(--s-2); }
    .proj-card { padding: var(--s-4); }
    .proj-card-status { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
    .proj-card-title { font-size: var(--fs-lg); font-weight: 600; color: var(--text); }
    .proj-card-question { font-size: var(--fs-sm); color: var(--text-muted); font-style: italic; }
    .pf-status-btns { display: flex; gap: var(--s-1); flex-wrap: wrap; }
    .pf-status-btn {
      border: 1px solid var(--border); border-radius: var(--r-sm); padding: 4px var(--s-3);
      font-size: var(--fs-sm); cursor: pointer; color: var(--text-muted);
    }
    .proj-status-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
    .proj-core-question {
      margin: 0; padding: var(--s-3) var(--s-4); background: var(--bg); border-left: 3px solid var(--accent);
      font-size: var(--fs-base); font-style: italic; color: var(--text); line-height: 1.6;
    }
    .proj-desc { font-size: var(--fs-base); color: var(--text-muted); line-height: 1.6; white-space: pre-wrap; }
    .proj-tabs { display: flex; gap: var(--s-2); border-bottom: 1px solid var(--border); margin-bottom: var(--s-4); }
    .proj-tab {
      background: none; border: none; border-bottom: 2px solid transparent; padding: var(--s-2) var(--s-3);
      font-size: var(--fs-sm); cursor: pointer; color: var(--text-muted); margin-bottom: -1px;
    }
    .proj-tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
    .proj-notes-list { display: flex; flex-direction: column; gap: var(--s-1); }
    .gap-wrap { display: flex; flex-direction: column; gap: var(--s-3); }
    .gap-wrap .btn { width: auto; }
    .gap-result { background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-sm); padding: var(--s-4); border-left: 3px solid var(--accent); }
    .gap-text { white-space: pre-wrap; font-size: var(--fs-sm); line-height: 1.7; margin: 0; font-family: inherit; }
  `
  document.head.appendChild(style)
}
