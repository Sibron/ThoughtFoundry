// Global search overlay — "I know I wrote this somewhere" from ANY screen.
// A full-screen scrim + panel that mounts the existing search view (both
// Woorden and Betekenis modes). Opened via the Zoek button in the topbar;
// closes on Esc, scrim tap, or the sluiten button. Navigating to a result
// closes it too (the router swaps the page underneath).

import { mountSearch } from '../pages/search'

export async function openSearchOverlay(): Promise<void> {
  if (document.getElementById('search-overlay')) return
  injectOverlayStyles()

  const overlay = document.createElement('div')
  overlay.id = 'search-overlay'
  overlay.innerHTML = `
    <div class="search-overlay-scrim"></div>
    <div class="search-overlay-panel" role="dialog" aria-modal="true" aria-label="Zoeken">
      <div class="search-overlay-head">
        <span class="search-overlay-title">Zoeken</span>
        <button class="btn btn-ghost search-overlay-close" aria-label="Sluiten">✕ Sluiten</button>
      </div>
      <div class="search-overlay-body" id="search-overlay-body"></div>
    </div>
  `
  document.body.appendChild(overlay)

  const close = () => {
    document.removeEventListener('keydown', onKey)
    overlay.remove()
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }

  overlay.querySelector('.search-overlay-scrim')?.addEventListener('click', close)
  overlay.querySelector('.search-overlay-close')?.addEventListener('click', close)
  document.addEventListener('keydown', onKey)

  // Result taps navigate — close the overlay so the target page is visible.
  window.addEventListener('hashchange', close, { once: true })

  await mountSearch(document.getElementById('search-overlay-body')!)
}

function injectOverlayStyles(): void {
  if (document.getElementById('search-overlay-styles')) return
  const style = document.createElement('style')
  style.id = 'search-overlay-styles'
  style.textContent = `
    #search-overlay {
      position: fixed; inset: 0; z-index: 90;
      display: flex; align-items: flex-start; justify-content: center;
    }
    .search-overlay-scrim {
      position: absolute; inset: 0;
      background: rgba(0,0,0,0.4);
    }
    .search-overlay-panel {
      position: relative;
      margin-top: max(4vh, var(--s-4));
      width: min(760px, calc(100vw - 2 * var(--s-3)));
      max-height: 88vh;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      box-shadow: 0 12px 40px rgba(0,0,0,0.25);
      display: flex; flex-direction: column;
      overflow: hidden;
    }
    .search-overlay-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: var(--s-2) var(--s-4);
      border-bottom: 1px solid var(--border);
    }
    .search-overlay-title { font-weight: 600; }
    .search-overlay-close { width: auto; }
    .search-overlay-body { overflow-y: auto; }
    .search-overlay-body .search-body { padding-bottom: var(--s-4); }
  `
  document.head.appendChild(style)
}
