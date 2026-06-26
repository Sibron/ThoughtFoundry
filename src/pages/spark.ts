import { runSpark } from '../lib/ai'
import { getCostStatus, formatUsd, type CostStatus } from '../lib/cost'
import { startAiThinking, AI_PHASES } from '../lib/ai-thinking'
import { renderTopbar, attachTopbar } from '../lib/nav'

const OUTPUT_TYPES = [
  { value: 'reflectie',     label: 'Persoonlijke reflectie' },
  { value: 'coaching',      label: 'Coaching-inzichten' },
  { value: 'beslissing',    label: 'Beslissingsondersteuning' },
  { value: 'blogdraft',     label: 'Blog-draft' },
  { value: 'gesprekskader', label: 'Gespreksframework' },
] as const

type OutputType = typeof OUTPUT_TYPES[number]['value']

export async function renderSpark(app: HTMLElement): Promise<void> {
  app.innerHTML = `
    ${renderTopbar('Spark', 'spark')}
    <div id="spark-root"></div>
    <div class="toast" id="toast"></div>
  `
  attachTopbar()
  await mountSpark(document.getElementById('spark-root')!)
}

export async function mountSpark(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="spark-body">
      <div class="spark-card">
        <p class="spark-intro">
          Voer een thema of vraag in. Spark zoekt jouw nota's die het beste passen en schrijft een synthese in de stijl van jouw keuze. Alles op basis van jouw eigen gedachten.
        </p>

        <label class="field">
          <span class="field-label">Thema of vraag</span>
          <textarea id="spark-query" rows="3" placeholder="bv. Hoe verhoudt autisme zich tot leiderschapsstijlen?"></textarea>
        </label>

        <fieldset class="field spark-types">
          <legend class="field-label">Uitvoer-stijl</legend>
          <div class="type-grid">
            ${OUTPUT_TYPES.map(t => `
              <label class="type-chip${t.value === 'reflectie' ? ' selected' : ''}">
                <input type="radio" name="output-type" value="${t.value}" ${t.value === 'reflectie' ? 'checked' : ''} />
                ${t.label}
              </label>
            `).join('')}
          </div>
        </fieldset>

        <div class="spark-actions">
          <button class="btn btn-primary" id="spark-run">Spark starten</button>
          <span id="spark-cost" class="cost-note"></span>
        </div>
      </div>

      <div id="spark-result" class="spark-result" hidden>
        <div class="result-meta" id="result-meta"></div>
        <div class="result-body" id="result-body"></div>
        <div class="result-actions">
          <button class="btn btn-ghost" id="spark-copy">Kopieer tekst</button>
          <button class="btn btn-ghost" id="spark-new">Nieuwe spark</button>
        </div>
      </div>
    </div>
  `

  injectSparkStyles()

  // Wire up type-chip visual selection
  document.querySelectorAll<HTMLInputElement>('input[name="output-type"]').forEach(radio => {
    radio.addEventListener('change', () => {
      document.querySelectorAll('.type-chip').forEach(el => el.classList.remove('selected'))
      radio.closest('.type-chip')?.classList.add('selected')
    })
  })

  // Show current cost
  try {
    const cost = await getCostStatus()
    renderCostNote(cost)
  } catch { /* non-critical */ }

  document.getElementById('spark-run')?.addEventListener('click', onRun)
  document.getElementById('spark-new')?.addEventListener('click', () => {
    document.getElementById('spark-result')!.hidden = true
    ;(document.getElementById('spark-query') as HTMLTextAreaElement).value = ''
    ;(document.getElementById('spark-query') as HTMLTextAreaElement).focus()
  })

  async function onRun(): Promise<void> {
    const query = (document.getElementById('spark-query') as HTMLTextAreaElement).value.trim()
    if (!query) { showToast('Vul een thema of vraag in'); return }

    const outputType = (document.querySelector<HTMLInputElement>('input[name="output-type"]:checked')?.value ?? 'reflectie') as OutputType

    const btn = document.getElementById('spark-run') as HTMLButtonElement
    btn.disabled = true
    btn.textContent = 'AI denkt na…'
    const stopThinking = startAiThinking(btn, AI_PHASES.spark)

    try {
      const result = await runSpark({ query, outputType })

      if (!result.synthesis) {
        showToast(result.message ?? 'Geen passende nota\'s gevonden.')
        return
      }

      document.getElementById('spark-result')!.hidden = false
      document.getElementById('result-meta')!.innerHTML =
        `Synthese op basis van <strong>${result.matchCount}</strong> passende nota${result.matchCount === 1 ? '' : "'s"}` +
        (result.usage ? ` · ${formatUsd(result.usage.costUsd)}` : '')

      document.getElementById('result-body')!.innerHTML = renderMarkdown(result.synthesis)

      document.getElementById('result-body')!.scrollIntoView({ behavior: 'smooth', block: 'start' })

      // refresh cost
      const freshCost = await getCostStatus()
      renderCostNote(freshCost)
    } catch (err) {
      showToast(`Spark mislukt: ${errMsg(err)}`)
    } finally {
      stopThinking()
      btn.disabled = false
      btn.textContent = 'Spark starten'
    }
  }

  document.getElementById('spark-copy')?.addEventListener('click', () => {
    const text = document.getElementById('result-body')?.innerText ?? ''
    navigator.clipboard.writeText(text).then(() => showToast('Gekopieerd')).catch(() => showToast('Kopiëren mislukt'))
  })

  function renderCostNote(cost: CostStatus): void {
    const el = document.getElementById('spark-cost')
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

function inlineMd(text: string): string {
  return escHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+?)\*/g, '<em>$1</em>')
    .replace(/_([^_]+?)_/g, '<em>$1</em>')
}

function renderMarkdown(text: string): string {
  const lines = text.split('\n')
  const html: string[] = []
  let inList = false

  for (const rawLine of lines) {
    if (/^#{1,2}\s/.test(rawLine)) {
      if (inList) { html.push('</ul>'); inList = false }
      html.push(`<h3 class="spark-heading">${inlineMd(rawLine.replace(/^#{1,2}\s+/, ''))}</h3>`)
    } else if (/^[-*]\s/.test(rawLine)) {
      if (!inList) { html.push('<ul class="spark-list">'); inList = true }
      html.push(`<li>${inlineMd(rawLine.slice(2))}</li>`)
    } else if (rawLine.trim() === '') {
      if (inList) { html.push('</ul>'); inList = false }
    } else {
      if (inList) { html.push('</ul>'); inList = false }
      html.push(`<p>${inlineMd(rawLine)}</p>`)
    }
  }

  if (inList) html.push('</ul>')
  return html.join('')
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'onbekende fout'
}

function injectSparkStyles(): void {
  if (document.getElementById('spark-styles')) return
  const style = document.createElement('style')
  style.id = 'spark-styles'
  style.textContent = `
    .spark-body {
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
    .spark-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-4);
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
    }
    .spark-intro {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      line-height: 1.5;
    }
    .spark-types { border: none; }
    .type-grid {
      display: flex;
      flex-wrap: wrap;
      gap: var(--s-2);
      margin-top: var(--s-1);
    }
    .type-chip {
      padding: 6px var(--s-3);
      border-radius: var(--r-sm);
      border: 1px solid var(--border);
      background: var(--bg);
      font-size: var(--fs-sm);
      cursor: pointer;
      transition: border-color .15s, background .15s;
      user-select: none;
    }
    .type-chip input { display: none; }
    .type-chip.selected {
      border-color: var(--accent);
      background: #E8F5EE;
      color: var(--accent-hover);
      font-weight: 500;
    }
    .spark-actions {
      display: flex;
      gap: var(--s-3);
      align-items: center;
      flex-wrap: wrap;
    }
    .spark-actions .btn { width: auto; }
    .cost-note {
      font-size: var(--fs-sm);
      color: var(--text-muted);
    }
    .spark-result {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-4);
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
    }
    .result-meta {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      padding-bottom: var(--s-2);
      border-bottom: 1px solid var(--border);
    }
    .result-body p {
      line-height: 1.7;
      margin-bottom: var(--s-2);
    }
    .result-body p:last-child { margin-bottom: 0; }
    .spark-heading {
      font-size: var(--fs-lg);
      font-weight: 600;
      margin-top: var(--s-3);
      margin-bottom: var(--s-1);
    }
    .spark-list {
      padding-left: var(--s-5);
      display: flex;
      flex-direction: column;
      gap: var(--s-1);
      margin-bottom: var(--s-2);
    }
    .spark-list li { line-height: 1.6; }
    .result-actions {
      display: flex;
      gap: var(--s-2);
      margin-top: var(--s-2);
      flex-wrap: wrap;
    }
    .result-actions .btn { width: auto; }
    .field { display: flex; flex-direction: column; gap: var(--s-1); }
    .field-label { font-size: var(--fs-sm); color: var(--text-muted); font-weight: 500; }
  `
  document.head.appendChild(style)
}
