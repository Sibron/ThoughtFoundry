import { fetchNotes, updateNote, countByStatus, type Note } from '../lib/notes'
import {
  fetchThemes,
  createTheme,
  setThemesForNote,
  type Theme
} from '../lib/themes'
import { createLink } from '../lib/links'
import { processNote, type NoteSuggestion } from '../lib/ai'
import { getCostStatus, getMonthlyCap, setMonthlyCap, formatUsd, type CostStatus } from '../lib/cost'
import { renderTopbar, attachTopbar } from '../lib/nav'
import { navigateTo } from '../router'

export async function renderProcess(app: HTMLElement): Promise<void> {
  app.innerHTML = `
    ${renderTopbar('Verwerken', 'process')}
    <div class="process-body">
      <div id="process-cost" class="process-cost"></div>
      <div id="process-shell" class="process-shell">
        <div class="process-loading">Laden…</div>
      </div>
    </div>
    <div class="toast" id="toast"></div>
  `

  injectProcessStyles()
  attachTopbar()

  let themes: Theme[] = []
  let queue: Note[] = []
  let cursor = 0
  let currentSuggestion: NoteSuggestion | null = null
  let cost: CostStatus

  try {
    [themes, queue, cost] = await Promise.all([
      fetchThemes(),
      fetchNotes(0, 50, 'inbox'),
      getCostStatus()
    ])
  } catch (err) {
    showError(`Laden mislukt: ${errMsg(err)}`)
    return
  }

  renderCost(cost)
  if (queue.length === 0) {
    renderEmptyState()
    return
  }
  renderCurrent()

  function renderCurrent(): void {
    const note = queue[cursor]
    if (!note) {
      renderDoneState()
      return
    }

    const shell = document.getElementById('process-shell')!
    shell.innerHTML = `
      <div class="process-grid">
        <section class="process-note-pane">
          <header class="pane-header">
            <span class="pane-step">${cursor + 1} / ${queue.length}</span>
            <span class="pane-date">${formatDate(note.created_at)}</span>
          </header>
          <article class="pane-note">
            <p class="pane-content">${escHtml(note.content)}</p>
            ${note.mini_notes ? `<p class="pane-mini">${escHtml(note.mini_notes)}</p>` : ''}
            ${note.source_url ? `<a class="pane-source" target="_blank" rel="noopener" href="${escHtml(note.source_url)}">${escHtml(note.source_title ?? note.source_url)}</a>` : ''}
          </article>
          <div class="pane-actions">
            <button class="btn btn-primary" id="run-ai">AI-suggesties ophalen</button>
            <button class="btn btn-ghost" id="skip-note">Overslaan</button>
            <button class="btn btn-ghost" id="archive-note">Archiveren</button>
          </div>
        </section>
        <section class="process-suggest-pane" id="suggest-pane">
          <p class="pane-hint">Klik "AI-suggesties ophalen" om titel, samenvatting, tags, types en thema-matches te krijgen. Niets wordt opgeslagen tot je "Accepteer" klikt.</p>
        </section>
      </div>
    `

    document.getElementById('run-ai')?.addEventListener('click', runAi)
    document.getElementById('skip-note')?.addEventListener('click', () => {
      cursor++
      currentSuggestion = null
      renderCurrent()
    })
    document.getElementById('archive-note')?.addEventListener('click', async () => {
      if (!confirm('Archiveren zonder verwerken?')) return
      try {
        await updateNote(note.id, { status: 'archief' })
        showToast('Gearchiveerd')
        cursor++
        currentSuggestion = null
        renderCurrent()
      } catch (err) {
        showToast(`Mislukt: ${errMsg(err)}`)
      }
    })
  }

  async function runAi(): Promise<void> {
    const note = queue[cursor]
    if (!note) return

    const status = await getCostStatus()
    if (status.block) {
      if (!confirm(`Maandelijkse cap (${formatUsd(status.capUsd)}) bereikt. Toch doorgaan?`)) return
    } else if (status.warn) {
      if (!confirm(`Je zit op ${(status.ratio * 100).toFixed(0)}% van je maandelijkse AI-budget. Doorgaan?`)) return
    }

    const btn = document.getElementById('run-ai') as HTMLButtonElement
    btn.disabled = true
    btn.textContent = 'Bezig…'
    try {
      const { suggestion, usage } = await processNote(note.id, 'claude-haiku-4-5')
      currentSuggestion = suggestion
      renderSuggestion(note, suggestion)
      renderCost(await getCostStatus())
      showToast(`AI klaar (${formatUsd(usage.costUsd)})`)
    } catch (err) {
      showToast(`AI mislukt: ${errMsg(err)}`)
      btn.disabled = false
      btn.textContent = 'Opnieuw proberen'
    }
  }

  function renderSuggestion(note: Note, s: NoteSuggestion): void {
    const pane = document.getElementById('suggest-pane')!
    const themeOptions = themes.map(t => {
      const checked = s.matched_theme_ids.includes(t.id) ? 'checked' : ''
      return `<label class="chip-check"><input type="checkbox" value="${t.id}" ${checked}/> ${escHtml(t.name)}</label>`
    }).join('')

    const newThemeBlock = (s.new_themes ?? []).map((nt, i) => `
      <label class="chip-check chip-new">
        <input type="checkbox" data-new-idx="${i}" checked />
        + ${escHtml(nt.name)}${nt.description ? ` — <em>${escHtml(nt.description)}</em>` : ''}
      </label>
    `).join('')

    pane.innerHTML = `
      <h2 class="suggest-title">AI-suggesties</h2>

      <label class="field">
        <span class="field-label">Titel</span>
        <input type="text" id="s-title" value="${escHtml(s.title ?? '')}" />
      </label>

      <label class="field">
        <span class="field-label">Samenvatting</span>
        <textarea id="s-summary" rows="3">${escHtml(s.summary ?? '')}</textarea>
      </label>

      <label class="field">
        <span class="field-label">Types (komma-gescheiden)</span>
        <input type="text" id="s-types" value="${escHtml((s.types ?? []).join(', '))}" />
      </label>

      <label class="field">
        <span class="field-label">Tags (komma-gescheiden)</span>
        <input type="text" id="s-tags" value="${escHtml((s.tags ?? []).join(', '))}" />
      </label>

      <fieldset class="field">
        <legend class="field-label">Thema's</legend>
        <div class="chip-group">${themeOptions || '<span class="muted">Nog geen thema\'s</span>'}</div>
        ${newThemeBlock ? `<div class="chip-group chip-group-new">${newThemeBlock}</div>` : ''}
      </fieldset>

      ${s.related_note_ids.length > 0 ? `
        <fieldset class="field">
          <legend class="field-label">Gelinkte nota's (Zettelkasten)</legend>
          <div class="related-list">
            ${s.related_note_ids.map(id => {
              const t = queue.find(n => n.id === id)
              const label = t ? (t.ai_title ?? t.content.slice(0, 80)) : id
              return `<label class="chip-check"><input type="checkbox" value="${id}" checked/> ${escHtml(label)}</label>`
            }).join('')}
          </div>
        </fieldset>
      ` : ''}

      <div class="suggest-actions">
        <button class="btn btn-primary" id="accept-btn">Accepteer & volgende</button>
        <button class="btn btn-ghost" id="cancel-suggest">Annuleer</button>
      </div>
    `

    document.getElementById('accept-btn')?.addEventListener('click', () => acceptSuggestion(note))
    document.getElementById('cancel-suggest')?.addEventListener('click', () => {
      currentSuggestion = null
      renderCurrent()
    })
  }

  async function acceptSuggestion(note: Note): Promise<void> {
    if (!currentSuggestion) return
    const acceptBtn = document.getElementById('accept-btn') as HTMLButtonElement
    acceptBtn.disabled = true
    acceptBtn.textContent = 'Opslaan…'

    const title = (document.getElementById('s-title') as HTMLInputElement).value.trim()
    const summary = (document.getElementById('s-summary') as HTMLTextAreaElement).value.trim()
    const typesArr = parseCsv((document.getElementById('s-types') as HTMLInputElement).value)
    const tagsArr = parseCsv((document.getElementById('s-tags') as HTMLInputElement).value)

    const checkedThemeIds = Array.from(
      document.querySelectorAll<HTMLInputElement>('.chip-group:not(.chip-group-new) input[type=checkbox]:checked')
    ).map(el => el.value)

    const checkedNewIdxs = Array.from(
      document.querySelectorAll<HTMLInputElement>('.chip-group-new input[type=checkbox]:checked')
    ).map(el => Number(el.dataset['newIdx']))

    const checkedRelated = Array.from(
      document.querySelectorAll<HTMLInputElement>('.related-list input[type=checkbox]:checked')
    ).map(el => el.value)

    try {
      // 1) Create any newly approved themes
      const createdIds: string[] = []
      for (const idx of checkedNewIdxs) {
        const nt = currentSuggestion.new_themes[idx]
        if (!nt) continue
        const t = await createTheme({ name: nt.name, description: nt.description })
        themes.push(t)
        createdIds.push(t.id)
      }

      const allThemeIds = [...checkedThemeIds, ...createdIds]

      // 2) Update the note
      await updateNote(note.id, {
        ai_title: title || null,
        ai_summary: summary || null,
        types: typesArr,
        tags: tagsArr,
        status: 'verwerkt',
        processed_at: new Date().toISOString()
      })

      // 3) Persist theme links
      await setThemesForNote(note.id, allThemeIds)

      // 4) Persist note links (best-effort, ignore duplicates)
      for (const targetId of checkedRelated) {
        try {
          await createLink({ sourceId: note.id, targetId, reason: 'AI-suggestie' })
        } catch {
          // unique violation = already linked, ignore
        }
      }

      showToast('Verwerkt')
      cursor++
      currentSuggestion = null
      renderCurrent()
    } catch (err) {
      acceptBtn.disabled = false
      acceptBtn.textContent = 'Accepteer & volgende'
      showToast(`Opslaan mislukt: ${errMsg(err)}`)
    }
  }

  function renderEmptyState(): void {
    const shell = document.getElementById('process-shell')!
    shell.innerHTML = `
      <div class="process-empty">
        <h2>Inbox is leeg</h2>
        <p>Geen onverwerkte nota's. Capture er een nieuwe, of bekijk je verwerkte nota's in de inbox.</p>
        <div class="empty-actions">
          <button class="btn btn-primary" id="empty-capture">Nieuwe nota</button>
          <button class="btn btn-ghost" id="empty-inbox">Naar inbox</button>
        </div>
      </div>
    `
    document.getElementById('empty-capture')?.addEventListener('click', () => navigateTo('/capture'))
    document.getElementById('empty-inbox')?.addEventListener('click', () => navigateTo('/inbox'))
  }

  function renderDoneState(): void {
    const shell = document.getElementById('process-shell')!
    shell.innerHTML = `
      <div class="process-empty">
        <h2>Sessie afgerond</h2>
        <p>${queue.length} nota('s) doorlopen. Frisse pauze.</p>
        <div class="empty-actions">
          <button class="btn btn-primary" id="empty-capture">Nieuwe nota</button>
          <button class="btn btn-ghost" id="empty-inbox">Naar inbox</button>
        </div>
      </div>
    `
    document.getElementById('empty-capture')?.addEventListener('click', () => navigateTo('/capture'))
    document.getElementById('empty-inbox')?.addEventListener('click', () => navigateTo('/inbox'))
  }

  async function renderCost(status: CostStatus): Promise<void> {
    const inboxLeft = await countByStatus('inbox').catch(() => 0)
    const el = document.getElementById('process-cost')!
    const pct = (status.ratio * 100).toFixed(0)
    const cls = status.block ? 'cost-block' : status.warn ? 'cost-warn' : 'cost-ok'
    el.innerHTML = `
      <span class="cost-pill ${cls}">
        AI deze maand: <strong>${formatUsd(status.spendUsd)}</strong> / ${formatUsd(status.capUsd)} (${pct}%)
      </span>
      <span class="cost-pill cost-info">Inbox: <strong>${inboxLeft}</strong></span>
      <button class="topbar-btn" id="cap-edit">cap bijwerken</button>
    `
    document.getElementById('cap-edit')?.addEventListener('click', () => {
      const v = prompt('Maandelijkse AI-cap in USD:', String(getMonthlyCap()))
      if (v == null) return
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) {
        setMonthlyCap(n)
        getCostStatus().then(renderCost)
      }
    })
  }

  function showError(msg: string): void {
    document.getElementById('process-shell')!.innerHTML = `<div class="process-error">${escHtml(msg)}</div>`
  }
}

function showToast(msg: string): void {
  const toast = document.getElementById('toast') as HTMLDivElement | null
  if (!toast) return
  toast.textContent = msg
  toast.classList.add('show')
  setTimeout(() => toast.classList.remove('show'), 2500)
}

function parseCsv(s: string): string[] {
  return s.split(',').map(x => x.trim()).filter(Boolean)
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

function injectProcessStyles(): void {
  if (document.getElementById('process-styles')) return
  const style = document.createElement('style')
  style.id = 'process-styles'
  style.textContent = `
    .process-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
      padding: var(--s-4);
      max-width: 1200px;
      width: 100%;
      margin: 0 auto;
    }
    .process-cost {
      display: flex;
      gap: var(--s-2);
      align-items: center;
      flex-wrap: wrap;
    }
    .cost-pill {
      padding: 4px var(--s-3);
      border-radius: var(--r-sm);
      font-size: var(--fs-sm);
      background: var(--surface);
      border: 1px solid var(--border);
    }
    .cost-pill.cost-warn {
      background: #FFF7E6;
      border-color: #FFD27F;
      color: #8A5A00;
    }
    .cost-pill.cost-block {
      background: #FCE6E5;
      border-color: #F2A8A4;
      color: #8B0E04;
    }
    .process-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--s-4);
    }
    @media (max-width: 900px) {
      .process-grid { grid-template-columns: 1fr; }
    }
    .process-note-pane,
    .process-suggest-pane {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-4);
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
    }
    .pane-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: var(--fs-sm);
      color: var(--text-muted);
    }
    .pane-content {
      font-size: var(--fs-base);
      white-space: pre-wrap;
      line-height: 1.6;
    }
    .pane-mini {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      white-space: pre-wrap;
    }
    .pane-source {
      color: var(--accent);
      font-size: var(--fs-sm);
      word-break: break-all;
    }
    .pane-actions {
      display: flex;
      gap: var(--s-2);
      flex-wrap: wrap;
      margin-top: auto;
    }
    .pane-actions .btn { width: auto; }
    .pane-hint {
      font-size: var(--fs-sm);
      color: var(--text-muted);
    }
    .suggest-title {
      font-size: var(--fs-lg);
      font-weight: 600;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: var(--s-1);
    }
    .field-label {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      font-weight: 500;
    }
    .chip-group {
      display: flex;
      flex-wrap: wrap;
      gap: var(--s-2);
    }
    .chip-group-new { margin-top: var(--s-2); }
    .chip-check {
      display: inline-flex;
      align-items: center;
      gap: var(--s-1);
      padding: 4px var(--s-3);
      border-radius: var(--r-sm);
      background: var(--bg);
      border: 1px solid var(--border);
      font-size: var(--fs-sm);
      cursor: pointer;
    }
    .chip-check.chip-new {
      background: #E8F5EE;
      border-color: var(--accent);
      color: var(--accent-hover);
    }
    .related-list {
      display: flex;
      flex-direction: column;
      gap: var(--s-1);
    }
    .suggest-actions {
      display: flex;
      gap: var(--s-2);
      margin-top: var(--s-3);
    }
    .suggest-actions .btn { width: auto; }
    .process-empty {
      text-align: center;
      padding: var(--s-7);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
    }
    .process-empty h2 {
      margin-bottom: var(--s-3);
    }
    .empty-actions {
      display: inline-flex;
      gap: var(--s-2);
      margin-top: var(--s-4);
    }
    .empty-actions .btn { width: auto; }
    .process-loading,
    .process-error {
      text-align: center;
      padding: var(--s-6);
      color: var(--text-muted);
    }
    .muted { color: var(--text-muted); font-size: var(--fs-sm); }
  `
  document.head.appendChild(style)
}
