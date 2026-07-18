// Shared "AI on demand" widget — the one way every AI feature is triggered.
//
// The user asked for AI "in moments when I choose", with budget as a real
// constraint — but cost math in view on every action made the app feel like a
// billing console. So the widget is deliberately quiet:
//   - the model follows the ONE app-wide quality preference (Instellingen),
//     no per-action picker
//   - no upfront estimate, no per-run cost readout
//   - the animated thinking indicator during
//   - budget only speaks up when it matters: a warning line past the
//     threshold, and the server-side 402 block as one confirm + retry
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
import { getCostStatus } from './cost'
import { getAiQuality } from './nav'
import { startAiThinking } from './ai-thinking'
import { showToast, errMsg } from './crud-list'

export type AiModel = 'claude-haiku-4-5' | 'claude-sonnet-4-6'

/** Resolve the app-wide quality preference to a concrete model. */
export function preferredModel(models: AiModel[] = ['claude-haiku-4-5', 'claude-sonnet-4-6']): AiModel {
  const want: AiModel = getAiQuality() === 'better' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5'
  return models.includes(want) ? want : models[0]
}

export interface AiActionOpts {
  /** Run-button text, e.g. "Spark starten". */
  label: string
  /** Models this action supports; resolved via the app-wide quality preference. */
  models?: AiModel[]
  defaultModel?: AiModel
  /** Kept for callers; no longer shown (the widget is cost-quiet). */
  expectedOutputTokens: number
  /** Kept for callers; no longer shown (the widget is cost-quiet). */
  estimateInputChars: () => number
  /** Thinking-indicator phases (see AI_PHASES). */
  phases?: string[]
  /**
   * The actual work. Throwing AiBudgetError here triggers the shared
   * override-confirm and ONE retry with overrideCap=true.
   */
  run: (model: AiModel, overrideCap: boolean) => Promise<AIUsage | undefined | void>
  /** Optional guard before running (e.g. input validation). Return false to abort. */
  beforeRun?: () => boolean
}

export interface AiActionHandle {
  el: HTMLElement
  /** Kept for callers; a no-op now that no estimate is shown. */
  refreshEstimate: () => void
  setDisabled: (disabled: boolean) => void
  selectedModel: () => AiModel
}

export function createAiAction(host: HTMLElement, opts: AiActionOpts): AiActionHandle {
  injectAiActionStyles()

  const models = opts.models ?? ['claude-haiku-4-5', 'claude-sonnet-4-6']

  const el = document.createElement('div')
  el.className = 'ai-action'
  el.innerHTML = `
    <div class="ai-action-row">
      <button type="button" class="btn btn-primary ai-action-run">${opts.label}</button>
    </div>
    <div class="ai-action-cost"></div>
  `
  host.appendChild(el)

  const runBtn = el.querySelector('.ai-action-run') as HTMLButtonElement
  const costEl = el.querySelector('.ai-action-cost') as HTMLElement

  // Budget only speaks up when it matters — past the warning threshold.
  async function refreshBudgetWarning(): Promise<void> {
    try {
      const cost = await getCostStatus()
      costEl.textContent = cost.warn
        ? `Let op: ${(cost.ratio * 100).toFixed(0)}% van je AI-maandbudget gebruikt.`
        : ''
      costEl.classList.toggle('warn', cost.warn)
    } catch { /* non-critical */ }
  }

  runBtn.addEventListener('click', async () => {
    if (opts.beforeRun && !opts.beforeRun()) return

    runBtn.disabled = true
    const originalText = runBtn.textContent
    runBtn.textContent = 'AI denkt na…'
    const stopThinking = startAiThinking(runBtn, opts.phases ?? ['Bezig…'])

    try {
      const model = preferredModel(models)
      try {
        await opts.run(model, false)
      } catch (err) {
        if (!(err instanceof AiBudgetError)) throw err
        // The server blocked at the cap: one explicit confirm, one retry.
        if (!confirm(`${err.message}. Toch doorgaan?`)) return
        await opts.run(model, true)
      }
      await refreshBudgetWarning()
    } catch (err) {
      showToast(`AI-actie mislukt: ${errMsg(err)}`)
    } finally {
      stopThinking()
      runBtn.disabled = false
      runBtn.textContent = originalText
    }
  })

  void refreshBudgetWarning()

  return {
    el,
    refreshEstimate: () => {},
    setDisabled: (d) => { runBtn.disabled = d },
    selectedModel: () => preferredModel(models),
  }
}

function injectAiActionStyles(): void {
  if (document.getElementById('ai-action-styles')) return
  const style = document.createElement('style')
  style.id = 'ai-action-styles'
  style.textContent = `
    .ai-action { display: flex; flex-direction: column; gap: var(--s-2); }
    .ai-action-row { display: flex; align-items: center; gap: var(--s-3); flex-wrap: wrap; }
    .ai-action-row .btn { width: auto; }
    .ai-action-cost { font-size: var(--fs-sm); color: var(--text-muted); }
    .ai-action-cost.warn { color: var(--accent); font-weight: 600; }
    .ai-action-cost:empty { display: none; }
  `
  document.head.appendChild(style)
}
