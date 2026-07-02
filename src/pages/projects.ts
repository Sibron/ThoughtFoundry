import {
  fetchProjects, createProject, updateProject, deleteProject,
  fetchProjectNoteIds, addNotesToProject, removeNoteFromProject, updateChapterOrder,
  BOOK_STATUSES, type BookProject, type BookProjectInsert, type ProjectStatus
} from '../lib/projects'
import { fetchNotesByIds, type Note } from '../lib/notes'
import { fetchChaptersByProject, fetchSectionStats, type Chapter, type ChapterSectionStats } from '../lib/chapters'
import { renderBookMarkdown, resolveChapterSections, downloadMarkdown, slugify } from '../lib/manuscript'
import { isAiEnabled } from '../lib/nav'
import { runGapAnalysis } from '../lib/ai'
import { createAiAction } from '../lib/ai-action'
import { openNotePicker } from '../lib/note-picker'
import { navigateTo } from '../router'
import { createCrudList, injectCrudStyles, showToast, esc, errMsg, type CrudListConfig, type CrudDetailCtx } from '../lib/crud-list'

type ProjectForm = BookProjectInsert & { status: ProjectStatus }

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
      status: p.status,
      target_date: p.target_date
    }),
    renderForm,
    parseForm: (form) => {
      const get = (id: string) => (form.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement)?.value.trim() ?? ''
      const input: ProjectForm = {
        title: get('pf-title'),
        core_question: get('pf-question'),
        description: get('pf-desc') || undefined,
        status: (form.querySelector('[name="pf-status"]:checked') as HTMLInputElement)?.value as ProjectStatus ?? 'exploring',
        target_date: get('pf-target') || null
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
  let tab: 'notes' | 'gaps' | 'chapters' | 'manuscript' = 'notes'
  let noteIds: string[] = []
  let notes: Note[] = []
  let gapResult: string | null = null
  let projectChapters: Chapter[] = []
  let chapterStats = new Map<string, ChapterSectionStats>()

  async function loadNotes(): Promise<void> {
    try {
      noteIds = await fetchProjectNoteIds(project.id)
      notes = noteIds.length > 0 ? await fetchNotesByIds(noteIds) : []
    } catch { /* show empty */ }
  }
  async function loadChapters(): Promise<void> {
    try {
      projectChapters = await fetchChaptersByProject(project.id)
      chapterStats = await fetchSectionStats().catch(() => new Map())
    } catch { /* show empty */ }
  }
  await Promise.all([loadNotes(), loadChapters()])

  /** Manuscript order: saved ordering first, then any chapters not yet ordered. */
  function orderedChapters(): Chapter[] {
    const byId = new Map(projectChapters.map(c => [c.id, c]))
    const ordered: Chapter[] = []
    for (const id of project.chapter_order ?? []) {
      const c = byId.get(id)
      if (c) { ordered.push(c); byId.delete(id) }
    }
    return [...ordered, ...byId.values()]
  }

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
            <button class="proj-tab${tab === 'chapters' ? ' active' : ''}" data-tab="chapters">Hoofdstukken (${projectChapters.length})</button>
            <button class="proj-tab${tab === 'manuscript' ? ' active' : ''}" data-tab="manuscript">Manuscript</button>
          </div>
          <div class="proj-tab-content">
            ${tab === 'notes' ? renderNotesTab(notes)
              : tab === 'gaps' ? renderGapTab(gapResult)
              : tab === 'chapters' ? renderChaptersTab(projectChapters, chapterStats)
              : renderManuscriptTab(orderedChapters(), chapterStats)}
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
        tab = btn.dataset['tab'] as typeof tab
        render()
      })
    })

    // ── Hoofdstukken tab ──────────────────────────────────────────────────
    document.getElementById('proj-new-chapter')?.addEventListener('click', () => {
      navigateTo(`/library?tab=book&project=${project.id}`)
    })
    document.querySelectorAll<HTMLButtonElement>('[data-write-chapter]').forEach(btn => {
      btn.addEventListener('click', () => navigateTo('/studio?chapter=' + btn.dataset['writeChapter']))
    })

    // ── Manuscript tab ────────────────────────────────────────────────────
    document.querySelectorAll<HTMLButtonElement>('[data-ms-move]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const dir = btn.dataset['msMove'] === 'up' ? -1 : 1
        const id = btn.dataset['msId']!
        const order = orderedChapters().map(c => c.id)
        const idx = order.indexOf(id)
        const to = idx + dir
        if (idx === -1 || to < 0 || to >= order.length) return
        ;[order[idx], order[to]] = [order[to], order[idx]]
        try {
          await updateChapterOrder(project.id, order)
          project.chapter_order = order
          render()
        } catch (err) { showToast(`Volgorde opslaan mislukt: ${errMsg(err)}`) }
      })
    })
    document.getElementById('proj-export-manuscript')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget as HTMLButtonElement
      const ordered = orderedChapters()
      if (ordered.length === 0) { showToast('Nog geen hoofdstukken voor dit project'); return }
      btn.disabled = true
      btn.textContent = 'Samenstellen…'
      try {
        const manuscriptChapters = await Promise.all(ordered.map(async c => ({
          title: c.title,
          summary: c.summary ?? '',
          sections: await resolveChapterSections(c)
        })))
        // Notes for the assembly fallback of unwritten sections.
        const refIds = [...new Set(manuscriptChapters.flatMap(c => c.sections.flatMap(s => s.note_ids)))]
        const refNotes = refIds.length ? await fetchNotesByIds(refIds).catch(() => [] as Note[]) : []
        const md = renderBookMarkdown(
          project.title,
          project.description ?? '',
          manuscriptChapters,
          refNotes,
          project.core_question
        )
        downloadMarkdown(`${slugify(project.title) || 'manuscript'}-manuscript.md`, md)
        showToast('Manuscript geëxporteerd')
      } catch (err) {
        showToast(`Exporteren mislukt: ${errMsg(err)}`)
      } finally {
        btn.disabled = false
        btn.textContent = 'Exporteer manuscript (.md)'
      }
    })

    document.getElementById('proj-attach-btn')?.addEventListener('click', () => {
      openNotePicker({
        title: `Noten koppelen aan «${project.title}»`,
        seedText: [project.core_question, project.description].filter(Boolean).join('\n'),
        excludeIds: noteIds,
        onConfirm: async (ids) => {
          await addNotesToProject(project.id, ids)
          showToast(`${ids.length} ${ids.length === 1 ? 'noot' : 'noten'} gekoppeld`)
          await loadNotes()
          render()
        }
      })
    })

    document.querySelectorAll<HTMLButtonElement>('[data-detach-id]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation()
        try {
          await removeNoteFromProject(project.id, btn.dataset['detachId']!)
          showToast('Noot ontkoppeld')
          await loadNotes()
          render()
        } catch { showToast('Ontkoppelen mislukt') }
      })
    })

    document.querySelectorAll<HTMLElement>('.proj-note-row[data-note-id]').forEach(row => {
      row.addEventListener('click', () => navigateTo('/note?id=' + row.dataset['noteId']))
    })

    const gapHost = document.getElementById('gap-action-host')
    if (gapHost) {
      createAiAction(gapHost, {
        label: 'Gap-analyse uitvoeren',
        defaultModel: 'claude-sonnet-4-6',
        expectedOutputTokens: 1500,
        estimateInputChars: () => notes.length * 400 + 1200,
        phases: ['Project doornemen…', 'Witte plekken zoeken…', 'Tegenargumenten wegen…', 'Analyse schrijven…'],
        beforeRun: () => {
          if (notes.length === 0) { showToast('Voeg eerst noten toe aan dit project'); return false }
          if (!isAiEnabled()) { showToast('Zet AI aan in Instellingen voor gap-analyse'); return false }
          return true
        },
        run: async (model, overrideCap) => {
          const { analysis, usage } = await runGapAnalysis({ projectId: project.id, model, overrideCap })
          gapResult = analysis || 'Geen resultaat ontvangen'
          const wrap = document.getElementById('gap-result-wrap')
          if (wrap) wrap.innerHTML = renderGapResult(gapResult)
          return usage
        },
      })
    }
  }

  render()
}

function renderNotesTab(notes: Note[]): string {
  return `
    <div class="proj-notes-tools">
      <button class="btn btn-ghost" id="proj-attach-btn">+ Noten koppelen</button>
    </div>
    ${notes.length === 0
      ? '<p class="muted">Nog geen noten gekoppeld aan dit project. Koppel ze hier, of via het veld Boekprojecten in de nota-editor.</p>'
      : `<div class="proj-notes-list">
          ${notes.map(n => `
            <div class="crud-note-row proj-note-row" data-note-id="${n.id}" role="button" tabindex="0">
              <span class="crud-note-title">${esc(n.ai_title ?? n.core_idea ?? n.content.slice(0, 80))}</span>
              <span class="badge badge-${n.status}">${esc(n.status)}</span>
              <button class="btn btn-ghost btn-sm proj-detach" data-detach-id="${n.id}" title="Uit dit project halen">Ontkoppel</button>
            </div>
          `).join('')}
        </div>`
    }
  `
}

function renderGapTab(result: string | null): string {
  return `
    <div class="gap-wrap">
      <p class="muted">AI analyseert je huidige noten en wijst op witte plekken, ontbrekende tegenargumenten en risico's. Vereist minimaal 1 noot.</p>
      <div id="gap-action-host"></div>
      <div id="gap-result-wrap">${result ? renderGapResult(result) : ''}</div>
    </div>
  `
}

function renderGapResult(result: string): string {
  return `
    <div class="gap-result">
      <pre class="gap-text">${esc(result)}</pre>
    </div>
  `
}

function renderChaptersTab(chapters: Chapter[], stats: Map<string, ChapterSectionStats>): string {
  return `
    <div class="proj-notes-tools">
      <button class="btn btn-ghost" id="proj-new-chapter">Nieuw hoofdstuk uit projectnoten →</button>
    </div>
    ${chapters.length === 0
      ? '<p class="muted">Nog geen hoofdstukken voor dit project. Start er een vanuit je projectnoten.</p>'
      : `<div class="proj-notes-list">
          ${chapters.map(c => {
            const s = stats.get(c.id)
            const badge = s ? `${s.written}/${s.total} secties${s.words ? ` · ${s.words} w` : ''}` : ''
            return `
              <div class="crud-note-row proj-chapter-row">
                <span class="crud-note-title">${esc(c.title)}</span>
                ${badge ? `<span class="proj-chapter-badge">${esc(badge)}</span>` : ''}
                <button class="btn btn-primary btn-sm" data-write-chapter="${c.id}">Schrijf →</button>
              </div>`
          }).join('')}
        </div>`
    }
  `
}

function renderManuscriptTab(ordered: Chapter[], stats: Map<string, ChapterSectionStats>): string {
  const totalWords = ordered.reduce((sum, c) => sum + (stats.get(c.id)?.words ?? 0), 0)
  return `
    <div class="proj-notes-tools">
      <button class="btn btn-primary" id="proj-export-manuscript">Exporteer manuscript (.md)</button>
      ${totalWords ? `<span class="muted">${totalWords} geschreven woorden</span>` : ''}
    </div>
    <p class="muted">Titel, kernvraag en beschrijving vormen het voorwerk; daarna volgen de hoofdstukken in deze volgorde. Geschreven secties exporteren als proza, ongeschreven secties als nota-bundel.</p>
    ${ordered.length === 0
      ? '<p class="muted">Nog geen hoofdstukken voor dit project.</p>'
      : `<div class="proj-notes-list">
          ${ordered.map((c, i) => `
            <div class="crud-note-row proj-chapter-row">
              <span class="proj-ms-index">${i + 1}.</span>
              <span class="crud-note-title">${esc(c.title)}</span>
              <span class="proj-ms-controls">
                <button class="btn btn-ghost btn-sm" data-ms-move="up" data-ms-id="${c.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
                <button class="btn btn-ghost btn-sm" data-ms-move="down" data-ms-id="${c.id}" ${i === ordered.length - 1 ? 'disabled' : ''}>↓</button>
              </span>
            </div>`).join('')}
        </div>`
    }
  `
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
        <label class="crud-label" for="pf-target">Streefdatum (optioneel)</label>
        <input id="pf-target" type="date" value="${esc(data.target_date ?? '')}" />
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
  return { title: '', core_question: '', description: '', status: 'exploring', target_date: null }
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
    .proj-notes-tools .btn { width: auto; }
    .proj-notes-list { display: flex; flex-direction: column; gap: var(--s-1); }
    .proj-note-row { cursor: pointer; }
    .proj-note-row:hover { border-color: var(--accent); }
    .proj-detach { flex-shrink: 0; }
    .proj-chapter-row { align-items: center; }
    .proj-chapter-badge { font-size: var(--fs-sm); color: var(--accent); font-weight: 600; white-space: nowrap; }
    .proj-ms-index { color: var(--text-muted); font-size: var(--fs-sm); width: 1.6em; }
    .proj-ms-controls { display: inline-flex; gap: 2px; flex-shrink: 0; }
    .proj-notes-tools { display: flex; gap: var(--s-3); align-items: center; flex-wrap: wrap; margin-bottom: var(--s-2); }
    .gap-wrap { display: flex; flex-direction: column; gap: var(--s-3); }
    .gap-wrap .btn { width: auto; }
    .gap-result { background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-sm); padding: var(--s-4); border-left: 3px solid var(--accent); }
    .gap-text { white-space: pre-wrap; font-size: var(--fs-sm); line-height: 1.7; margin: 0; font-family: inherit; }
  `
  document.head.appendChild(style)
}
