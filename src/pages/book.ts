import { fetchNotes, type Note } from '../lib/notes'
import { fetchThemes, fetchAllNoteThemes, type Theme } from '../lib/themes'
import { fetchChapters, saveChapter, deleteChapter, type Chapter } from '../lib/chapters'
import { generateChapter, type ChapterPlan } from '../lib/ai'
import { getCostStatus, formatUsd } from '../lib/cost'
import { signOut } from '../lib/auth'
import { navigateTo } from '../router'

export async function renderBook(app: HTMLElement): Promise<void> {
  app.innerHTML = `
    <div class="topbar">
      <span class="topbar-title">Boek</span>
      <div class="topbar-actions">
        <button class="topbar-btn" id="goto-capture">+ Nieuw</button>
        <button class="topbar-btn" id="goto-inbox">Inbox</button>
        <button class="topbar-btn" id="goto-process">Verwerken</button>
        <button class="topbar-btn" id="goto-graph">Graaf</button>
        <button class="topbar-btn" id="logout-btn" title="Afmelden">&#x238B;</button>
      </div>
    </div>
    <div class="book-body" id="book-body">
      <div class="book-loading">Laden…</div>
    </div>
    <div class="toast" id="toast"></div>
  `

  injectBookStyles()
  attachTopbar()

  let notes: Note[] = []
  let themes: Theme[] = []
  let noteThemes: { note_id: string; theme_id: string }[] = []
  let chapters: Chapter[] = []

  try {
    [notes, themes, noteThemes, chapters] = await Promise.all([
      fetchNotes(0, 500, 'verwerkt'),
      fetchThemes(),
      fetchAllNoteThemes(),
      fetchChapters()
    ])
  } catch (err) {
    document.getElementById('book-body')!.innerHTML =
      `<div class="book-error">Laden mislukt: ${escHtml(errMsg(err))}</div>`
    return
  }

  if (notes.length === 0) {
    document.getElementById('book-body')!.innerHTML = `
      <div class="book-empty">
        <h2>Nog geen verwerkte nota's</h2>
        <p>Hoofdstukken bouwen zich uit verwerkte nota's. Ga eerst door je inbox in <a href="#/process">Verwerken</a>.</p>
      </div>
    `
    return
  }

  renderShell()

  function renderShell(): void {
    const body = document.getElementById('book-body')!
    body.innerHTML = `
      <section class="book-section">
        <header class="book-section-header">
          <h2>Hoofdstuk-werkbank</h2>
          <p class="muted">Selecteer een thema, kies nota's, en laat AI een hoofdstukschets voorstellen.</p>
        </header>

        <div class="book-controls">
          <label class="field">
            <span class="field-label">Thema</span>
            <select id="book-theme">
              <option value="">— alle nota's —</option>
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
          <button class="btn btn-primary" id="generate-btn" disabled>Genereer hoofdstuk</button>
          <span id="generate-info" class="muted"></span>
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
    themeSelect.addEventListener('change', () => renderNoteList())
    renderNoteList()
    renderSaved()

    document.getElementById('generate-btn')?.addEventListener('click', onGenerate)
  }

  function selectedNoteIds(): string[] {
    return Array.from(
      document.querySelectorAll<HTMLInputElement>('#book-notes-list input[type=checkbox]:checked')
    ).map(el => el.value)
  }

  function renderNoteList(): void {
    const themeId = (document.getElementById('book-theme') as HTMLSelectElement).value
    const filtered = themeId
      ? notes.filter(n => noteThemes.some(nt => nt.note_id === n.id && nt.theme_id === themeId))
      : notes

    const listEl = document.getElementById('book-notes-list')!
    if (filtered.length === 0) {
      listEl.innerHTML = '<p class="muted">Geen verwerkte nota\'s in dit thema.</p>'
      updateGenerateState()
      return
    }
    listEl.innerHTML = filtered.map(n => `
      <label class="book-note-row">
        <input type="checkbox" value="${n.id}" checked />
        <div class="book-note-text">
          <strong>${escHtml(n.ai_title ?? n.content.slice(0, 80))}</strong>
          <span class="muted">${escHtml((n.ai_summary ?? n.content).slice(0, 140))}</span>
        </div>
      </label>
    `).join('')
    listEl.querySelectorAll('input').forEach(el => el.addEventListener('change', updateGenerateState))
    updateGenerateState()
  }

  function updateGenerateState(): void {
    const ids = selectedNoteIds()
    const btn = document.getElementById('generate-btn') as HTMLButtonElement
    const info = document.getElementById('generate-info')!
    btn.disabled = ids.length < 2
    info.textContent = ids.length < 2
      ? 'Selecteer minimaal 2 nota\'s.'
      : `${ids.length} nota's geselecteerd.`
  }

  async function onGenerate(): Promise<void> {
    const ids = selectedNoteIds()
    if (ids.length < 2) return

    const status = await getCostStatus()
    if (status.block) {
      if (!confirm(`Maandelijkse cap (${formatUsd(status.capUsd)}) bereikt. Doorgaan?`)) return
    } else if (status.warn) {
      if (!confirm(`Je zit op ${(status.ratio * 100).toFixed(0)}% van je budget. Doorgaan?`)) return
    }

    const themeId = (document.getElementById('book-theme') as HTMLSelectElement).value || undefined
    const angle = (document.getElementById('book-angle') as HTMLInputElement).value.trim() || undefined

    const btn = document.getElementById('generate-btn') as HTMLButtonElement
    btn.disabled = true
    btn.textContent = 'AI denkt na…'

    try {
      const { plan, usage } = await generateChapter({
        noteIds: ids, themeId, angle, model: 'claude-sonnet-4-6'
      })
      showPlanEditor(plan, ids, themeId ?? null)
      showToast(`Hoofdstuk gegenereerd (${formatUsd(usage.costUsd)})`)
    } catch (err) {
      showToast(`Mislukt: ${errMsg(err)}`)
    } finally {
      btn.disabled = false
      btn.textContent = 'Genereer hoofdstuk'
    }
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
        ${plan.sections.map((s, i) => renderSectionEditor(s, i)).join('')}
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
      const md = renderMarkdown(updated, notes)
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
    el.innerHTML = chapters.map(c => `
      <article class="saved-row" data-id="${c.id}">
        <header>
          <h3>${escHtml(c.title)}</h3>
          <span class="muted">${formatDate(c.created_at)}</span>
        </header>
        ${c.summary ? `<p class="muted">${escHtml(c.summary)}</p>` : ''}
        <ul class="saved-outline">
          ${c.outline.map(s => `<li><strong>${escHtml(s.heading)}</strong> <span class="muted">— ${s.note_ids.length} nota's</span></li>`).join('')}
        </ul>
        <div class="saved-actions">
          <button class="btn btn-ghost saved-export">Exporteer .md</button>
          <button class="btn btn-danger saved-delete">Verwijder</button>
        </div>
      </article>
    `).join('')

    el.querySelectorAll<HTMLElement>('.saved-row').forEach(row => {
      const id = row.dataset['id']!
      row.querySelector('.saved-export')?.addEventListener('click', () => {
        const c = chapters.find(x => x.id === id)
        if (!c) return
        const md = renderMarkdown(
          { title: c.title, summary: c.summary ?? '', sections: c.outline },
          notes
        )
        downloadMarkdown(`${slugify(c.title) || 'hoofdstuk'}.md`, md)
      })
      row.querySelector('.saved-delete')?.addEventListener('click', async () => {
        if (!confirm('Hoofdstuk verwijderen?')) return
        try {
          await deleteChapter(id)
          chapters = chapters.filter(x => x.id !== id)
          renderSaved()
          showToast('Verwijderd')
        } catch (err) {
          showToast(`Mislukt: ${errMsg(err)}`)
        }
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

function renderSectionEditor(s: { heading: string; intent: string; note_ids: string[] }, i: number): string {
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
        <span class="field-label">Nota's (${s.note_ids.length})</span>
        <div class="plan-section-notes" data-section-notes="${i}">
          ${s.note_ids.map(id => `<label class="chip-check"><input type="checkbox" value="${id}" checked/> ${id.slice(0, 8)}…</label>`).join('')}
        </div>
      </div>
    </div>
  `
}

function renderMarkdown(plan: { title: string; summary: string; sections: { heading: string; intent: string; note_ids: string[] }[] }, notes: Note[]): string {
  const byId: Record<string, Note> = {}
  notes.forEach(n => { byId[n.id] = n })

  const lines: string[] = []
  lines.push(`# ${plan.title}`, '')
  if (plan.summary) lines.push(`> ${plan.summary}`, '')

  plan.sections.forEach(s => {
    lines.push(`## ${s.heading}`, '')
    if (s.intent) lines.push(`*${s.intent}*`, '')
    s.note_ids.forEach(id => {
      const n = byId[id]
      if (!n) return
      const head = n.ai_title ?? n.content.slice(0, 80)
      lines.push(`### ${head}`, '')
      lines.push(n.content, '')
      if (n.mini_notes) lines.push(`> ${n.mini_notes}`, '')
      if (n.source_url) lines.push(`[bron](${n.source_url})`, '')
    })
  })

  lines.push('---', `*Gegenereerd via ThoughtFoundry — ${new Date().toLocaleDateString('nl-NL')}*`)
  return lines.join('\n')
}

function downloadMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
}

function attachTopbar(): void {
  document.getElementById('goto-capture')?.addEventListener('click', () => navigateTo('/capture'))
  document.getElementById('goto-inbox')?.addEventListener('click', () => navigateTo('/inbox'))
  document.getElementById('goto-process')?.addEventListener('click', () => navigateTo('/process'))
  document.getElementById('goto-graph')?.addEventListener('click', () => navigateTo('/graph'))
  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    await signOut()
    navigateTo('/login')
  })
}

function showToast(msg: string): void {
  const toast = document.getElementById('toast') as HTMLDivElement | null
  if (!toast) return
  toast.textContent = msg
  toast.classList.add('show')
  setTimeout(() => toast.classList.remove('show'), 2500)
}

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'onbekende fout'
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' })
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
      gap: var(--s-5);
      padding: var(--s-4);
      max-width: 960px;
      width: 100%;
      margin: 0 auto;
    }
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
    }
    .saved-actions .btn { width: auto; }
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
