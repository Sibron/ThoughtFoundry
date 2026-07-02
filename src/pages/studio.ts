// Schrijfstudio — write and revise a chapter INSIDE the app, per section,
// with the note corpus at hand. Route: /studio?chapter=<id>. Works without AI
// (the assists arrive separately): autosaving markdown editor, preview,
// snapshot revisions, and a "Verwante gedachten" drawer that surfaces the
// section's attached notes plus semantic matches for what you're writing.

import {
  fetchChapter, fetchSections, createSection, updateSection, deleteSection,
  saveSectionOrder, saveRevision, fetchRevisions,
  type Chapter, type SectionRow
} from '../lib/chapters'
import { fetchNotesByIds, getNoteTitle, type Note } from '../lib/notes'
import { embedText, matchNotes, hasEmbeddings } from '../lib/semantic'
import { renderMarkdownHtml, countWords } from '../lib/markdown'
import { writeSection, type WriteSectionMode } from '../lib/ai'
import { createAiAction } from '../lib/ai-action'
import { renderTopbar, attachTopbar, isAiEnabled } from '../lib/nav'
import { showToast, esc, errMsg } from '../lib/crud-list'
import { navigateTo, navigateBack } from '../router'

export async function renderStudio(app: HTMLElement): Promise<void> {
  const chapterId = paramFromHash('chapter')
  app.innerHTML = `
    ${renderTopbar('Schrijfstudio', 'library')}
    <div id="studio-root"><div class="studio-loading">Laden…</div></div>
    <div class="toast" id="toast"></div>
  `
  injectStudioStyles()
  attachTopbar()

  const root = document.getElementById('studio-root')!
  if (!chapterId) {
    root.innerHTML = '<div class="studio-loading">Geen hoofdstuk gekozen. Open de studio via Bibliotheek → Boek.</div>'
    return
  }

  let chapter: Chapter | null = null
  let sections: SectionRow[] = []
  try {
    chapter = await fetchChapter(chapterId)
    sections = await fetchSections(chapterId)
  } catch (err) {
    root.innerHTML = `<div class="studio-loading">Laden mislukt: ${esc(errMsg(err))}</div>`
    return
  }
  if (!chapter) {
    root.innerHTML = '<div class="studio-loading">Hoofdstuk niet gevonden.</div>'
    return
  }

  let activeIdx = 0
  let noteCache = new Map<string, Note>()
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let previewMode = false

  render()

  function active(): SectionRow | null {
    return sections[activeIdx] ?? null
  }

  function totalWords(): number {
    return sections.reduce((sum, s) => sum + countWords(s.content_md), 0)
  }

  function render(): void {
    const c = chapter!
    root.innerHTML = `
      <div class="studio-body">
        <header class="studio-head">
          <button class="btn btn-ghost" id="studio-back">← Terug</button>
          <div class="studio-head-main">
            <h1 class="studio-title">${esc(c.title)}</h1>
            <span class="muted">${sections.length} secties · ${totalWords()} woorden</span>
          </div>
        </header>

        <div class="studio-chips" id="studio-chips">
          ${sections.map((s, i) => `
            <button class="studio-chip${i === activeIdx ? ' active' : ''}" data-idx="${i}">
              ${s.content_md?.trim() ? '✍ ' : ''}${esc(s.heading || `Sectie ${i + 1}`)}
            </button>`).join('')}
          <button class="studio-chip studio-chip-add" id="studio-add-section">+ Sectie</button>
        </div>

        <div id="studio-editor"></div>
      </div>
    `

    document.getElementById('studio-back')?.addEventListener('click', () => navigateBack('/library?tab=book'))
    document.getElementById('studio-add-section')?.addEventListener('click', onAddSection)
    root.querySelectorAll<HTMLButtonElement>('.studio-chip[data-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        flushSave()
        activeIdx = Number(btn.dataset['idx'])
        previewMode = false
        render()
      })
    })

    renderEditor()
  }

  function renderEditor(): void {
    const host = document.getElementById('studio-editor')!
    const s = active()
    if (!s) {
      host.innerHTML = '<p class="muted">Nog geen secties. Voeg er een toe met «+ Sectie».</p>'
      return
    }

    host.innerHTML = `
      <div class="studio-card">
        <div class="studio-section-meta">
          <input type="text" id="sec-heading" class="studio-heading" value="${esc(s.heading)}" placeholder="Kop van deze sectie" />
          <input type="text" id="sec-intent" class="studio-intent" value="${esc(s.intent ?? '')}" placeholder="Intentie — wat moet deze sectie doen?" />
        </div>

        <div class="studio-toolbar">
          <button class="btn btn-ghost btn-sm" id="sec-preview">${previewMode ? 'Bewerk' : 'Voorbeeld'}</button>
          <button class="btn btn-ghost btn-sm" id="sec-save-rev">Bewaar versie</button>
          <span class="studio-toolbar-spacer"></span>
          <span class="muted" id="sec-words">${countWords(s.content_md)} woorden</span>
          <span class="studio-saved" id="sec-saved"></span>
          <button class="btn btn-ghost btn-sm" id="sec-move-up" title="Sectie eerder">↑</button>
          <button class="btn btn-ghost btn-sm" id="sec-move-down" title="Sectie later">↓</button>
          <button class="btn btn-danger btn-sm" id="sec-delete" title="Sectie verwijderen">×</button>
        </div>

        ${previewMode
          ? `<div class="studio-preview">${s.content_md?.trim() ? renderMarkdownHtml(s.content_md) : '<p class="muted">Nog geen tekst.</p>'}</div>`
          : `<textarea id="sec-content" class="studio-textarea" rows="14"
               placeholder="Schrijf hier — markdown mag. Je gekoppelde gedachten staan hieronder.">${esc(s.content_md ?? '')}</textarea>`
        }

        <div id="studio-ai-host"></div>

        <details class="studio-drawer" id="studio-related">
          <summary>Verwante gedachten (${s.note_ids.length} gekoppeld)</summary>
          <div class="studio-related-body">
            <div id="studio-attached"><span class="muted">Laden…</span></div>
            <button class="btn btn-ghost btn-sm" id="studio-find-related">Vind verwante gedachten</button>
            <div id="studio-suggested"></div>
          </div>
        </details>

        <details class="studio-drawer">
          <summary>Versies</summary>
          <div id="studio-revisions" class="studio-related-body"><span class="muted">Open om te laden…</span></div>
        </details>
      </div>
    `

    wireEditor(s)
    mountAiHelp(s)
    void loadAttachedNotes(s)
  }

  // ── AI-hulp: draft / rewrite / tighten / continue — always a proposal ──────

  function mountAiHelp(s: SectionRow): void {
    const host = document.getElementById('studio-ai-host')
    if (!host || !isAiEnabled()) return

    host.innerHTML = `
      <div class="studio-ai">
        <div class="studio-ai-row">
          <select id="studio-ai-mode" aria-label="AI-hulp modus">
            <option value="draft">Schrijf deze sectie (uit je nota's)</option>
            <option value="continue">Schrijf verder</option>
            <option value="rewrite">Herschrijf selectie/tekst</option>
            <option value="tighten">Maak strakker</option>
          </select>
          <input type="text" id="studio-ai-instruction" placeholder="Aanwijzing (optioneel), bv. 'zakelijker'" />
        </div>
        <div id="studio-ai-action"></div>
        <div id="studio-ai-proposal" hidden></div>
      </div>
    `

    const modeEl = host.querySelector<HTMLSelectElement>('#studio-ai-mode')!
    const instructionEl = host.querySelector<HTMLInputElement>('#studio-ai-instruction')!

    const selectionNow = (): string => {
      const ta = document.getElementById('sec-content') as HTMLTextAreaElement | null
      if (!ta) return ''
      return ta.value.slice(ta.selectionStart, ta.selectionEnd).trim()
    }

    const action = createAiAction(host.querySelector<HTMLElement>('#studio-ai-action')!, {
      label: 'AI-hulp uitvoeren',
      defaultModel: 'claude-sonnet-4-6',
      expectedOutputTokens: 900,
      estimateInputChars: () => s.note_ids.length * 400 + (s.content_md?.length ?? 0) + 800,
      phases: ['Nota\'s doornemen…', 'Toon vangen…', 'Proza schrijven…', 'Bijschaven…'],
      beforeRun: () => {
        flushSave()
        const mode = modeEl.value as WriteSectionMode
        if (mode === 'draft' && s.note_ids.length === 0) {
          showToast('Koppel eerst gedachten aan deze sectie (drawer hieronder)'); return false
        }
        if (mode === 'continue' && !s.content_md?.trim()) {
          showToast('Er is nog geen tekst om op verder te schrijven'); return false
        }
        if ((mode === 'rewrite' || mode === 'tighten') && !s.content_md?.trim()) {
          showToast('Er is nog geen tekst om te bewerken'); return false
        }
        return true
      },
      run: async (model, overrideCap) => {
        const mode = modeEl.value as WriteSectionMode
        const selection = (mode === 'rewrite' || mode === 'tighten') ? selectionNow() : ''
        const { text, usage } = await writeSection({
          sectionId: s.id,
          mode,
          selection: selection || undefined,
          currentText: s.content_md ?? undefined,
          instruction: instructionEl.value.trim() || undefined,
          model, overrideCap
        })
        showProposal(s, mode, selection, text)
        return usage
      },
    })
    modeEl.addEventListener('change', () => action.refreshEstimate())
  }

  function showProposal(s: SectionRow, mode: WriteSectionMode, selection: string, text: string): void {
    const panel = document.getElementById('studio-ai-proposal')
    if (!panel) return

    const replacesSelection = (mode === 'rewrite' || mode === 'tighten') && !!selection
    const actions: { key: string; label: string }[] = []
    if (mode === 'draft' || mode === 'rewrite' || mode === 'tighten') {
      actions.push({ key: 'replace', label: replacesSelection ? 'Vervang selectie' : 'Vervang sectietekst' })
    }
    if (mode === 'draft' || mode === 'continue') {
      actions.push({ key: 'append', label: 'Voeg toe onderaan' })
    }
    actions.push({ key: 'cancel', label: 'Annuleer' })

    panel.hidden = false
    panel.innerHTML = `
      <div class="studio-proposal">
        <div class="studio-proposal-head">Voorstel van AI — jij beslist</div>
        <div class="studio-proposal-body">${renderMarkdownHtml(text)}</div>
        <div class="studio-proposal-actions">
          ${actions.map(a => `<button class="btn ${a.key === 'cancel' ? 'btn-ghost' : 'btn-primary'} btn-sm" data-proposal="${a.key}">${esc(a.label)}</button>`).join('')}
        </div>
      </div>
    `
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' })

    panel.querySelectorAll<HTMLButtonElement>('[data-proposal]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const act = btn.dataset['proposal']
        if (act === 'cancel') { panel.hidden = true; panel.innerHTML = ''; return }
        try {
          // ALWAYS snapshot the pre-AI text so the change is undoable.
          if (s.content_md?.trim()) await saveRevision(s.id, s.content_md, 'voor AI-wijziging')

          if (act === 'append') {
            s.content_md = [s.content_md?.trimEnd(), text].filter(Boolean).join('\n\n')
          } else if (replacesSelection && s.content_md) {
            s.content_md = s.content_md.replace(selection, text)
          } else {
            s.content_md = text
          }
          await updateSection(s.id, { content_md: s.content_md })
          previewMode = false
          renderEditor()
          showToast('Toegepast — vorige versie staat onder Versies')
        } catch (err) {
          showToast(`Toepassen mislukt: ${errMsg(err)}`)
        }
      })
    })
  }

  function wireEditor(s: SectionRow): void {
    const savedEl = () => document.getElementById('sec-saved')

    document.getElementById('sec-heading')?.addEventListener('input', (e) => {
      s.heading = (e.target as HTMLInputElement).value
      scheduleSave(s, { heading: s.heading })
      const chip = root.querySelector(`.studio-chip[data-idx="${activeIdx}"]`)
      if (chip) chip.textContent = `${s.content_md?.trim() ? '✍ ' : ''}${s.heading || `Sectie ${activeIdx + 1}`}`
    })
    document.getElementById('sec-intent')?.addEventListener('input', (e) => {
      s.intent = (e.target as HTMLInputElement).value
      scheduleSave(s, { intent: s.intent })
    })

    const textarea = document.getElementById('sec-content') as HTMLTextAreaElement | null
    textarea?.addEventListener('input', () => {
      s.content_md = textarea.value
      const words = document.getElementById('sec-words')
      if (words) words.textContent = `${countWords(s.content_md)} woorden`
      savedEl()?.replaceChildren()
      scheduleSave(s, { content_md: s.content_md })
    })

    document.getElementById('sec-preview')?.addEventListener('click', () => {
      flushSave()
      previewMode = !previewMode
      renderEditor()
    })

    document.getElementById('sec-save-rev')?.addEventListener('click', async () => {
      if (!s.content_md?.trim()) { showToast('Nog geen tekst om te bewaren'); return }
      try {
        await saveRevision(s.id, s.content_md, 'handmatig')
        showToast('Versie bewaard')
      } catch (err) { showToast(`Mislukt: ${errMsg(err)}`) }
    })

    document.getElementById('sec-move-up')?.addEventListener('click', () => moveSection(-1))
    document.getElementById('sec-move-down')?.addEventListener('click', () => moveSection(1))
    document.getElementById('sec-delete')?.addEventListener('click', async () => {
      if (!confirm(`Sectie «${s.heading}» verwijderen?${s.content_md?.trim() ? ' De geschreven tekst gaat verloren.' : ''}`)) return
      try {
        await deleteSection(s.id)
        sections = sections.filter(x => x.id !== s.id)
        activeIdx = Math.max(0, activeIdx - 1)
        await saveSectionOrder(sections.map(x => x.id))
        render()
        showToast('Sectie verwijderd')
      } catch (err) { showToast(`Mislukt: ${errMsg(err)}`) }
    })

    document.getElementById('studio-find-related')?.addEventListener('click', () => void findRelated(s))

    // Lazy-load revisions when the drawer opens.
    const revDrawer = root.querySelectorAll<HTMLDetailsElement>('.studio-drawer')[1]
    revDrawer?.addEventListener('toggle', () => {
      if (revDrawer.open) void loadRevisions(s)
    }, { once: true })
  }

  function scheduleSave(s: SectionRow, patch: Parameters<typeof updateSection>[1]): void {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      saveTimer = null
      try {
        await updateSection(s.id, patch)
        const el = document.getElementById('sec-saved')
        if (el) {
          el.textContent = 'Opgeslagen ✓'
          setTimeout(() => { if (el.textContent === 'Opgeslagen ✓') el.textContent = '' }, 2000)
        }
      } catch (err) {
        showToast(`Opslaan mislukt: ${errMsg(err)}`)
      }
    }, 800)
  }

  function flushSave(): void {
    // Fire the pending debounce immediately (best-effort) before view changes.
    if (!saveTimer) return
    clearTimeout(saveTimer)
    saveTimer = null
    const s = active()
    if (s) void updateSection(s.id, { heading: s.heading, intent: s.intent, content_md: s.content_md }).catch(() => {})
  }

  async function moveSection(dir: -1 | 1): Promise<void> {
    const to = activeIdx + dir
    if (to < 0 || to >= sections.length) return
    flushSave()
    const [moved] = sections.splice(activeIdx, 1)
    sections.splice(to, 0, moved)
    activeIdx = to
    try { await saveSectionOrder(sections.map(x => x.id)) }
    catch (err) { showToast(`Volgorde opslaan mislukt: ${errMsg(err)}`) }
    render()
  }

  async function onAddSection(): Promise<void> {
    flushSave()
    try {
      const created = await createSection(chapterId!, {
        position: sections.length,
        heading: `Sectie ${sections.length + 1}`,
      })
      sections.push(created)
      activeIdx = sections.length - 1
      previewMode = false
      render()
    } catch (err) { showToast(`Mislukt: ${errMsg(err)}`) }
  }

  // ── Verwante gedachten ────────────────────────────────────────────────────

  async function loadAttachedNotes(s: SectionRow): Promise<void> {
    const host = document.getElementById('studio-attached')
    if (!host) return
    if (s.note_ids.length === 0) {
      host.innerHTML = '<span class="muted">Nog geen gedachten aan deze sectie gekoppeld.</span>'
      return
    }
    try {
      const missing = s.note_ids.filter(id => !noteCache.has(id))
      if (missing.length) {
        (await fetchNotesByIds(missing)).forEach(n => noteCache.set(n.id, n))
      }
      host.innerHTML = s.note_ids.map(id => {
        const n = noteCache.get(id)
        if (!n) return ''
        return `
          <div class="studio-note" data-note="${id}">
            <button type="button" class="studio-note-open" data-open="${id}">
              <span class="studio-note-title">${esc(getNoteTitle(n, 70))}</span>
              <span class="studio-note-snippet">${esc((n.ai_summary ?? n.content).slice(0, 120))}</span>
            </button>
            <button type="button" class="btn btn-ghost btn-sm" data-unlink="${id}" title="Los van deze sectie">×</button>
          </div>`
      }).join('')
      wireNoteRows(host, s)
    } catch {
      host.innerHTML = '<span class="muted">Gedachten laden mislukt.</span>'
    }
  }

  function wireNoteRows(host: HTMLElement, s: SectionRow): void {
    host.querySelectorAll<HTMLButtonElement>('[data-open]').forEach(b =>
      b.addEventListener('click', () => navigateTo('/note?id=' + b.dataset['open'])))
    host.querySelectorAll<HTMLButtonElement>('[data-unlink]').forEach(b =>
      b.addEventListener('click', async () => {
        s.note_ids = s.note_ids.filter(id => id !== b.dataset['unlink'])
        try {
          await updateSection(s.id, { note_ids: s.note_ids })
          await loadAttachedNotes(s)
        } catch (err) { showToast(`Mislukt: ${errMsg(err)}`) }
      }))
  }

  async function findRelated(s: SectionRow): Promise<void> {
    const btn = document.getElementById('studio-find-related') as HTMLButtonElement | null
    const host = document.getElementById('studio-suggested')
    if (!btn || !host) return
    btn.disabled = true
    btn.textContent = 'Zoeken op betekenis…'
    try {
      if (!(await hasEmbeddings())) {
        host.innerHTML = '<span class="muted">Nog geen semantische index — activeer embeddings via Instellingen.</span>'
        return
      }
      // What you're writing beats what you planned: prefer the live prose.
      const seed = (s.content_md?.trim() || [s.heading, s.intent].filter(Boolean).join('\n')).slice(0, 2000)
      if (!seed) { showToast('Schrijf eerst iets of geef de sectie een kop'); return }
      const vec = await embedText(seed)
      const hits = (await matchNotes(vec, 8)).filter(h => h.similarity >= 0.45 && !s.note_ids.includes(h.id))
      if (hits.length === 0) {
        host.innerHTML = '<span class="muted">Geen nieuwe verwante gedachten gevonden.</span>'
        return
      }
      const notes = await fetchNotesByIds(hits.map(h => h.id))
      notes.forEach(n => noteCache.set(n.id, n))
      const simById = new Map(hits.map(h => [h.id, h.similarity]))
      notes.sort((a, b) => (simById.get(b.id) ?? 0) - (simById.get(a.id) ?? 0))
      host.innerHTML = notes.map(n => `
        <div class="studio-note studio-note--suggested">
          <button type="button" class="studio-note-open" data-open="${n.id}">
            <span class="studio-note-title">${esc(getNoteTitle(n, 70))} <span class="studio-sim">${Math.round((simById.get(n.id) ?? 0) * 100)}%</span></span>
            <span class="studio-note-snippet">${esc((n.ai_summary ?? n.content).slice(0, 120))}</span>
          </button>
          <button type="button" class="btn btn-ghost btn-sm" data-attach="${n.id}">Koppel aan sectie</button>
        </div>`).join('')
      host.querySelectorAll<HTMLButtonElement>('[data-open]').forEach(b =>
        b.addEventListener('click', () => navigateTo('/note?id=' + b.dataset['open'])))
      host.querySelectorAll<HTMLButtonElement>('[data-attach]').forEach(b =>
        b.addEventListener('click', async () => {
          const id = b.dataset['attach']!
          if (s.note_ids.includes(id)) return
          s.note_ids = [...s.note_ids, id]
          try {
            await updateSection(s.id, { note_ids: s.note_ids })
            b.closest('.studio-note')?.remove()
            await loadAttachedNotes(s)
            showToast('Gekoppeld aan sectie')
          } catch (err) { showToast(`Mislukt: ${errMsg(err)}`) }
        }))
    } catch (err) {
      showToast(`Zoeken mislukt: ${errMsg(err)}`)
    } finally {
      btn.disabled = false
      btn.textContent = 'Vind verwante gedachten'
    }
  }

  // ── Versies ───────────────────────────────────────────────────────────────

  async function loadRevisions(s: SectionRow): Promise<void> {
    const host = document.getElementById('studio-revisions')
    if (!host) return
    try {
      const revs = await fetchRevisions(s.id)
      if (revs.length === 0) {
        host.innerHTML = '<span class="muted">Nog geen versies. «Bewaar versie» maakt een snapshot.</span>'
        return
      }
      host.innerHTML = revs.map(r => `
        <div class="studio-rev">
          <span class="studio-rev-meta">${formatDateTime(r.created_at)}${r.label ? ` · ${esc(r.label)}` : ''} · ${countWords(r.content_md)} w</span>
          <button class="btn btn-ghost btn-sm" data-restore="${r.id}">Herstel</button>
        </div>`).join('')
      host.querySelectorAll<HTMLButtonElement>('[data-restore]').forEach(b =>
        b.addEventListener('click', async () => {
          const rev = revs.find(r => r.id === b.dataset['restore'])
          if (!rev) return
          try {
            // Snapshot the CURRENT text first so a restore is itself undoable.
            if (s.content_md?.trim()) await saveRevision(s.id, s.content_md, 'voor herstel')
            s.content_md = rev.content_md
            await updateSection(s.id, { content_md: s.content_md })
            previewMode = false
            renderEditor()
            showToast('Versie hersteld')
          } catch (err) { showToast(`Mislukt: ${errMsg(err)}`) }
        }))
    } catch {
      host.innerHTML = '<span class="muted">Versies laden mislukt.</span>'
    }
  }
}

function paramFromHash(key: string): string | null {
  const hash = window.location.hash.slice(1)
  const qIndex = hash.indexOf('?')
  if (qIndex === -1) return null
  return new URLSearchParams(hash.slice(qIndex + 1)).get(key)
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function injectStudioStyles(): void {
  if (document.getElementById('studio-styles')) return
  const style = document.createElement('style')
  style.id = 'studio-styles'
  style.textContent = `
    .studio-loading { padding: var(--s-6); text-align: center; color: var(--text-muted); }
    .studio-body {
      flex: 1; display: flex; flex-direction: column; gap: var(--s-3);
      padding: var(--s-4);
      padding-bottom: calc(var(--bottom-nav-h) + var(--s-4));
      max-width: 860px; width: 100%; margin: 0 auto;
    }
    .studio-head { display: flex; gap: var(--s-3); align-items: flex-start; }
    .studio-head .btn { width: auto; }
    .studio-head-main { display: flex; flex-direction: column; gap: 2px; }
    .studio-title { font-size: var(--fs-xl, 1.4rem); font-weight: 600; font-family: var(--font-brand); }
    .studio-chips { display: flex; gap: var(--s-1); flex-wrap: wrap; }
    .studio-chip {
      border: 1px solid var(--border); border-radius: var(--r-sm);
      background: var(--bg); color: var(--text-muted);
      padding: 5px var(--s-3); font-size: var(--fs-sm); cursor: pointer;
      max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .studio-chip.active { border-color: var(--accent); color: var(--accent); background: var(--surface); font-weight: 600; }
    .studio-chip-add { border-style: dashed; }
    .studio-card {
      background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md);
      padding: var(--s-4); display: flex; flex-direction: column; gap: var(--s-3);
    }
    .studio-section-meta { display: flex; flex-direction: column; gap: var(--s-2); }
    .studio-heading { font-size: var(--fs-lg); font-weight: 600; font-family: var(--font-brand); }
    .studio-intent { font-size: var(--fs-sm); font-style: italic; }
    .studio-toolbar { display: flex; gap: var(--s-2); align-items: center; flex-wrap: wrap; }
    .studio-toolbar .btn { width: auto; }
    .studio-toolbar-spacer { flex: 1; }
    .studio-saved { font-size: var(--fs-sm); color: var(--accent); min-width: 90px; }
    .studio-textarea {
      width: 100%; font-family: var(--font-sans); font-size: var(--fs-base);
      line-height: 1.7; resize: vertical; min-height: 320px;
    }
    .studio-preview { line-height: 1.7; min-height: 320px; }
    .studio-preview h2, .studio-preview h3 { font-family: var(--font-brand); margin: var(--s-3) 0 var(--s-1); }
    .studio-preview p { margin-bottom: var(--s-2); }
    .studio-preview ul, .studio-preview ol { padding-left: var(--s-5); margin-bottom: var(--s-2); }
    .studio-preview blockquote {
      border-left: 3px solid var(--accent); padding-left: var(--s-3);
      color: var(--text-muted); margin: var(--s-2) 0;
    }
    .studio-drawer { border-top: 1px solid var(--border); padding-top: var(--s-2); }
    .studio-drawer summary { cursor: pointer; font-size: var(--fs-sm); color: var(--text-muted); font-weight: 500; }
    .studio-related-body { display: flex; flex-direction: column; gap: var(--s-2); padding-top: var(--s-2); }
    .studio-related-body .btn { width: auto; align-self: flex-start; }
    .studio-note {
      display: flex; gap: var(--s-2); align-items: center;
      background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-sm);
      padding: var(--s-1) var(--s-2);
    }
    .studio-note--suggested { border-left: 3px solid var(--accent); }
    .studio-note-open { flex: 1; text-align: left; background: none; border: none; cursor: pointer; display: flex; flex-direction: column; gap: 1px; padding: 2px; }
    .studio-note-title { font-size: var(--fs-sm); font-weight: 600; color: var(--text); }
    .studio-note-snippet { font-size: var(--fs-sm); color: var(--text-muted); }
    .studio-sim { color: var(--accent); font-weight: 600; }
    .studio-note .btn { flex-shrink: 0; }
    .studio-rev { display: flex; gap: var(--s-2); align-items: center; justify-content: space-between; font-size: var(--fs-sm); }
    .studio-rev-meta { color: var(--text-muted); }
    .studio-rev .btn { width: auto; }
    .studio-ai { display: flex; flex-direction: column; gap: var(--s-2); border-top: 1px solid var(--border); padding-top: var(--s-3); }
    .studio-ai-row { display: flex; gap: var(--s-2); flex-wrap: wrap; }
    .studio-ai-row select { max-width: 280px; }
    .studio-ai-row input { flex: 1; min-width: 180px; }
    .studio-proposal {
      border: 1px solid var(--accent); border-radius: var(--r-md);
      padding: var(--s-3); display: flex; flex-direction: column; gap: var(--s-2);
      background: var(--bg);
    }
    .studio-proposal-head { font-size: var(--fs-sm); font-weight: 600; color: var(--accent); }
    .studio-proposal-body { line-height: 1.7; max-height: 40vh; overflow-y: auto; }
    .studio-proposal-body p { margin-bottom: var(--s-2); }
    .studio-proposal-actions { display: flex; gap: var(--s-2); flex-wrap: wrap; }
    .studio-proposal-actions .btn { width: auto; }
    .muted { color: var(--text-muted); font-size: var(--fs-sm); }
  `
  document.head.appendChild(style)
}
