import { runSpark } from '../lib/ai'
import { formatUsd } from '../lib/cost'
import { AI_PHASES } from '../lib/ai-thinking'
import { createAiAction } from '../lib/ai-action'
import { renderMarkdownHtml } from '../lib/markdown'
import { showToast } from '../lib/crud-list'

const OUTPUT_TYPES = [
  { value: 'reflectie',     label: 'Persoonlijke reflectie' },
  { value: 'coaching',      label: 'Coaching-inzichten' },
  { value: 'beslissing',    label: 'Beslissingsondersteuning' },
  { value: 'blogdraft',     label: 'Blog-draft' },
  { value: 'gesprekskader', label: 'Gespreksframework' },
] as const

type OutputType = typeof OUTPUT_TYPES[number]['value']

export async function mountSpark(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="spark-body">
      <div class="spark-card">
        <p class="spark-intro">
          Voer een thema of vraag in. Spark zoekt jouw notities die het beste passen en schrijft een synthese in de stijl van jouw keuze. Alles op basis van jouw eigen gedachten.
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

        <div class="spark-actions" id="spark-action-host"></div>
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

  document.getElementById('spark-new')?.addEventListener('click', () => {
    document.getElementById('spark-result')!.hidden = true
    ;(document.getElementById('spark-query') as HTMLTextAreaElement).value = ''
    ;(document.getElementById('spark-query') as HTMLTextAreaElement).focus()
  })

  const queryEl = document.getElementById('spark-query') as HTMLTextAreaElement
  createAiAction(document.getElementById('spark-action-host')!, {
    label: 'Spark starten',
    phases: AI_PHASES.spark,
    beforeRun: () => {
      if (!queryEl.value.trim()) { showToast('Vul een thema of vraag in'); return false }
      return true
    },
    run: async (model, overrideCap) => {
      const query = queryEl.value.trim()
      const outputType = (document.querySelector<HTMLInputElement>('input[name="output-type"]:checked')?.value ?? 'reflectie') as OutputType
      const result = await runSpark({ query, outputType, model, overrideCap })

      if (!result.synthesis) {
        showToast(result.message ?? 'Geen passende notities gevonden.')
        return result.usage
      }

      document.getElementById('spark-result')!.hidden = false
      document.getElementById('result-meta')!.innerHTML =
        `Synthese op basis van <strong>${result.matchCount}</strong> passende notitie${result.matchCount === 1 ? '' : "s"}` +
        (result.retrieval ? ` · gevonden via ${result.retrieval === 'semantisch' ? 'betekenis' : 'woorden'}` : '') +
        (result.usage ? ` · ${formatUsd(result.usage.costUsd)}` : '')

      document.getElementById('result-body')!.innerHTML = renderMarkdownHtml(result.synthesis)
      document.getElementById('result-body')!.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return result.usage
    },
  })

  document.getElementById('spark-copy')?.addEventListener('click', () => {
    const text = document.getElementById('result-body')?.innerText ?? ''
    navigator.clipboard.writeText(text).then(() => showToast('Gekopieerd')).catch(() => showToast('Kopiëren mislukt'))
  })
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
    /* Synthesis markup comes from lib/markdown.ts — style its elements
       directly rather than class names this page used to emit itself. */
    .result-body h2, .result-body h3, .result-body h4, .result-body h5 {
      font-size: var(--fs-lg);
      font-weight: 600;
      margin-top: var(--s-3);
      margin-bottom: var(--s-1);
    }
    .result-body ul, .result-body ol {
      padding-left: var(--s-5);
      display: flex;
      flex-direction: column;
      gap: var(--s-1);
      margin-bottom: var(--s-2);
    }
    .result-body li { line-height: 1.6; }
    .result-body blockquote {
      border-left: 2px solid var(--border);
      padding-left: var(--s-3);
      color: var(--text-muted);
      margin-bottom: var(--s-2);
    }
    .result-body a { color: var(--accent); }
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
