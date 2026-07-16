type RouteHandler = () => void

interface Routes {
  [path: string]: RouteHandler
}

// ── Page lifecycle ───────────────────────────────────────────────────────────
// Pages render by replacing #app innerHTML, so DOM listeners die with the page
// — but window-level listeners and in-flight state survive navigation. Pages
// register those via onRouteLeave; the router drains the registry on every
// allowed navigation. setLeaveGuard lets a page veto navigation (unsaved
// changes); the guard must be synchronous because it also backs beforeunload.

let leaveGuard: (() => boolean) | null = null
const cleanups: (() => void)[] = []

/** Register a guard asked before leaving the current page. Return false to stay. */
export function setLeaveGuard(fn: (() => boolean) | null): void {
  leaveGuard = fn
}

/** Register a cleanup (remove window listeners, cancel timers) run when the current page is left. */
export function onRouteLeave(fn: () => void): void {
  cleanups.push(fn)
}

export function createRouter(routes: Routes): void {
  let currentHash = window.location.hash

  function navigate(): void {
    if (leaveGuard && !leaveGuard()) {
      // Veto: restore the previous URL. replaceState doesn't fire hashchange,
      // so this can't loop.
      history.replaceState(null, '', currentHash || '#/')
      return
    }
    leaveGuard = null
    for (const fn of cleanups.splice(0)) {
      try { fn() } catch { /* cleanup must never block navigation */ }
    }
    currentHash = window.location.hash

    const hash = window.location.hash.slice(1) || '/'
    const path = hash.split('?')[0]
    const handler = Object.prototype.hasOwnProperty.call(routes, path) ? routes[path] : routes['/']
    if (handler) handler()
  }

  window.addEventListener('hashchange', navigate)
  navigate()
}

export function navigateTo(path: string): void {
  window.location.hash = path
}

/**
 * Context-aware back: return to wherever the user actually came from (graph,
 * search, a project detail, …) instead of a hardcoded route. Falls back when
 * there is no in-app history (e.g. the page was opened via a direct link).
 */
export function navigateBack(fallback: string): void {
  if (window.history.length > 1) window.history.back()
  else navigateTo(fallback)
}
