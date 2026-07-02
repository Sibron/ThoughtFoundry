// Shared "AI on demand" widget — the one way every AI feature is triggered.
//
// The user asked for AI "in moments when I choose", with budget as a real
// constraint. So every AI action gets the same explicit shape:
//   - a model choice (Haiku = snel & goedkoop, Sonnet = beter)
//   - an estimated cost BEFORE the call runs
//   - the animated thinking indicator during
//   - the actual cost + refreshed monthly line after
//   - the server-side 402 budget block surfaced as one confirm + retry
//
// Pages own their inputs and result rendering; this component owns the
// run-button row. Usage:
//
//   const action = createAiAction(host, {
//     label: 'Spark starten',
//     expectedOutputTokens: 900,
//     estimateInputChars: () => queryEl.value.length + 30_000,
//     phases: AI_PHASES.spark,
//     run: async (model, overrideCap) => {
//       const result = await runSpark({ query, outputType, model, overrideCap })
//       renderResult(result)
//       return result.usage
//     },
//   })

import { AiBudgetError, type AIUsage } from './ai'
import { getCostStatus, formatUsd } from './cost'
import { startAiThinking } from './ai-thinking'
import { showToast, errMsg } from './crud-list'

export type AiModel = 'claude-haiku-4-5' | 'claude-sonnet-4-6'

// Mirror of the pricing table in supabase/functions/_shared/anthropic.ts —
// keep the two in sync when models change. USD per MTok.
const PRICING: Record<AiModel, { input: number; output: number }> = {
  'claude-haiku-4-5':  { input: 1, output: 5 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
}

export const MODEL_LABELS: Record<AiModel, string> = {
  'claude-haiku-4-5':  'Haiku (snel & goedkoop)',
  'claude-sonnet-4-6': 'Sonnet (beter)',
}

/** Rough pre-call estimate; Dutch prose runs ~3.5 chars per token. */
export function estimateCostUsd(model: AiModel, inputChars: number, expectedOutputTokens: number): number {
  const p = PRICING[model]
  const inputTokens = inputChars / 3.5
  return (inputTokens * p.input + expectedOutputTokens * p.output) / 1_000_000
}

export interface AiActionOpts {
  /** Run-button text, e.g. "Spark starten". */
  label: string
  /** Selectable models; the segmented control is hidden with only one. */
  models?: AiModel[]
  defaultModel?: AiModel
  /** Expected output size, used for the pre-call estimate. */
  expectedOutputTokens: number
  /** Called whenever the estimate refreshes (model switch, refreshEstimate()). */
  estimateInputChars: () => number
  /** Thinking-indicator phases (see AI_PHASES). */
  phases?: string[]
  /**
   * The actual work. Throwing AiBudgetError here triggers the shared
   * override-confirm and ONE retry with overrideCap=true. Return the usage
   * to show "Klaar — kostte $x" after the run.
   */
  run: (model: AiModel, overrideCap: boolean) => Promise<AIUsage | undefined | void>
  /** Optional guard before running (e.g. input validation). Return false to abort. */
  beforeRun?: () => boolean
}

export interface AiActionHandle {
  el: HTMLElement
  /** Recompute the pre-call estimate (call when the relevant input changes). */
  refreshEstimate: () => void
  setDisabled: (disabled: boolean) => void
  selectedModel: () => AiModel
}

export function createAiAction(host: HTMLElement, opts: AiActionOpts): AiActionHandle {
  injectAiActionStyles()

  const models = opts.models ?? ['claude-haiku-4-5', 'claude-sonnet-4-6']
  let model: AiModel = opts.defaultModel ?? models[0]

  const el = document.createElement('div')
  el.className = 'ai-action'
  el.innerHTML = `
    ${models.length > 1 ? `
      <div class="ai-action-models" role="radiogroup" aria-label="AI-model">
        ${models.map(m => `
          <button type="button" class="ai-action-model${m === model ? ' active' : ''}"
                  data-model="${m}" role="radio" aria-checked="${m === model}">
            ${MODEL_LABELS[m]}
          </button>`).join('')}
      </div>` : ''}
    <div class="ai-action-row">
      <button type="button" class="btn btn-primary ai-action-run">${opts.label}</button>
      <span class="ai-action-estimate" title="Geschatte kosten van deze actie"></span>
    </div>
    <div class="ai-action-cost"></div>
  `
  host.appendChild(el)

  const runBtn = el.querySelector('.ai-action-run') as HTMLButtonElement
  const estimateEl = el.querySelector('.ai-action-estimate') as HTMLElement
  const costEl = el.querySelector('.ai-action-cost') as HTMLElement

  function refreshEstimate(): void {
    let chars = 0
    try { chars = opts.estimateInputChars() } catch { /* estimate is best-effort */ }
    const usd = estimateCostUsd(model, chars, opts.expectedOutputTokens)
    estimateEl.textContent = `Geschat: ≈ ${formatUsd(Math.max(usd, 0.001))}`
  }

  async function refreshMonthly(suffix = ''): Promise<void> {
    try {
      const cost = await getCostStatus()
      costEl.textContent = `${suffix}AI deze maand: ${formatUsd(cost.spendUsd)} / ${formatUsd(cost.capUsd)}`
      costEl.classList.toggle('warn', cost.warn)
    } catch { /* non-critical */ }
  }

  el.querySelectorAll<HTMLButtonElement>('.ai-action-model').forEach(btn => {
    btn.addEventListener('click', () => {
      model = btn.dataset['model'] as AiModel
      el.querySelectorAll('.ai-action-model').forEach(b => {
        b.classList.toggle('active', b === btn)
        b.setAttribute('aria-checked', String(b === btn))
      })
      refreshEstimate()
    })
  })

  runBtn.addEventListener('click', async () => {
    if (opts.beforeRun && !opts.beforeRun()) return

    runBtn.disabled = true
    const originalText = runBtn.textContent
    runBtn.textContent = 'AI denkt na…'
    const stopThinking = startAiThinking(runBtn, opts.phases ?? ['Bezig…'])

    try {
      let usage: AIUsage | undefined | void
      try {
        usage = await opts.run(model, false)
      } catch (err) {
        if (!(err instanceof AiBudgetError)) throw err
        // The server blocked at the cap: one explicit confirm, one retry.
        if (!confirm(`${err.message}. Toch doorgaan?`)) return
        usage = await opts.run(model, true)
      }
      await refreshMonthly(usage ? `Klaar — kostte ${formatUsd(usage.costUsd)} · ` : '')
    } catch (err) {
      showToast(`AI-actie mislukt: ${errMsg(err)}`)
    } finally {
      stopThinking()
      runBtn.disabled = false
      runBtn.textContent = originalText
    }
  })

  refreshEstimate()
  void refreshMonthly()

  return {
    el,
    refreshEstimate,
    setDisabled: (d) => { runBtn.disabled = d },
    selectedModel: () => model,
  }
}

function injectAiActionStyles(): void {
  if (document.getElementById('ai-action-styles')) return
  const style = document.createElement('style')
  style.id = 'ai-action-styles'
  style.textContent = `
    .ai-action { display: flex; flex-direction: column; gap: var(--s-2); }
    .ai-action-models { display: flex; gap: var(--s-1); flex-wrap: wrap; }
    .ai-action-model {
      border: 1px solid var(--border); border-radius: var(--r-sm);
      background: var(--bg); color: var(--text-muted);
      padding: 4px var(--s-3); font-size: var(--fs-sm); cursor: pointer;
      transition: border-color .15s, background .15s;
    }
    .ai-action-model.active {
      border-color: var(--accent); color: var(--accent);
      background: var(--surface); font-weight: 600;
    }
    .ai-action-row { display: flex; align-items: center; gap: var(--s-3); flex-wrap: wrap; }
    .ai-action-row .btn { width: auto; }
    .ai-action-estimate { font-size: var(--fs-sm); color: var(--text-muted); }
    .ai-action-cost { font-size: var(--fs-sm); color: var(--text-muted); }
    .ai-action-cost.warn { color: var(--accent); font-weight: 600; }
    .ai-action-cost:empty { display: none; }
  `
  document.head.appendChild(style)
}
