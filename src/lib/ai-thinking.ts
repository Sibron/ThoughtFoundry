/**
 * Shows an animated thinking indicator below a button while an AI call runs.
 * Returns a stop() function that removes the indicator when the call finishes.
 *
 * Usage:
 *   const stop = startAiThinking(btn, ['Nota lezen…', 'Verbindingen zoeken…'])
 *   try { await callAI() } finally { stop() }
 */
export function startAiThinking(btn: HTMLButtonElement, phases: string[]): () => void {
  const panel = document.createElement('div')
  panel.className = 'ai-thinking'
  panel.innerHTML = `
    <span class="ai-thinking-dots" aria-hidden="true"><span></span><span></span><span></span></span>
    <span class="ai-thinking-phase"></span>
  `
  btn.insertAdjacentElement('afterend', panel)

  const phaseEl = panel.querySelector('.ai-thinking-phase') as HTMLElement
  let idx = 0
  phaseEl.textContent = phases[0] ?? 'Bezig…'

  const cycleInterval = setInterval(() => {
    idx = (idx + 1) % phases.length
    phaseEl.textContent = phases[idx]
  }, 2800)

  const nudgeTimeout = setTimeout(() => {
    if (panel.isConnected) {
      const nudge = document.createElement('span')
      nudge.className = 'ai-thinking-nudge'
      nudge.textContent = 'Dit kan even duren, nog even geduld…'
      panel.appendChild(nudge)
    }
  }, 10_000)

  return () => {
    clearInterval(cycleInterval)
    clearTimeout(nudgeTimeout)
    panel.remove()
  }
}

/** Preset phase lists for each AI feature */
export const AI_PHASES = {
  process: [
    'Nota lezen…',
    'Kernideeën herkennen…',
    'Passende thema\'s zoeken…',
    'Verbindingen leggen…',
    'Suggesties formuleren…',
  ],
  book: [
    'Nota\'s doornemen…',
    'Structuur bedenken…',
    'Verhaallijnen verbinden…',
    'Tekst uitwerken…',
    'Afronden…',
  ],
  denkpartner: [
    'Jouw nota\'s lezen…',
    'Patronen herkennen…',
    'Kritische vragen formuleren…',
    'Bijna klaar…',
  ],
  spark: [
    'Relevante nota\'s zoeken…',
    'Verbindingen leggen…',
    'Synthese schrijven…',
    'Afronden…',
  ],
  clusters: [
    'Nota\'s doorzoeken…',
    'Overeenkomsten analyseren…',
    'Clusters vormen…',
    'Resultaten verwerken…',
  ],
}
