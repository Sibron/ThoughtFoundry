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

export async function renderProjects(app: HTMLElement): Promise<void> {
  app.innerHTML = `
    ${renderTopbar('Projecten', 'projects')}
    <div class="proj-body" id="proj-body">
      <div class="proj-loading">Laden…</div>
    </div>
    <div class="toast" id="toast"></div>
  `
  injectStyles()
  attachTopbar()
  await reloadProjects(app)
}

async function reloadProjects(app: HTMLElement): Promise<void> {
  const body = document.getElementById('proj-body') as HTMLDivElement
  body.innerHTML = '<div class="proj-loading">Laden…</div>'
  try {
    const projects = await fetchProjects()
    mountList(app, body, projects)
  } catch (err) {
    body.innerHTML = `<div class="proj-loading">Laden mislukt: ${esc(msg(err))}</div>`
  }
}

// ── List view ───────────────────────────────────────────────────────────────

function mountList(app: HTMLElement, body: HTMLDivElement, projects: BookProject[]): void {
  let editing: BookProject | null = null
  let formData: BookProjectInsert & { status: ProjectStatus } = emptyForm()

  const render = () => {
    body.innerHTML = `
      <div class="proj-layout">
        <aside class="proj-sidebar">
          <div class="proj-form-wrap">
            <h2>${editing ? 'Project bewerken' : 'Nieuw project'}</h2>
            ${renderForm(formData, editing)}
          </div>
        </aside>
        <main class="proj-main">
          <p class="muted proj-intro">Boekprojecten zijn ideegedreven containers. Elke noot kan aan meerdere projecten gekoppeld worden. AI-gap-analyse werkt per project.</p>
          ${projects.length === 0
            ? '<p class="proj-empty">Nog geen projecten. Maak er een aan via het formulier.</p>'
            : projects.map(p => renderProjectCard(p)).join('')
          }
        </main>
      </div>
    `
    wireListEvents(app, body, projects, () => { editing = null; formData = emptyForm(); render() })

    document.getElementById('proj-form')?.addEventListener('submit', async (e) => {
      e.preventDefault()
      const form = e.target as HTMLFormElement
      const get = (id: string) => (form.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement)?.value.trim() ?? ''
      const input: BookProjectInsert & { status: ProjectStatus } = {
        title: get('pf-title'),
        core_question: get('pf-question'),
        description: get('pf-desc') || undefined,
        status: (form.querySelector('[name="pf-status"]:checked') as HTMLInputElement)?.value as ProjectStatus ?? 'exploring'
      }
      if (!input.title || !input.core_question) { showToast('Titel en kernvraag zijn verplicht'); return }
      const btn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
      btn.disabled = true
      try {
        if (editing) {
          const updated = await updateProject(editing.id, input)
          const idx = projects.findIndex(p => p.id === editing!.id)
          if (idx !== -1) projects[idx] = updated
          editing = null
          showToast('Project bijgewerkt')
        } else {
          const created = await createProject(input)
          projects.unshift(created)
          showToast('Project aangemaakt')
        }
        formData = emptyForm()
        render()
      } catch (err) {
        showToast(`Mislukt: ${msg(err)}`)
      } finally {
        btn.disabled = false
      }
    })

    document.getElementById('pf-cancel')?.addEventListener('click', () => {
      editing = null
      formData = emptyForm()
      render()
    })
  }

  render()
}

function wireListEvents(
  app: HTMLElement, body: HTMLDivElement, projects: BookProject[],
  resetForm: () => void
): void {
  document.querySelectorAll<HTMLElement>('[data-project-id]').forEach(el => {
    el.addEventListener('click', async () => {
      const id = el.dataset['projectId']!
      const project = projects.find(p => p.id === id)
      if (!project) return
      await mountDetail(app, body, project, projects, resetForm)
    })
  })
}

// ── Detail view ─────────────────────────────────────────────────────────────

async function mountDetail(
  app: HTMLElement, body: HTMLDivElement,
  project: BookProject, projects: BookProject[],
  onBack: () => void
): Promise<void> {
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
    body.innerHTML = `
      <div class="proj-detail-wrap">
        <button class="btn btn-ghost proj-back" id="proj-back">← Terug</button>
        <div class="proj-detail">
          <div class="proj-detail-header">
            <span class="proj-status-label" style="color:${status.color}">${esc(status.label)}</span>
            <h2 class="proj-detail-title">${esc(project.title)}</h2>
            <blockquote class="proj-core-question">${esc(project.core_question)}</blockquote>
            ${project.description ? `<p class="proj-desc">${esc(project.description)}</p>` : ''}
          </div>
          <div class="proj-detail-actions">
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

    document.getElementById('proj-back')?.addEventListener('click', () => onBack())
    document.getElementById('pd-edit-btn')?.addEventListener('click', () => {
      // Go back to list with the project pre-loaded for editing
      onBack()
      // Trigger edit by dispatching a synthetic click on the edit button via a small workaround
      // Actually we re-render the list with editing set — simplest approach: re-mount list with edit
      mountListWithEdit(app, body, projects, project, onBack)
    })
    document.getElementById('pd-delete-btn')?.addEventListener('click', async () => {
      if (!confirm(`Project "${project.title}" verwijderen? Nota's blijven bestaan.`)) return
      try {
        await deleteProject(project.id)
        const idx = projects.findIndex(p => p.id === project.id)
        if (idx !== -1) projects.splice(idx, 1)
        showToast('Project verwijderd')
        onBack()
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
      const ai = isAiEnabled()
      if (!ai) { showToast('Zet AI aan in Instellingen voor gap-analyse'); return }
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
        gapResult = `Fout: ${msg(err)}`
      }
      gapLoading = false
      render()
    })
  }

  render()
}

function mountListWithEdit(
  app: HTMLElement, body: HTMLDivElement,
  projects: BookProject[], editTarget: BookProject,
  _onBack: () => void
): void {
  let editing: BookProject | null = editTarget
  let formData: BookProjectInsert & { status: ProjectStatus } = {
    title: editTarget.title,
    core_question: editTarget.core_question,
    description: editTarget.description ?? '',
    status: editTarget.status
  }

  const render = () => {
    body.innerHTML = `
      <div class="proj-layout">
        <aside class="proj-sidebar">
          <div class="proj-form-wrap">
            <h2>Project bewerken</h2>
            ${renderForm(formData, editing)}
          </div>
        </aside>
        <main class="proj-main">
          <p class="muted proj-intro">Boekprojecten zijn ideegedreven containers. Elke noot kan aan meerdere projecten gekoppeld worden. AI-gap-analyse werkt per project.</p>
          ${projects.map(p => renderProjectCard(p)).join('')}
        </main>
      </div>
    `

    wireListEvents(app, body, projects, () => {
      editing = null
      formData = emptyForm()
      render()
    })

    document.getElementById('proj-form')?.addEventListener('submit', async (e) => {
      e.preventDefault()
      const form = e.target as HTMLFormElement
      const get = (id: string) => (form.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement)?.value.trim() ?? ''
      const input: BookProjectInsert & { status: ProjectStatus } = {
        title: get('pf-title'),
        core_question: get('pf-question'),
        description: get('pf-desc') || undefined,
        status: (form.querySelector('[name="pf-status"]:checked') as HTMLInputElement)?.value as ProjectStatus ?? 'exploring'
      }
      if (!input.title || !input.core_question) { showToast('Titel en kernvraag zijn verplicht'); return }
      const btn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
      btn.disabled = true
      try {
        if (editing) {
          const updated = await updateProject(editing.id, input)
          const idx = projects.findIndex(p => p.id === editing!.id)
          if (idx !== -1) projects[idx] = updated
          editing = null
          showToast('Project bijgewerkt')
        }
        formData = emptyForm()
        render()
      } catch (err) {
        showToast(`Mislukt: ${msg(err)}`)
      } finally {
        btn.disabled = false
      }
    })

    document.getElementById('pf-cancel')?.addEventListener('click', () => {
      editing = null
      formData = emptyForm()
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
        <div class="proj-note-row">
          <span class="proj-note-title">${esc(n.ai_title ?? n.core_idea ?? n.content.slice(0, 80))}</span>
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
    <div class="proj-card" data-project-id="${project.id}" role="button" tabindex="0" style="border-left:3px solid ${status.color}">
      <div class="proj-card-status" style="color:${status.color}">${esc(status.label)}</div>
      <div class="proj-card-title">${esc(project.title)}</div>
      <div class="proj-card-question">${esc(project.core_question)}</div>
    </div>
  `
}

function renderForm(data: BookProjectInsert & { status: ProjectStatus }, editing: BookProject | null): string {
  const statuses: ProjectStatus[] = ['exploring', 'active', 'dormant', 'archived']
  return `
    <form id="proj-form" class="proj-form" novalidate>
      <div class="pf-field">
        <label class="pf-label" for="pf-title">Werktitel *</label>
        <input id="pf-title" type="text" value="${esc(data.title ?? '')}" required />
      </div>
      <div class="pf-field">
        <label class="pf-label" for="pf-question">Kernvraag *</label>
        <input id="pf-question" type="text" value="${esc(data.core_question ?? '')}" placeholder="Wat wil dit boek beantwoorden?" required />
      </div>
      <div class="pf-field">
        <label class="pf-label" for="pf-desc">Beschrijving (optioneel)</label>
        <textarea id="pf-desc" rows="3">${esc(data.description ?? '')}</textarea>
      </div>
      <div class="pf-field">
        <span class="pf-label">Status</span>
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
      <div class="pf-actions">
        <button type="submit" class="btn btn-primary">${editing ? 'Opslaan' : 'Aanmaken'}</button>
        ${editing ? `<button type="button" class="btn btn-ghost" id="pf-cancel">Annuleren</button>` : ''}
      </div>
    </form>
  `
}

function emptyForm(): BookProjectInsert & { status: ProjectStatus } {
  return { title: '', core_question: '', description: '', status: 'exploring' }
}

function showToast(message: string): void {
  const t = document.getElementById('toast') as HTMLDivElement | null
  if (!t) return
  t.textContent = message
  t.classList.add('show')
  setTimeout(() => t.classList.remove('show'), 2500)
}

function esc(str: string): string {
  return (str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : 'onbekende fout'
}

function injectStyles(): void {
  if (document.getElementById('proj-styles')) return
  const style = document.createElement('style')
  style.id = 'proj-styles'
  style.textContent = `
    .proj-body { flex: 1; padding: var(--s-4); padding-bottom: calc(var(--bottom-nav-h) + var(--s-4)); max-width: 1100px; width: 100%; margin: 0 auto; }
    .proj-loading { text-align: center; padding: var(--s-7); color: var(--text-muted); }
    .proj-layout { display: grid; grid-template-columns: 320px 1fr; gap: var(--s-5); align-items: start; }
    @media (max-width: 720px) { .proj-layout { grid-template-columns: 1fr; } }
    .proj-sidebar { position: sticky; top: var(--s-4); }
    .proj-form-wrap {
      background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md);
      padding: var(--s-4); display: flex; flex-direction: column; gap: var(--s-3);
    }
    .proj-form-wrap h2 { font-size: var(--fs-lg); font-weight: 600; }
    .proj-form { display: flex; flex-direction: column; gap: var(--s-3); }
    .pf-field { display: flex; flex-direction: column; gap: var(--s-1); }
    .pf-label { font-size: var(--fs-sm); color: var(--text-muted); font-weight: 500; }
    .pf-status-btns { display: flex; gap: var(--s-1); flex-wrap: wrap; }
    .pf-status-btn {
      border: 1px solid var(--border); border-radius: var(--r-sm); padding: 4px var(--s-3);
      font-size: var(--fs-sm); cursor: pointer; color: var(--text-muted);
    }
    .pf-actions { display: flex; gap: var(--s-2); }
    .pf-actions .btn { width: auto; }
    .proj-main { display: flex; flex-direction: column; gap: var(--s-3); }
    .proj-intro { margin-bottom: var(--s-2); }
    .proj-empty { color: var(--text-muted); font-size: var(--fs-sm); text-align: center; padding: var(--s-7) 0; }
    .proj-card {
      background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md);
      padding: var(--s-4); cursor: pointer; display: flex; flex-direction: column; gap: var(--s-1);
    }
    .proj-card:hover { border-color: var(--accent); }
    .proj-card-status { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
    .proj-card-title { font-size: var(--fs-lg); font-weight: 600; color: var(--text); }
    .proj-card-question { font-size: var(--fs-sm); color: var(--text-muted); font-style: italic; }
    .proj-detail-wrap { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--s-4); }
    .proj-back { width: auto; }
    .proj-detail { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md); padding: var(--s-5); }
    .proj-detail-header { display: flex; flex-direction: column; gap: var(--s-2); margin-bottom: var(--s-4); }
    .proj-status-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
    .proj-detail-title { font-size: var(--fs-xl); font-weight: 600; color: var(--text); }
    .proj-core-question {
      margin: 0; padding: var(--s-3) var(--s-4); background: var(--bg); border-left: 3px solid var(--accent);
      font-size: var(--fs-base); font-style: italic; color: var(--text); line-height: 1.6;
    }
    .proj-desc { font-size: var(--fs-base); color: var(--text-muted); line-height: 1.6; white-space: pre-wrap; }
    .proj-detail-actions { display: flex; gap: var(--s-2); margin-bottom: var(--s-4); }
    .proj-detail-actions .btn { width: auto; }
    .proj-tabs { display: flex; gap: var(--s-2); border-bottom: 1px solid var(--border); margin-bottom: var(--s-4); }
    .proj-tab {
      background: none; border: none; border-bottom: 2px solid transparent; padding: var(--s-2) var(--s-3);
      font-size: var(--fs-sm); cursor: pointer; color: var(--text-muted); margin-bottom: -1px;
    }
    .proj-tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
    .proj-tab-content { }
    .proj-notes-list { display: flex; flex-direction: column; gap: var(--s-1); }
    .proj-note-row {
      display: flex; align-items: center; gap: var(--s-2);
      padding: var(--s-2) 0; border-bottom: 1px solid var(--border);
    }
    .proj-note-row:last-child { border-bottom: none; }
    .proj-note-title { flex: 1; font-size: var(--fs-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gap-wrap { display: flex; flex-direction: column; gap: var(--s-3); }
    .gap-wrap .btn { width: auto; }
    .gap-result { background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-sm); padding: var(--s-4); border-left: 3px solid var(--accent); }
    .gap-text { white-space: pre-wrap; font-size: var(--fs-sm); line-height: 1.7; margin: 0; font-family: inherit; }
    .muted { color: var(--text-muted); font-size: var(--fs-sm); }
  `
  document.head.appendChild(style)
}
