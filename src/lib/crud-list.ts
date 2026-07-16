// Reusable split-pane CRUD-list component.
//
// Several library pages (Bronnen, Projecten) share the exact same shape: a
// sticky sidebar create/edit form next to a main area of cards, where clicking
// a card opens an entity-specific detail view with edit/delete. This module owns
// that shell — the editing lifecycle (create / update / cancel), the card →
// detail routing, and the shared layout CSS — while each page supplies only the
// parts that genuinely differ (its form, its cards, its detail view).
//
// The form and detail markup are delegated to the caller, so per-entity fields
// and behaviour stay intact; only the boilerplate around them is shared.

export interface CrudDetailCtx<T> {
  /** Return to the list view. */
  back: () => void
  /** Switch the sidebar into edit mode for this item and show the list. */
  edit: (item: T) => void
  /** Drop an item from the in-memory list (after the caller deleted it) and show the list. */
  remove: (id: string) => void
}

export interface CrudListConfig<T, F> {
  /** Sidebar heading when creating a new item, e.g. "Nieuwe bron". */
  newTitle: string
  /** Sidebar heading when editing an item, e.g. "Bron bewerken". */
  editTitle: string
  emptyForm: () => F
  toForm: (item: T) => F
  idOf: (item: T) => string
  /** Render the form body. Must contain a `<form id="crud-form">`; the cancel button (edit mode) must use `id="crud-cancel"`. */
  renderForm: (data: F, editing: boolean) => string
  /** Read+validate the form. Return null (after showing a toast) to abort the submit. */
  parseForm: (form: HTMLFormElement) => F | null
  create: (input: F) => Promise<T>
  update: (id: string, input: F) => Promise<T>
  /** Render the main area: toolbar + cards. Each clickable card must carry `data-crud-id="<id>"`. */
  renderMain: (items: T[]) => string
  /** Wire toolbar/search/filter events. Called after every list render; call `rerender()` to repaint the list. */
  wireMain?: (rerender: () => void) => void
  /** Render the detail view for an item into `host`. */
  renderDetail: (item: T, host: HTMLElement, ctx: CrudDetailCtx<T>) => void | Promise<void>
  createdMsg?: string
  updatedMsg?: string
}

export interface CrudList {
  mount: (host: HTMLElement) => void
}

export function createCrudList<T, F>(config: CrudListConfig<T, F>, items: T[]): CrudList {
  let editing: T | null = null
  let formData: F = config.emptyForm()
  let body: HTMLElement

  function renderList(): void {
    body.innerHTML = `
      <div class="crud-layout">
        <aside class="crud-sidebar">
          <div class="crud-form-wrap">
            <h2>${editing ? config.editTitle : config.newTitle}</h2>
            ${config.renderForm(formData, !!editing)}
          </div>
        </aside>
        <main class="crud-main">
          ${config.renderMain(items)}
        </main>
      </div>
    `
    wireForm()
    config.wireMain?.(renderList)
    wireCards()
  }

  function wireCards(): void {
    body.querySelectorAll<HTMLElement>('[data-crud-id]').forEach(el => {
      el.addEventListener('click', () => {
        const item = items.find(i => config.idOf(i) === el.dataset['crudId'])
        if (item) void openDetail(item)
      })
    })
  }

  function wireForm(): void {
    const form = body.querySelector<HTMLFormElement>('#crud-form')
    form?.addEventListener('submit', async (e) => {
      e.preventDefault()
      const input = config.parseForm(form)
      if (!input) return
      const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]')
      if (submitBtn) submitBtn.disabled = true
      try {
        if (editing) {
          const target = editing
          const updated = await config.update(config.idOf(target), input)
          const idx = items.findIndex(i => config.idOf(i) === config.idOf(target))
          if (idx !== -1) items[idx] = updated
          editing = null
          showToast(config.updatedMsg ?? 'Bijgewerkt')
        } else {
          const created = await config.create(input)
          items.unshift(created)
          showToast(config.createdMsg ?? 'Aangemaakt')
        }
        formData = config.emptyForm()
        renderList()
      } catch (err) {
        showToast(`Mislukt: ${errMsg(err)}`)
        if (submitBtn) submitBtn.disabled = false
      }
    })

    body.querySelector('#crud-cancel')?.addEventListener('click', () => {
      editing = null
      formData = config.emptyForm()
      renderList()
    })
  }

  async function openDetail(item: T): Promise<void> {
    await config.renderDetail(item, body, {
      back: () => renderList(),
      edit: (it) => { editing = it; formData = config.toForm(it); renderList() },
      remove: (id) => {
        const idx = items.findIndex(i => config.idOf(i) === id)
        if (idx !== -1) items.splice(idx, 1)
        renderList()
      }
    })
  }

  return {
    mount(host: HTMLElement) { body = host; renderList() }
  }
}

// ── Shared helpers ──────────────────────────────────────────────────────────

export function showToast(message: string): void {
  const t = document.getElementById('toast') as HTMLDivElement | null
  if (!t) return
  ensureToastA11y(t)
  t.textContent = message
  t.classList.add('show')
  setTimeout(() => t.classList.remove('show'), 2500)
}

// Every page ships its own bare <div id="toast">; stamping the live-region
// attributes here covers them all without touching each template.
function ensureToastA11y(t: HTMLElement): void {
  if (!t.hasAttribute('role')) {
    t.setAttribute('role', 'status')
    t.setAttribute('aria-live', 'polite')
  }
}

export function esc(str: string): string {
  return (str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'onbekende fout'
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Relative timestamp in het Nederlands — the one shared formatter for all pages. */
export function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffMs = Date.now() - then
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'net'
  if (mins < 60) return `${mins}m geleden`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}u geleden`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'gisteren'
  if (days < 7) return `${days} dagen geleden`
  if (days < 60) return `${Math.floor(days / 7)} weken geleden`
  if (days < 365) return `${Math.floor(days / 30)} maanden geleden`
  const years = Math.floor(days / 365)
  return years === 1 ? '1 jaar geleden' : `${years} jaar geleden`
}

/**
 * Soft-delete toast — the non-blocking replacement for confirm(): the UI
 * change has already happened; `onCommit` (the real API delete) runs after a
 * 6s grace period unless the user taps Ongedaan maken, which runs `onUndo`
 * (restore the UI) instead. Styling comes from the global .toast-undo rule.
 */
// A newer undo toast replaces the older one; the older action must then commit
// immediately (its undo window ends) rather than be silently lost.
let commitPendingUndo: (() => void) | null = null

export function showUndoToast(
  message: string,
  onCommit: () => void | Promise<void>,
  onUndo: () => void
): void {
  commitPendingUndo?.()

  const toast = document.getElementById('toast') as HTMLDivElement | null
  if (!toast) { void onCommit(); return }
  ensureToastA11y(toast)
  toast.innerHTML = `<span>${esc(message)}</span><button type="button" class="toast-undo">Ongedaan maken</button>`
  toast.classList.add('show')
  let done = false
  const finish = (commit: boolean) => {
    if (done) return
    done = true
    clearTimeout(timer)
    if (commitPendingUndo === commitThis) commitPendingUndo = null
    toast.classList.remove('show')
    setTimeout(() => { if (!toast.classList.contains('show')) toast.textContent = '' }, 250)
    if (commit) void onCommit()
  }
  const commitThis = () => finish(true)
  const timer = setTimeout(commitThis, 6000)
  commitPendingUndo = commitThis
  toast.querySelector<HTMLButtonElement>('.toast-undo')?.addEventListener('click', () => {
    finish(false)
    onUndo()
  })
}

// ── Shared layout CSS ───────────────────────────────────────────────────────
// Structural classes shared by every CRUD-list page. Pages inject this once and
// keep only their entity-specific styling (type pills, status buttons, etc.) in
// their own small style block.

export function injectCrudStyles(): void {
  if (document.getElementById('crud-styles')) return
  const style = document.createElement('style')
  style.id = 'crud-styles'
  style.textContent = `
    .crud-body {
      flex: 1;
      padding: var(--s-4);
      padding-bottom: calc(var(--bottom-nav-h) + var(--s-4));
      max-width: 1100px;
      width: 100%;
      margin: 0 auto;
    }
    .crud-loading { text-align: center; padding: var(--s-7); color: var(--text-muted); }
    .crud-layout {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: var(--s-5);
      align-items: start;
    }
    @media (max-width: 720px) { .crud-layout { grid-template-columns: 1fr; } }
    .crud-sidebar { position: sticky; top: var(--s-4); }
    .crud-form-wrap {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-4);
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
    }
    .crud-form-wrap h2 { font-size: var(--fs-lg); font-weight: 600; }
    .crud-form { display: flex; flex-direction: column; gap: var(--s-3); }
    .crud-field { display: flex; flex-direction: column; gap: var(--s-1); }
    .crud-label { font-size: var(--fs-sm); color: var(--text-muted); font-weight: 500; }
    .crud-row { display: grid; grid-template-columns: 1fr auto; gap: var(--s-2); }
    .crud-actions { display: flex; gap: var(--s-2); flex-wrap: wrap; }
    .crud-actions .btn { width: auto; }
    .crud-main { display: flex; flex-direction: column; gap: var(--s-3); }
    .crud-empty { color: var(--text-muted); font-size: var(--fs-sm); text-align: center; padding: var(--s-7) 0; }
    .crud-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-3);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: var(--s-1);
      transition: border-color 0.15s;
    }
    .crud-card:hover { border-color: var(--accent); }
    .crud-detail-wrap { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--s-4); }
    .crud-back { width: auto; }
    .crud-detail { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md); padding: var(--s-5); }
    .crud-detail-header { display: flex; flex-direction: column; gap: var(--s-2); margin-bottom: var(--s-4); }
    .crud-detail-title { font-size: var(--fs-xl); font-weight: 600; color: var(--text); }
    .crud-detail-actions { display: flex; gap: var(--s-2); margin-bottom: var(--s-4); }
    .crud-detail-actions .btn { width: auto; }
    .crud-note-row {
      display: flex; align-items: center; gap: var(--s-2);
      padding: var(--s-2) 0; border-bottom: 1px solid var(--border);
    }
    .crud-note-row:last-child { border-bottom: none; }
    .crud-note-title { flex: 1; font-size: var(--fs-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .muted { color: var(--text-muted); font-size: var(--fs-sm); }
  `
  document.head.appendChild(style)
}
