import { fetchAllNotes, getNoteTitle, type Note } from '../lib/notes'
import { fetchThemes, fetchAllNoteThemes, type Theme } from '../lib/themes'
import { fetchChapters, saveChapter, deleteChapter, fetchSectionStats, type Chapter, type ChapterSectionStats } from '../lib/chapters'
import { fetchBooks, createBook, updateBook, deleteBook, type Book } from '../lib/books'
import { fetchProject, fetchProjectNoteIds, type BookProject } from '../lib/projects'
import { renderChapterMarkdown, renderBookMarkdown, resolveChapterSections, downloadMarkdown, slugify } from '../lib/manuscript'
import { generateChapter, type ChapterPlan } from '../lib/ai'
import { AI_PHASES } from '../lib/ai-thinking'
import { createAiAction, type AiActionHandle } from '../lib/ai-action'
import { isAiEnabled } from '../lib/nav'
import { SECTIONS } from '../lib/sections'
import { navigateTo } from '../router'
import { mountProjects } from './projects'
import { showToast, showUndoToast, esc as escHtml, errMsg, formatDate } from '../lib/crud-list'

export async function mountBook(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="book-body" id="book-body">
      <div class="book-loading">Laden…</div>
    </div>
  `

  injectBookStyles()

  let notes: Note[] = []
  let themes: Theme[] = []
  let noteThemes: { note_id: string; theme_id: string }[] = []
  let chapters: Chapter[] = []
  let books: Book[] = []
  let activeTab: 'projects' | 'chapters' | 'books' = 'chapters'
  let genAction: AiActionHandle | null = null

  let sectionStats = new Map<string, ChapterSectionStats>()
  // Workbench project scope: /library?tab=book&project=<id> pre-filters the
  // note pool to that project's notities and stamps project_id on saved chapters.
  let workProject: BookProject | null = null
  let workProjectNoteIds: Set<string> = new Set()

  try {
    [notes, themes, noteThemes, chapters, books] = await Promise.all([
      fetchAllNotes('verwerkt'),
      fetchThemes(),
      fetchAllNoteThemes(),
      fetchChapters(),
      fetchBooks()
    ])
    sectionStats = await fetchSectionStats().catch(() => new Map())
  } catch (err) {
    document.getElementById('book-body')!.innerHTML =
      `<div class="book-error">Laden mislukt: ${escHtml(errMsg(err))}</div>`
    return
  }

  const bookParams = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
  const bookTabParam = bookParams.get('booktab')
  if (bookTabParam === 'projects' || bookTabParam === 'chapters' || bookTabParam === 'books') {
    activeTab = bookTabParam
  }
  const projectParam = bookParams.get('project')
  if (projectParam) {
    try {
      workProject = await fetchProject(projectParam)
      if (workProject) workProjectNoteIds = new Set(await fetchProjectNoteIds(workProject.id))
    } catch { /* scope is best-effort */ }
  }

  renderShell()

  function renderShell(): void {
    const body = document.getElementById('book-body')!
    body.innerHTML = `
      <div class="book-tabs">
        <button class="book-tab" data-tab="projects" ${activeTab === 'projects' ? 'aria-current="true"' : ''}>Projecten</button>
        <button class="book-tab" data-tab="chapters" ${activeTab === 'chapters' ? 'aria-current="true"' : ''}>Hoofdstukken</button>
        <button class="book-tab" data-tab="books" ${activeTab === 'books' ? 'aria-current="true"' : ''}>Boeken</button>
      </div>
      <div id="book-tabpanel"></div>
    `
    body.querySelectorAll<HTMLButtonElement>('.book-tab').forEach(t => {
      t.addEventListener('click', () => {
        activeTab = t.dataset['tab'] as 'projects' | 'chapters' | 'books'
        renderShell()
      })
    })
    if (activeTab === 'projects') renderProjectsTab()
    else if (activeTab === 'chapters') renderChaptersTab()
    else renderBooksTab()
  }

  function renderProjectsTab(): void {
    const panel = document.getElementById('book-tabpanel')!
    panel.innerHTML = ''
    void mountProjects(panel)
  }

  function renderChaptersTab(): void {
    const panel = document.getElementById('book-tabpanel')!
    panel.innerHTML = `
      <section class="book-section">
        <header class="book-section-header">
          <h2>Hoofdstuk-werkbank</h2>
          <p class="muted">Selecteer een thema, kies notities, en laat AI een hoofdstukschets voorstellen.</p>
          ${workProject ? `<p class="book-project-scope">Project: <strong>${escHtml(workProject.title)}</strong> — alleen projectnotities worden getoond; het hoofdstuk wordt aan dit project gekoppeld.</p>` : ''}
        </header>

        <div class="book-controls">
          <label class="field">
            <span class="field-label">Thema</span>
            <select id="book-theme">
              <option value="">— alle notities —</option>
              ${themes.map(t => `<option value="${t.id}">${escHtml(t.name)}</option>`).join('')}
            </select>
          </label>

          <label class="field">
            <span class="field-label">Invalshoek (optioneel)</span>
            <input type="text" id="book-angle" placeholder="Bv. 'voor leidinggevenden in zorgsector'" />
          </label>
        </div>

        <div class="book-notes-list" id="book-notes-list"></div>

        <div class="book-actions">
          <span id="generate-info" class="muted"></span>
          <div id="generate-action-host"></div>
        </div>
      </section>

      <section class="book-section" id="plan-section" style="display:none;">
        <header class="book-section-header">
          <h2>Voorgesteld hoofdstuk</h2>
        </header>
        <div id="plan-edit"></div>
      </section>

      <section class="book-section">
        <header class="book-section-header">
          <h2>Bewaarde hoofdstukken (${chapters.length})</h2>
        </header>
        <div class="book-saved" id="book-saved"></div>
      </section>
    `

    const themeSelect = document.getElementById('book-theme') as HTMLSelectElement
    const urlParams = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
    const preselectedTheme = urlParams.get('theme')
    if (preselectedTheme) themeSelect.value = preselectedTheme
    themeSelect.addEventListener('change', () => renderNoteList())

    genAction = createAiAction(document.getElementById('generate-action-host')!, {
      label: 'Genereer hoofdstuk',
      defaultModel: 'claude-sonnet-4-6',
      expectedOutputTokens: 1200,
      // Each selected note contributes its summary/content excerpt (~400 chars).
      estimateInputChars: () => selectedNoteIds().length * 400 + 1500,
      phases: AI_PHASES.book,
      beforeRun: () => {
        if (selectedNoteIds().length < 2) { showToast('Selecteer minimaal 2 notities'); return false }
        if (!isAiEnabled()) { showToast('Zet AI aan in Instellingen om hoofdstukken te genereren'); return false }
        return true
      },
      run: async (model, overrideCap) => {
        const ids = selectedNoteIds()
        const themeId = (document.getElementById('book-theme') as HTMLSelectElement).value || undefined
        const angle = (document.getElementById('book-angle') as HTMLInputElement).value.trim() || undefined
        const { plan, usage } = await generateChapter({ noteIds: ids, themeId, angle, model, overrideCap })
        showPlanEditor(plan, ids, themeId ?? null)
        showToast('Hoofdstuk gegenereerd')
        return usage
      },
    })

    renderNoteList()
    renderSaved()
  }

  function renderBooksTab(): void {
    const panel = document.getElementById('book-tabpanel')!
    panel.innerHTML = `
      <section class="book-section">
        <header class="book-section-header">
          <h2>Nieuw boek</h2>
          <p class="muted">Bundel meerdere hoofdstukken tot één export.</p>
        </header>
        <div class="book-controls">
          <label class="field">
            <span class="field-label">Titel</span>
            <input type="text" id="new-book-title" placeholder="Bv. 'Werken met autisme — een handleiding'" />
          </label>
          <label class="field">
            <span class="field-label">Inleiding (optioneel)</span>
            <textarea id="new-book-intro" rows="2" placeholder="Korte intro voor de lezer"></textarea>
          </label>
        </div>
        <div class="book-actions">
          <button class="btn btn-primary" id="create-book-btn">Boek aanmaken</button>
        </div>
      </section>

      <section class="book-section">
        <header class="book-section-header">
          <h2>Mijn boeken (${books.length})</h2>
        </header>
        <div id="books-list"></div>
      </section>
    `

    document.getElementById('create-book-btn')?.addEventListener('click', onCreateBook)
    renderBooksList()
  }

  async function onCreateBook(): Promise<void> {
    const title = (document.getElementById('new-book-title') as HTMLInputElement).value.trim()
    const intro = (document.getElementById('new-book-intro') as HTMLTextAreaElement).value.trim()
    if (!title) { showToast('Titel is verplicht'); return }
    const btn = document.getElementById('create-book-btn') as HTMLButtonElement
    btn.disabled = true
    try {
      const created = await createBook({ title, intro: intro || undefined })
      books.unshift(created)
      renderBooksTab()
      showToast('Boek aangemaakt')
    } catch (err) {
      showToast(`Mislukt: ${errMsg(err)}`)
    } finally {
      btn.disabled = false
    }
  }

  function renderBooksList(): void {
    const el = document.getElementById('books-list')!
    if (books.length === 0) {
      el.innerHTML = '<p class="muted">Nog geen boeken. Maak er een aan, en sleep hoofdstukken erin.</p>'
      return
    }
    el.innerHTML = books.map(b => {
      const includedIds = new Set(b.chapter_ids)
      return `
        <details class="book-row" data-id="${b.id}">
          <summary class="book-row-summary">
            <span class="book-row-title">${escHtml(b.title)}</span>
            <span class="muted">${b.chapter_ids.length} hoofdstuk(ken)</span>
          </summary>
          <div class="book-row-edit">
            <label class="field">
              <span class="field-label">Titel</span>
              <input type="text" data-edit-title value="${escHtml(b.title)}" />
            </label>
            <label class="field">
              <span class="field-label">Inleiding</span>
              <textarea data-edit-intro rows="2">${escHtml(b.intro ?? '')}</textarea>
            </label>
            <fieldset class="field">
              <legend class="field-label">Hoofdstukken in dit boek (volgorde van selectie = volgorde in export)</legend>
              <ol class="book-chapter-list" data-list>
                ${b.chapter_ids.map(cid => {
                  const c = chapters.find(x => x.id === cid)
                  return `
                    <li class="book-chapter-included" data-cid="${cid}">
                      <span>${escHtml(c?.title ?? '(verwijderd hoofdstuk)')}</span>
                      <button class="link-btn" data-action="up">↑</button>
                      <button class="link-btn" data-action="down">↓</button>
                      <button class="link-btn link-btn-danger" data-action="remove">×</button>
                    </li>
                  `
                }).join('')}
              </ol>
              ${chapters.filter(c => !includedIds.has(c.id)).length > 0 ? `
                <details class="book-add-chapter">
                  <summary>+ Hoofdstuk toevoegen</summary>
                  <select data-add-select>
                    <option value="">— kies hoofdstuk —</option>
                    ${chapters.filter(c => !includedIds.has(c.id))
                      .map(c => `<option value="${c.id}">${escHtml(c.title)}</option>`).join('')}
                  </select>
                  <button class="btn btn-ghost" data-action="add">Toevoegen</button>
                </details>
              ` : '<p class="muted">Alle hoofdstukken al toegevoegd.</p>'}
            </fieldset>
            <div class="book-actions">
              <button class="btn btn-primary" data-action="save">Opslaan</button>
              <button class="btn btn-ghost" data-action="export">Exporteer .md</button>
              <button class="btn btn-danger" data-action="delete">Verwijder</button>
            </div>
          </div>
        </details>
      `
    }).join('')

    el.querySelectorAll<HTMLDetailsElement>('.book-row').forEach(row => attachBookRowListeners(row))
  }

  function attachBookRowListeners(row: HTMLDetailsElement): void {
    const id = row.dataset['id']!

    row.querySelectorAll<HTMLButtonElement>('[data-action="remove"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault()
        const li = (e.currentTarget as HTMLElement).closest('li')
        li?.remove()
      })
    })
    row.querySelectorAll<HTMLButtonElement>('[data-action="up"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault()
        const li = (e.currentTarget as HTMLElement).closest('li')
        const prev = li?.previousElementSibling
        if (li && prev) li.parentElement!.insertBefore(li, prev)
      })
    })
    row.querySelectorAll<HTMLButtonElement>('[data-action="down"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault()
        const li = (e.currentTarget as HTMLElement).closest('li')
        const next = li?.nextElementSibling
        if (li && next) li.parentElement!.insertBefore(next, li)
      })
    })

    row.querySelector<HTMLButtonElement>('[data-action="add"]')?.addEventListener('click', (e) => {
      e.preventDefault()
      const select = row.querySelector<HTMLSelectElement>('[data-add-select]')!
      const cid = select.value
      if (!cid) return
      const list = row.querySelector<HTMLOListElement>('[data-list]')!
      const c = chapters.find(x => x.id === cid)
      if (!c) return
      const li = document.createElement('li')
      li.className = 'book-chapter-included'
      li.dataset['cid'] = cid
      li.innerHTML = `
        <span>${escHtml(c.title)}</span>
        <button class="link-btn" data-action="up">↑</button>
        <button class="link-btn" data-action="down">↓</button>
        <button class="link-btn link-btn-danger" data-action="remove">×</button>
      `
      list.appendChild(li)
      // Re-attach listeners on this new li
      attachBookRowListeners(row)
      // Remove from select
      select.querySelector(`option[value="${cid}"]`)?.remove()
      select.value = ''
    })

    row.querySelector<HTMLButtonElement>('[data-action="save"]')?.addEventListener('click', (e) => {
      e.preventDefault()
      onSaveBook(row, id)
    })

    row.querySelector<HTMLButtonElement>('[data-action="export"]')?.addEventListener('click', (e) => {
      e.preventDefault()
      onExportBook(row, id)
    })

    row.querySelector<HTMLButtonElement>('[data-action="delete"]')?.addEventListener('click', (e) => {
      e.preventDefault()
      // Soft-delete: the row disappears now, the API delete only runs after
      // the undo window closes. Hoofdstukken zelf blijven bestaan.
      const removed = books.find(x => x.id === id)
      books = books.filter(x => x.id !== id)
      renderBooksTab()
      showUndoToast('Boek verwijderd',
        async () => { try { await deleteBook(id) } catch (err) { showToast(`Verwijderen mislukt: ${errMsg(err)}`) } },
        () => {
          if (removed) books = [removed, ...books]
          renderBooksTab()
        })
    })
  }

  async function onSaveBook(row: HTMLDetailsElement, id: string): Promise<void> {
    const title = row.querySelector<HTMLInputElement>('[data-edit-title]')!.value.trim()
    const intro = row.querySelector<HTMLTextAreaElement>('[data-edit-intro]')!.value.trim()
    const chapterIds = Array.from(row.querySelectorAll<HTMLLIElement>('li.book-chapter-included'))
      .map(li => li.dataset['cid']!)
      .filter(Boolean)
    if (!title) { showToast('Titel is verplicht'); return }
    try {
      const updated = await updateBook(id, { title, intro: intro || null, chapter_ids: chapterIds })
      const idx = books.findIndex(x => x.id === id)
      if (idx !== -1) books[idx] = updated
      renderBooksTab()
      showToast('Opgeslagen')
    } catch (err) {
      showToast(`Mislukt: ${errMsg(err)}`)
    }
  }

  async function onExportBook(row: HTMLDetailsElement, id: string): Promise<void> {
    const title = row.querySelector<HTMLInputElement>('[data-edit-title]')!.value.trim()
    const intro = row.querySelector<HTMLTextAreaElement>('[data-edit-intro]')!.value.trim()
    const chapterIds = Array.from(row.querySelectorAll<HTMLLIElement>('li.book-chapter-included'))
      .map(li => li.dataset['cid']!)
      .filter(Boolean)
    const orderedChapters = chapterIds
      .map(cid => chapters.find(c => c.id === cid))
      .filter((c): c is Chapter => !!c)
    // Prose-first: pull studio sections per chapter (outline fallback inside).
    const manuscriptChapters = await Promise.all(orderedChapters.map(async c => ({
      title: c.title,
      summary: c.summary ?? '',
      sections: await resolveChapterSections(c)
    })))
    const md = renderBookMarkdown(title, intro, manuscriptChapters, notes)
    const fallback = books.find(b => b.id === id)?.title ?? title
    downloadMarkdown(`${slugify(fallback) || 'boek'}.md`, md)
  }

  function selectedNoteIds(): string[] {
    return Array.from(
      document.querySelectorAll<HTMLInputElement>('#book-notes-list input[type=checkbox]:checked')
    ).map(el => el.value)
  }

  function renderNoteList(): void {
    const themeId = (document.getElementById('book-theme') as HTMLSelectElement).value
    let filtered = themeId
      ? notes.filter(n => noteThemes.some(nt => nt.note_id === n.id && nt.theme_id === themeId))
      : notes
    if (workProject) filtered = filtered.filter(n => workProjectNoteIds.has(n.id))

    const listEl = document.getElementById('book-notes-list')!
    if (filtered.length === 0) {
      listEl.innerHTML = workProject
        ? '<p class="muted">Geen verwerkte projectnotities gevonden. Koppel eerst notities aan het project.</p>'
        : '<p class="muted">Geen verwerkte notities in dit thema.</p>'
      updateGenerateState()
      return
    }

    const noteRow = (n: Note) => `
      <label class="book-note-row">
        <input type="checkbox" value="${n.id}" checked />
        <div class="book-note-text">
          <strong>${escHtml(n.ai_title ?? n.content.slice(0, 80))}</strong>
          <span class="muted">${escHtml((n.ai_summary ?? n.content).slice(0, 140))}</span>
        </div>
      </label>`

    const groups: string[] = SECTIONS.map(sec => {
      const secNotes = filtered.filter(n => n.section === sec.slug)
      if (secNotes.length === 0) return ''
      return `
        <div class="book-section-group">
          <div class="book-section-group-header">
            <span>${escHtml(sec.label)}</span>
            <span class="muted">${secNotes.length}</span>
          </div>
          ${secNotes.map(noteRow).join('')}
        </div>`
    }).filter(Boolean)

    const unsectioned = filtered.filter(n => !n.section)
    if (unsectioned.length > 0) {
      groups.push(`
        <div class="book-section-group book-section-group--unsectioned">
          <div class="book-section-group-header">
            <span>Zonder sectie</span>
            <span class="muted">${unsectioned.length}</span>
          </div>
          ${unsectioned.map(noteRow).join('')}
        </div>`)
    }

    listEl.innerHTML = groups.join('')
    listEl.querySelectorAll('input').forEach(el => el.addEventListener('change', updateGenerateState))
    updateGenerateState()
  }

  function updateGenerateState(): void {
    const ids = selectedNoteIds()
    const info = document.getElementById('generate-info')!
    info.textContent = ids.length < 2
      ? 'Selecteer minimaal 2 notities.'
      : `${ids.length} notities geselecteerd.`
    genAction?.setDisabled(ids.length < 2)
    genAction?.refreshEstimate()
  }

  function showPlanEditor(plan: ChapterPlan, allIds: string[], themeId: string | null): void {
    const section = document.getElementById('plan-section')!
    section.style.display = ''
    const edit = document.getElementById('plan-edit')!

    edit.innerHTML = `
      <label class="field">
        <span class="field-label">Titel</span>
        <input type="text" id="plan-title" value="${escHtml(plan.title)}" />
      </label>

      <label class="field">
        <span class="field-label">Samenvatting</span>
        <textarea id="plan-summary" rows="3">${escHtml(plan.summary)}</textarea>
      </label>

      <div class="plan-sections" id="plan-sections">
        ${plan.sections.map((s, i) => renderSectionEditor(s, i, (id) => {
          const n = notes.find(x => x.id === id)
          return n ? getNoteTitle(n, 48) : id.slice(0, 8) + '…'
        })).join('')}
      </div>

      <div class="plan-actions">
        <button class="btn btn-primary" id="plan-save">Opslaan</button>
        <button class="btn btn-ghost" id="plan-export">Exporteer als markdown</button>
        <button class="btn btn-ghost" id="plan-cancel">Annuleer</button>
      </div>
    `

    document.getElementById('plan-save')?.addEventListener('click', async () => {
      const updated = collectPlan(plan)
      try {
        const saved = await saveChapter({
          themeId,
          projectId: workProject?.id ?? null,
          title: updated.title,
          summary: updated.summary,
          outline: updated.sections,
          noteIds: allIds
        })
        chapters.unshift(saved)
        section.style.display = 'none'
        renderSaved()
        showToast('Opgeslagen')
      } catch (err) {
        showToast(`Mislukt: ${errMsg(err)}`)
      }
    })

    document.getElementById('plan-export')?.addEventListener('click', () => {
      const updated = collectPlan(plan)
      const md = renderChapterMarkdown({ title: updated.title, summary: updated.summary, sections: updated.sections }, notes)
      downloadMarkdown(`${slugify(updated.title) || 'hoofdstuk'}.md`, md)
    })

    document.getElementById('plan-cancel')?.addEventListener('click', () => {
      section.style.display = 'none'
    })
  }

  function renderSaved(): void {
    const el = document.getElementById('book-saved')!
    if (chapters.length === 0) {
      el.innerHTML = '<p class="muted">Nog geen hoofdstukken opgeslagen.</p>'
      return
    }
    el.innerHTML = chapters.map(c => {
      const stats = sectionStats.get(c.id)
      const badge = stats
        ? `<span class="saved-progress">${stats.written}/${stats.total} secties geschreven${stats.words ? ` · ${stats.words} w` : ''}</span>`
        : ''
      return `
      <article class="saved-row" data-id="${c.id}">
        <header>
          <h3>${escHtml(c.title)}</h3>
          <span class="muted">${formatDate(c.created_at)}</span>
        </header>
        ${c.summary ? `<p class="muted">${escHtml(c.summary)}</p>` : ''}
        <ul class="saved-outline">
          ${c.outline.map(s => `<li><strong>${escHtml(s.heading)}</strong> <span class="muted">— ${s.note_ids.length} notities</span></li>`).join('')}
        </ul>
        <div class="saved-actions">
          <button class="btn btn-primary saved-write">Schrijf →</button>
          <button class="btn btn-ghost saved-export">Exporteer .md</button>
          <button class="btn btn-danger saved-delete">Verwijder</button>
          ${badge}
        </div>
      </article>
    `}).join('')

    el.querySelectorAll<HTMLElement>('.saved-row').forEach(row => {
      const id = row.dataset['id']!
      row.querySelector('.saved-write')?.addEventListener('click', () => {
        navigateTo('/studio?chapter=' + id)
      })
      row.querySelector('.saved-export')?.addEventListener('click', async () => {
        const c = chapters.find(x => x.id === id)
        if (!c) return
        // Prose-first: written sections export their text, the rest fall back
        // to the note-assembly of the outline.
        const sections = await resolveChapterSections(c)
        const md = renderChapterMarkdown({ title: c.title, summary: c.summary ?? '', sections }, notes)
        downloadMarkdown(`${slugify(c.title) || 'hoofdstuk'}.md`, md)
      })
      row.querySelector('.saved-delete')?.addEventListener('click', () => {
        const removed = chapters.find(x => x.id === id)
        chapters = chapters.filter(x => x.id !== id)
        renderSaved()
        showUndoToast('Hoofdstuk verwijderd',
          async () => { try { await deleteChapter(id) } catch (err) { showToast(`Verwijderen mislukt: ${errMsg(err)}`) } },
          () => {
            if (removed) chapters = [removed, ...chapters]
            renderSaved()
          })
      })
    })
  }

  function collectPlan(original: ChapterPlan): ChapterPlan {
    const title = (document.getElementById('plan-title') as HTMLInputElement).value.trim()
    const summary = (document.getElementById('plan-summary') as HTMLTextAreaElement).value.trim()
    const sections = original.sections.map((s, i) => {
      const heading = (document.querySelector(`[data-section-heading="${i}"]`) as HTMLInputElement | null)?.value.trim() ?? s.heading
      const intent = (document.querySelector(`[data-section-intent="${i}"]`) as HTMLTextAreaElement | null)?.value.trim() ?? s.intent
      const checked = Array.from(
        document.querySelectorAll<HTMLInputElement>(`[data-section-notes="${i}"] input[type=checkbox]:checked`)
      ).map(el => el.value)
      return { heading, intent, note_ids: checked }
    }).filter(s => s.heading && s.note_ids.length > 0)
    return { title, summary, sections }
  }
}

function renderSectionEditor(
  s: { heading: string; intent: string; note_ids: string[] },
  i: number,
  labelOf: (id: string) => string
): string {
  return `
    <div class="plan-section">
      <label class="field">
        <span class="field-label">Sectie ${i + 1} — kop</span>
        <input type="text" data-section-heading="${i}" value="${escHtml(s.heading)}" />
      </label>
      <label class="field">
        <span class="field-label">Intentie</span>
        <textarea data-section-intent="${i}" rows="2">${escHtml(s.intent)}</textarea>
      </label>
      <div class="field">
        <span class="field-label">Notities (${s.note_ids.length})</span>
        <div class="plan-section-notes" data-section-notes="${i}">
          ${s.note_ids.map(id => `<label class="chip-check"><input type="checkbox" value="${id}" checked/> ${escHtml(labelOf(id))}</label>`).join('')}
        </div>
      </div>
    </div>
  `
}









function injectBookStyles(): void {
  if (document.getElementById('book-styles')) return
  const style = document.createElement('style')
  style.id = 'book-styles'
  style.textContent = `
    .book-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
      padding: var(--s-4);
      padding-bottom: calc(var(--bottom-nav-h) + var(--s-4));
      max-width: 960px;
      width: 100%;
      margin: 0 auto;
    }
    #book-tabpanel {
      display: flex;
      flex-direction: column;
      gap: var(--s-5);
    }
    /* Secondary underline style: distinguishes these in-page subtabs from the
       primary Bibliotheek shell pills above them, so the two rows don't read as
       one stacked block. */
    .book-tabs {
      display: flex;
      gap: var(--s-4);
      border-bottom: 1px solid var(--border);
    }
    .book-tab {
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      padding: var(--s-2) var(--s-1);
      margin-bottom: -1px;
      cursor: pointer;
      font-size: var(--fs-sm);
      color: var(--text-muted);
    }
    .book-tab[aria-current="true"] {
      color: var(--accent);
      border-bottom-color: var(--accent);
      font-weight: 600;
    }
    /* When the Projecten subtab hosts the projects UI inside the book panel,
       drop its outer page padding/width so it isn't double-inset. */
    #book-tabpanel .proj-body {
      padding: 0;
      max-width: 100%;
    }
    .book-row {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      overflow: hidden;
      margin-bottom: var(--s-2);
    }
    .book-row-summary {
      list-style: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: var(--s-3);
      padding: var(--s-3) var(--s-4);
    }
    .book-row-summary::-webkit-details-marker { display: none; }
    .book-row-title { flex: 1; font-weight: 500; }
    .book-row-edit {
      padding: var(--s-3) var(--s-4);
      border-top: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
    }
    .book-chapter-list {
      list-style: none;
      padding-left: 0;
      display: flex;
      flex-direction: column;
      gap: var(--s-1);
    }
    .book-chapter-included {
      display: flex;
      align-items: center;
      gap: var(--s-2);
      padding: var(--s-2);
      background: var(--surface);
      border-radius: var(--r-sm);
      font-size: var(--fs-sm);
    }
    .book-chapter-included span { flex: 1; }
    .link-btn {
      background: none;
      border: 1px solid var(--border);
      border-radius: var(--r-sm);
      cursor: pointer;
      padding: 2px 8px;
      font-size: 14px;
      color: var(--text-muted);
    }
    .link-btn:hover { background: var(--bg); color: var(--text); }
    .link-btn-danger:hover { color: var(--danger); border-color: var(--danger); }
    .book-add-chapter {
      margin-top: var(--s-2);
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }
    .book-add-chapter summary {
      cursor: pointer;
      font-size: var(--fs-sm);
      color: var(--text-muted);
    }
    .book-add-chapter select { margin-right: var(--s-2); }
    .book-add-chapter .btn { width: auto; }
    .book-section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-4);
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
    }
    .book-section-header h2 {
      font-size: var(--fs-lg);
      font-weight: 600;
    }
    .book-project-scope {
      font-size: var(--fs-sm);
      color: var(--text);
      background: var(--bg);
      border-left: 3px solid var(--accent);
      border-radius: var(--r-sm);
      padding: var(--s-2) var(--s-3);
    }
    .book-controls {
      display: grid;
      grid-template-columns: 1fr 2fr;
      gap: var(--s-3);
    }
    @media (max-width: 700px) {
      .book-controls { grid-template-columns: 1fr; }
    }
    .book-notes-list {
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
      max-height: 360px;
      overflow-y: auto;
      padding: var(--s-2);
      background: var(--bg);
      border-radius: var(--r-sm);
    }
    .book-note-row {
      display: flex;
      gap: var(--s-2);
      padding: var(--s-2);
      cursor: pointer;
      border-radius: var(--r-sm);
    }
    .book-note-row:hover { background: var(--surface); }
    .book-section-group {
      display: flex;
      flex-direction: column;
      gap: var(--s-1);
      margin-bottom: var(--s-2);
    }
    .book-section-group-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--s-1) var(--s-2);
      font-size: var(--fs-sm);
      font-weight: 600;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
      margin-bottom: 2px;
    }
    .book-section-group--unsectioned .book-section-group-header {
      font-style: italic;
    }
    .book-note-text {
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: var(--fs-sm);
    }
    .book-actions {
      display: flex;
      gap: var(--s-3);
      align-items: center;
    }
    .book-actions .btn { width: auto; }
    .plan-section {
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-3);
      margin-bottom: var(--s-3);
      background: var(--bg);
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }
    .plan-section-notes {
      display: flex;
      flex-wrap: wrap;
      gap: var(--s-1);
    }
    .plan-actions {
      display: flex;
      gap: var(--s-2);
      flex-wrap: wrap;
      margin-top: var(--s-3);
    }
    .plan-actions .btn { width: auto; }
    .saved-row {
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-3);
      background: var(--bg);
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
      margin-bottom: var(--s-2);
    }
    .saved-row header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: var(--s-2);
    }
    .saved-outline {
      list-style: none;
      padding-left: 0;
      font-size: var(--fs-sm);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .saved-actions {
      display: flex;
      gap: var(--s-2);
      align-items: center;
      flex-wrap: wrap;
    }
    .saved-actions .btn { width: auto; }
    .saved-progress { font-size: var(--fs-sm); color: var(--accent); font-weight: 600; }
    .book-loading,
    .book-error,
    .book-empty {
      text-align: center;
      padding: var(--s-7);
      color: var(--text-muted);
    }
    .book-empty h2 { margin-bottom: var(--s-3); color: var(--text); }
    .book-empty a { color: var(--accent); }
  `
  document.head.appendChild(style)
}
