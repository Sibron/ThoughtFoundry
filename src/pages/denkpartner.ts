import { runDenkpartner, type DenkpartnerQuestion } from '../lib/ai'
import { fetchThemes, type Theme } from '../lib/themes'
import { getCostStatus, formatUsd, type CostStatus } from '../lib/cost'
import { insertNote } from '../lib/notes'
import { renderTopbar, attachTopbar } from '../lib/nav'

export async function renderDenkpartner(app: HTMLElement): Promise<void> {
  app.innerHTML = `
    ${renderTopbar('Denkpartner', 'denkpartner')}
    <div id="dp-root"></div>
    <div class="toast" id="toast"></div>
  `
  attachTopbar()
  await mountDenkpartner(document.getElementById('dp-root')!)
}

export async function mountDenkpartner(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="dp-body">
      <div class="dp-card">
        <p class="dp-intro">
          Denkpartner analyseert jouw nota's en stelt 4-5 scherpe vragen die je blinde vlekken blootleggen. Jij typt je antwoorden — die worden direct opgeslagen als nieuwe nota's.
        </p>

        <fieldset class="field dp-scope">
          <legend class="field-label">Bereik</legend>
          <div class="scope-row">
            <label class="scope-opt"><input type="radio" name="scope" value="all" checked /> Alle nota's</label>
            <label class="scope-opt"><input type="radio" name="scope" value="tag" /> Op tag</label>
            <label class="scope-opt"><input type="radio" name="scope" value="theme" /> Op thema</label>
          </div>
          <div id="scope-detail" class="scope-detail" hidden>
            <input type="text" id="scope-tag" placeholder="tagwaarde" class="scope-tag" hidden />
            <select id="scope-theme" hidden></select>
          </div>
        </fieldset>

        <div class="dp-actions">
          <button class="btn btn-primary" id="dp-run">Vragen genereren</button>
          <span id="dp-cost" class="cost-note"></span>
        </div>
      </div>

      <div id="dp-questions" class="dp-questions" hidden></div>

      <div id="dp-save-all" hidden>
        <button class="btn btn-primary" id="btn-save-all">Alle antwoorden opslaan als nota's</button>
        <p class="muted">Lege antwoorden worden overgeslagen. De tag <code>denkpartner</code> wordt automatisch toegevoegd.</p>
      </div>
    </div>
  `

  injectDpStyles()

  let themes: Theme[] = []
  let questions: DenkpartnerQuestion[] = []

  try {
    themes = await fetchThemes()
    const themeSelect = document.getElementById('scope-theme') as HTMLSelectElement
    themeSelect.innerHTML = themes.map(t => `<option value="${t.id}">${escHtml(t.name)}</option>`).join('')
  } catch { /* non-critical */ }

  try {
    const cost = await getCostStatus()
    renderCostNote(cost)
  } catch { /* non-critical */ }

  // Scope radio logic
  document.querySelectorAll<HTMLInputElement>('input[name="scope"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const detail = document.getElementById('scope-detail') as HTMLDivElement
      const tagInput = document.getElementById('scope-tag') as HTMLInputElement
      const themeSelect = document.getElementById('scope-theme') as HTMLSelectElement
      const v = radio.value
      detail.hidden = v === 'all'
      tagInput.hidden = v !== 'tag'
      themeSelect.hidden = v !== 'theme'
    })
  })

  document.getElementById('dp-run')?.addEventListener('click', onRun)

  async function onRun(): Promise<void> {
    const scope = (document.querySelector<HTMLInputElement>('input[name="scope"]:checked')?.value ?? 'all') as 'all' | 'tag' | 'theme'
    const tag = (document.getElementById('scope-tag') as HTMLInputElement).value.trim()
    const themeId = (document.getElementById('scope-theme') as HTMLSelectElement).value

    if (scope === 'tag' && !tag) { showToast('Voer een tag in'); return }
    if (scope === 'theme' && !themeId) { showToast('Selecteer een thema'); return }

    const btn = document.getElementById('dp-run') as HTMLButtonElement
    btn.disabled = true
    btn.textContent = 'Bezig…'

    try {
      const result = await runDenkpartner({ scope, tag: scope === 'tag' ? tag : undefined, themeId: scope === 'theme' ? themeId : undefined })

      if (!result.questions.length) {
        showToast(result.message ?? 'Geen vragen gegenereerd.')
        return
      }

      questions = result.questions
      renderQuestions(questions)

      const freshCost = await getCostStatus()
      renderCostNote(freshCost)
    } catch (err) {
      showToast(`Denkpartner mislukt: ${errMsg(err)}`)
    } finally {
      btn.disabled = false
      btn.textContent = 'Vragen genereren'
    }
  }

  function renderQuestions(qs: DenkpartnerQuestion[]): void {
    const el = document.getElementById('dp-questions') as HTMLDivElement
    el.hidden = false
    el.innerHTML = `
      <h2 class="dp-q-title">Jouw vragen</h2>
      ${qs.map((q, i) => `
        <div class="dp-q-block">
          <p class="dp-question">${i + 1}. ${escHtml(q.question)}</p>
          <p class="dp-context">${escHtml(q.context)}</p>
          <textarea id="dp-answer-${i}" class="dp-answer" rows="3" placeholder="Jouw antwoord (optioneel)…"></textarea>
        </div>
      `).join('')}
    `
    const saveAll = document.getElementById('dp-save-all') as HTMLDivElement
    saveAll.hidden = false
    document.getElementById('btn-save-all')?.addEventListener('click', onSaveAll)
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  async function onSaveAll(): Promise<void> {
    const btn = document.getElementById('btn-save-all') as HTMLButtonElement
    btn.disabled = true
    btn.textContent = 'Opslaan…'

    let saved = 0
    let failed = 0
    let lastErr = ''
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      const answer = (document.getElementById(`dp-answer-${i}`) as HTMLTextAreaElement)?.value.trim()
      if (!answer) continue
      try {
        await insertNote({
          content: answer,
          mini_notes: `Vraag: ${q.question}`,
          tags: ['denkpartner'],
        })
        saved++
      } catch (err) {
        failed++
        lastErr = errMsg(err)
      }
    }

    if (saved > 0 && failed === 0) {
      showToast(`${saved} antwoord${saved === 1 ? '' : 'en'} opgeslagen als nota${saved === 1 ? '' : "'s"}`)
      document.getElementById('dp-questions')!.hidden = true
      document.getElementById('dp-save-all')!.hidden = true
      questions = []
    } else if (saved > 0 && failed > 0) {
      // Keep the form open so the unsaved answers aren't lost.
      showToast(`${saved} opgeslagen, ${failed} mislukt (${lastErr}). Probeer de rest opnieuw.`)
    } else if (failed > 0) {
      showToast(`Opslaan mislukt: ${lastErr}`)
    } else {
      showToast('Geen antwoorden om op te slaan')
    }

    btn.disabled = false
    btn.textContent = 'Alle antwoorden opslaan als nota\'s'
  }

  function renderCostNote(cost: CostStatus): void {
    const el = document.getElementById('dp-cost')
    if (!el) return
    el.textContent = `AI deze maand: ${formatUsd(cost.spendUsd)} / ${formatUsd(cost.capUsd)}`
  }
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

function injectDpStyles(): void {
  if (document.getElementById('dp-styles')) return
  const style = document.createElement('style')
  style.id = 'dp-styles'
  style.textContent = `
    .dp-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: var(--s-4);
      padding: var(--s-4);
      padding-bottom: calc(var(--bottom-nav-h) + var(--s-4));
      max-width: 760px;
      width: 100%;
      margin: 0 auto;
    }
    .dp-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-4);
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
    }
    .dp-intro {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      line-height: 1.5;
    }
    .dp-scope { border: none; }
    .scope-row {
      display: flex;
      gap: var(--s-3);
      flex-wrap: wrap;
      margin-top: var(--s-1);
    }
    .scope-opt {
      display: inline-flex;
      align-items: center;
      gap: var(--s-1);
      cursor: pointer;
      font-size: var(--fs-sm);
    }
    .scope-detail {
      margin-top: var(--s-2);
      display: flex;
      gap: var(--s-2);
    }
    .scope-tag { flex: 1; }
    .dp-actions {
      display: flex;
      gap: var(--s-3);
      align-items: center;
      flex-wrap: wrap;
    }
    .dp-actions .btn { width: auto; }
    .cost-note {
      font-size: var(--fs-sm);
      color: var(--text-muted);
    }
    .dp-questions {
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
    }
    .dp-q-title {
      font-size: var(--fs-lg);
      font-weight: 600;
    }
    .dp-q-block {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-4);
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }
    .dp-question {
      font-weight: 500;
      line-height: 1.5;
    }
    .dp-context {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      font-style: italic;
    }
    .dp-answer {
      margin-top: var(--s-1);
      font-size: var(--fs-sm);
    }
    #dp-save-all {
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }
    #dp-save-all .btn { width: auto; }
    .muted { color: var(--text-muted); font-size: var(--fs-sm); }
    .field { display: flex; flex-direction: column; gap: var(--s-1); }
    .field-label { font-size: var(--fs-sm); color: var(--text-muted); font-weight: 500; }
  `
  document.head.appendChild(style)
}
