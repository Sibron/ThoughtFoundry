// Minimal focus trap for modal overlays: keeps Tab/Shift-Tab cycling inside
// the container and returns focus to the previously focused element on release.

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex="0"]'

export function trapFocus(container: HTMLElement): () => void {
  const previous = document.activeElement as HTMLElement | null

  const focusables = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null)

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return
    const els = focusables()
    if (els.length === 0) return
    const first = els[0]
    const last = els[els.length - 1]
    const active = document.activeElement
    if (e.shiftKey) {
      if (active === first || !container.contains(active)) { e.preventDefault(); last.focus() }
    } else {
      if (active === last || !container.contains(active)) { e.preventDefault(); first.focus() }
    }
  }

  container.addEventListener('keydown', onKeydown)
  // Callers usually focus their own search field; only step in when they don't.
  if (!container.contains(document.activeElement)) focusables()[0]?.focus()

  return () => {
    container.removeEventListener('keydown', onKeydown)
    previous?.focus()
  }
}
