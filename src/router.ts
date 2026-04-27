type RouteHandler = () => void

interface Routes {
  [path: string]: RouteHandler
}

export function createRouter(routes: Routes): void {
  function navigate(): void {
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
