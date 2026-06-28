import { getNoteTitle, type Note } from '../lib/notes'
import { type Theme } from '../lib/themes'
import { createLink, deleteLink, LINK_TYPE_LABELS, type LinkType, type NoteLink } from '../lib/links'
import { loadGraphSnapshot, type GraphSnapshot } from '../lib/snapshots'
import { fetchSemanticBridges, type BridgePair } from '../lib/semantic'
import { pairKey } from '../lib/similarity'
import { enrichLinks } from '../lib/ai'
import { getCostStatus } from '../lib/cost'
import { startAiThinking, AI_PHASES } from '../lib/ai-thinking'
import { renderTopbar, attachTopbar, isAiEnabled } from '../lib/nav'
import { navigateTo } from '../router'

interface GraphNode {
  id: string
  note: Note
  themeId: string | null
  x: number
  y: number
  vx: number
  vy: number
  radius: number
}

interface GraphEdge {
  source: string
  target: string
  kind: 'theme' | 'explicit'
  reason?: string | null
  linkId?: string
}

const WIDTH = 1000
const HEIGHT = 720

export async function renderGraph(app: HTMLElement): Promise<void> {
  app.innerHTML = `
    ${renderTopbar('Graaf', 'graph')}
    <div id="graph-root"></div>
    <div class="toast" id="toast"></div>
  `
  attachTopbar()
  await mountGraph(document.getElementById('graph-root')!)
}

export async function mountGraph(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="graph-body">
      <header class="graph-header">
        <div class="graph-controls">
          <label class="graph-filter">
            Filter thema:
            <select id="graph-theme-filter">
              <option value="">Alle</option>
            </select>
          </label>
          <input type="search" id="graph-search" class="graph-search" placeholder="Zoek nota…" aria-label="Zoek een nota in de graaf" />
          <label class="graph-filter graph-toggle">
            <input type="checkbox" id="graph-theme-edges" />
            Toon thema-verbanden
          </label>
          <button class="btn btn-ghost graph-suggest-btn" id="graph-suggest">Verbindingen voorstellen</button>
          <button class="btn btn-ghost graph-reset-btn" id="graph-reset" title="Beeld herstellen" aria-label="Beeld herstellen">Reset beeld</button>
        </div>
        <div class="graph-meta-row">
          <span class="graph-legend" aria-hidden="true">
            <span class="legend-item"><span class="legend-swatch legend-theme"></span>Thema</span>
            <span class="legend-item"><span class="legend-swatch legend-explicit"></span>Link</span>
            <span class="legend-item"><span class="legend-swatch legend-suggested"></span>Voorstel</span>
          </span>
          <span class="graph-stats" id="graph-stats"></span>
        </div>
      </header>
      <div class="graph-shell">
        <div class="graph-canvas-wrap" id="graph-canvas-wrap">
          <div class="graph-loading">Laden…</div>
        </div>
        <aside class="graph-sidebar" id="graph-sidebar">
          <p class="muted">Klik op een knoop voor details — de verbindingen lichten op. Sleep een knoop om te verplaatsen, scroll of knijp om te zoomen, sleep de achtergrond om te pannen.</p>
        </aside>
      </div>
    </div>
  `

  injectGraphStyles()

  let notes: Note[] = []
  let themes: Theme[] = []
  let noteThemes: { note_id: string; theme_id: string }[] = []
  let links: NoteLink[] = []
  // Set once the user starts working the view, so a background cache refresh
  // updates the data silently instead of relaying-out the graph under them.
  let interacted = false

  try {
    const snap = await loadGraphSnapshot(applyFreshSnapshot)
    notes = snap.notes; themes = snap.themes; noteThemes = snap.noteThemes; links = snap.links
  } catch (err) {
    const wrap = document.getElementById('graph-canvas-wrap')!
    wrap.innerHTML = `
      <div class="graph-error">
        <p>Laden mislukt: ${escHtml(errMsg(err))}</p>
        <button class="btn btn-primary" id="graph-retry">Opnieuw proberen</button>
      </div>
    `
    document.getElementById('graph-retry')?.addEventListener('click', () => { mountGraph(root) })
    return
  }

  const themeSelect = document.getElementById('graph-theme-filter') as HTMLSelectElement
  populateThemeFilter()

  // A background refresh returned data that differs from the snapshot we first
  // rendered. Sync the dropdown always; rebuild the canvas only if the user
  // hasn't started interacting (otherwise the cache is updated for next mount).
  function applyFreshSnapshot(snap: GraphSnapshot): void {
    // The refresh can land after the user has left the page — bail if the canvas
    // is gone rather than rebuild into a detached DOM.
    if (!document.getElementById('graph-canvas-wrap')) return
    notes = snap.notes; themes = snap.themes; noteThemes = snap.noteThemes; links = snap.links
    populateThemeFilter()
    if (!interacted) rebuild()
  }

  function populateThemeFilter(): void {
    const current = themeSelect.value
    themeSelect.querySelectorAll('option[value]:not([value=""])').forEach(o => o.remove())
    themes.forEach(t => {
      const opt = document.createElement('option')
      opt.value = t.id
      opt.textContent = t.name
      themeSelect.appendChild(opt)
    })
    if (current && themes.some(t => t.id === current)) themeSelect.value = current
  }

  if (notes.length === 0) {
    document.getElementById('graph-canvas-wrap')!.innerHTML = `
      <div class="graph-empty">
        <h2>Nog geen nota's</h2>
        <p>Capture eerst wat ideeën, verwerk ze, en kom dan terug om de graaf te zien.</p>
        <button class="btn btn-primary" id="graph-empty-capture">Naar Vangbak</button>
      </div>
    `
    document.getElementById('graph-empty-capture')?.addEventListener('click', () => navigateTo('/capture'))
    return
  }

  let selectedTheme = ''
  themeSelect.addEventListener('change', () => {
    interacted = true
    selectedTheme = themeSelect.value
    rebuild()
  })

  // Theme connections are hidden by default so the typed (explicit) links stand
  // out; the user can switch them on to see thematic clustering.
  let showThemeEdges = false
  const themeEdgesToggle = document.getElementById('graph-theme-edges') as HTMLInputElement
  themeEdgesToggle.addEventListener('change', () => {
    showThemeEdges = themeEdgesToggle.checked
    renderSvg()
  })

  let nodes: GraphNode[] = []
  let edges: GraphEdge[] = []
  let svg: SVGSVGElement | null = null
  let usingTemporalFallback = false
  // Candidate (not-yet-created) links surfaced by semantic_bridges, drawn dashed.
  let suggestedEdges: { a: string; b: string }[] = []

  // View transform driving the SVG viewBox: scale > 1 zooms in, x/y pan.
  const view = { x: 0, y: 0, scale: 1 }
  // The currently selected node — its ego network is highlighted, the rest dim.
  let focusedId: string | null = null
  // Live search query — matching nodes stay lit, the rest dim.
  let searchQuery = ''

  document.getElementById('graph-suggest')?.addEventListener('click', suggestBridges)
  document.getElementById('graph-reset')?.addEventListener('click', resetView)

  const searchInput = document.getElementById('graph-search') as HTMLInputElement | null
  searchInput?.addEventListener('input', () => {
    interacted = true
    searchQuery = searchInput.value.trim().toLowerCase()
    applyHighlights()
  })
  searchInput?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !searchQuery) return
    const match = nodes.find(n => nodeMatchesQuery(n, searchQuery))
    if (match) { focusedId = match.id; centerOnNode(match); applyHighlights(); showSidebar(match) }
  })

  rebuild()

  function rebuild(): void {
    const filtered = selectedTheme
      ? notes.filter(n => noteThemes.some(nt => nt.note_id === n.id && nt.theme_id === selectedTheme))
      : notes

    const themeOfNote: Record<string, string | null> = {}
    notes.forEach(n => {
      const matches = noteThemes.filter(nt => nt.note_id === n.id)
      themeOfNote[n.id] = matches[0]?.theme_id ?? null
    })

    nodes = filtered.map((note, i) => ({
      id: note.id,
      note,
      themeId: themeOfNote[note.id] ?? null,
      x: WIDTH / 2 + Math.cos(i * 2.4) * 200,
      y: HEIGHT / 2 + Math.sin(i * 2.4) * 200,
      vx: 0, vy: 0,
      radius: 8
    }))

    const ids = new Set(nodes.map(n => n.id))
    edges = []

    // Theme-based edges: connect each note in a theme to a single representative
    // (the first note of that theme) — a "star", not a clique. A clique is
    // O(n²) edges per theme and turns the canvas into a hairball that buries the
    // real typed links; a star keeps the clustering pull at O(n) edges.
    const byTheme: Record<string, string[]> = {}
    noteThemes.forEach(nt => {
      if (!ids.has(nt.note_id)) return
      ;(byTheme[nt.theme_id] ??= []).push(nt.note_id)
    })
    Object.values(byTheme).forEach(group => {
      const hub = group[0]
      for (let i = 1; i < group.length; i++) {
        edges.push({ source: hub, target: group[i], kind: 'theme' })
      }
    })

    // Explicit links — added last so they paint on top of theme edges.
    links.forEach(l => {
      if (ids.has(l.source_id) && ids.has(l.target_id)) {
        edges.push({ source: l.source_id, target: l.target_id, kind: 'explicit', reason: l.reason, linkId: l.id })
      }
    })

    // Temporal clustering fallback when no edges exist
    usingTemporalFallback = false
    if (edges.length === 0) {
      const WEEK_MS = 7 * 24 * 60 * 60 * 1000
      const byWeek = new Map<number, GraphNode[]>()
      for (const n of nodes) {
        const week = Math.floor(new Date(n.note.created_at).getTime() / WEEK_MS)
        if (!byWeek.has(week)) byWeek.set(week, [])
        byWeek.get(week)!.push(n)
      }
      for (const group of byWeek.values()) {
        for (let i = 0; i < group.length - 1; i++) {
          edges.push({ source: group[i].id, target: group[i + 1].id, kind: 'theme', reason: 'zelfde week' })
        }
      }
      usingTemporalFallback = edges.length > 0
    }

    runLayout(nodes, edges, 250)
    renderSvg()
    updateStats()
  }

  function updateStats(): void {
    const stats = document.getElementById('graph-stats')!
    if (usingTemporalFallback) {
      stats.textContent = `${nodes.length} nota's · Tijdclusters (thema's nog niet gekoppeld)`
    } else {
      stats.textContent = `${nodes.length} nota's · ${edges.filter(e => e.kind === 'explicit').length} expliciete links · ${themes.length} thema's`
    }
  }

  function renderSvg(): void {
    const wrap = document.getElementById('graph-canvas-wrap')!
    wrap.innerHTML = ''
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'graph-svg')
    svg.setAttribute('role', 'application')
    svg.setAttribute('aria-label', 'Kennisgraaf van je nota’s. Sleep een knoop om te verplaatsen, scroll om te zoomen.')
    applyView()
    wrap.appendChild(svg)
    attachViewControls(svg)

    // Arrowhead marker for explicit (typed) links so direction reads at a glance.
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs')
    defs.innerHTML = `<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
        markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
      </marker>`
    svg.appendChild(defs)

    // Index nodes/links by id so edge rendering stays O(edges) instead of
    // O(edges · nodes) — the difference matters with the full note set loaded.
    const nodeById = new Map(nodes.map(n => [n.id, n]))
    const linkById = new Map(links.map(l => [l.id, l]))

    // Edges first (so nodes paint on top). Theme edges only when toggled on;
    // explicit links always, painted last via array order so they sit on top.
    edges.forEach(e => {
      if (e.kind === 'theme' && !showThemeEdges) return
      const a = nodeById.get(e.source)
      const b = nodeById.get(e.target)
      if (!a || !b) return
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('x1', String(a.x))
      line.setAttribute('y1', String(a.y))
      line.setAttribute('x2', String(b.x))
      line.setAttribute('y2', String(b.y))
      line.setAttribute('class', e.kind === 'explicit' ? 'graph-edge graph-edge-explicit' : 'graph-edge graph-edge-theme')
      // Reference endpoints by id (not array index) so dragging stays correct
      // even when some edges are hidden.
      line.dataset['src'] = e.source
      line.dataset['tgt'] = e.target
      if (e.kind === 'explicit') {
        line.setAttribute('marker-end', 'url(#arrow)')
        const link = e.linkId ? linkById.get(e.linkId) : undefined
        if (link) {
          const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
          title.textContent = [LINK_TYPE_LABELS[link.type], link.reason].filter(Boolean).join(' · ')
          line.appendChild(title)
        }
      }
      svg!.appendChild(line)
    })

    // Suggested (candidate) links — dashed, drawn under the nodes.
    suggestedEdges.forEach(e => {
      const a = nodeById.get(e.a)
      const b = nodeById.get(e.b)
      if (!a || !b) return
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('x1', String(a.x))
      line.setAttribute('y1', String(a.y))
      line.setAttribute('x2', String(b.x))
      line.setAttribute('y2', String(b.y))
      line.setAttribute('class', 'graph-edge graph-edge-suggested')
      line.dataset['src'] = e.a
      line.dataset['tgt'] = e.b
      svg!.appendChild(line)
    })

    nodes.forEach(n => {
      const themeColor = themes.find(t => t.id === n.themeId)?.color ?? '#999'
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      g.setAttribute('class', 'graph-node')
      g.setAttribute('transform', `translate(${n.x}, ${n.y})`)
      g.setAttribute('role', 'button')
      g.setAttribute('tabindex', '0')
      g.setAttribute('aria-label', getNoteTitle(n.note, 80))
      g.dataset['id'] = n.id

      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      c.setAttribute('r', String(n.radius))
      c.setAttribute('fill', themeColor)
      c.setAttribute('stroke', '#fff')
      c.setAttribute('stroke-width', '1.5')
      g.appendChild(c)

      const label = getNoteTitle(n.note, 28).slice(0, 28)
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      t.setAttribute('x', String(n.radius + 4))
      t.setAttribute('y', '4')
      t.setAttribute('class', 'graph-node-label')
      t.textContent = label
      g.appendChild(t)

      g.addEventListener('click', () => selectNode(n))
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectNode(n) }
        else if (e.key === 'Escape') { clearFocus() }
      })
      attachDrag(g, n)
      svg!.appendChild(g)
    })

    applyHighlights()
  }

  // Open the detail sidebar for a node and light up its ego network on canvas.
  function selectNode(n: GraphNode): void {
    interacted = true
    focusedId = n.id
    applyHighlights()
    showSidebar(n)
  }

  function clearFocus(): void {
    focusedId = null
    applyHighlights()
  }

  function attachDrag(g: SVGGElement, n: GraphNode): void {
    let dragging = false
    let lastX = 0, lastY = 0

    g.addEventListener('pointerdown', (e) => {
      interacted = true
      dragging = true
      lastX = e.clientX
      lastY = e.clientY
      g.setPointerCapture(e.pointerId)
      g.classList.add('is-dragging')
      // Keep the background pan/pinch handlers from also reacting to this pointer.
      e.stopPropagation()
      e.preventDefault()
    })
    g.addEventListener('pointermove', (e) => {
      if (!dragging || !svg) return
      const rect = svg.getBoundingClientRect()
      // Convert client pixels to SVG user units using the CURRENT viewBox width
      // (WIDTH / scale) so dragging stays 1:1 with the cursor at any zoom level.
      const f = (WIDTH / view.scale) / rect.width
      const dx = (e.clientX - lastX) * f
      const dy = (e.clientY - lastY) * f
      lastX = e.clientX
      lastY = e.clientY
      n.x += dx
      n.y += dy
      g.setAttribute('transform', `translate(${n.x}, ${n.y})`)
      // Update only the lines actually touching this node, matched by id.
      svg.querySelectorAll<SVGLineElement>('line.graph-edge').forEach(line => {
        if (line.dataset['src'] === n.id) {
          line.setAttribute('x1', String(n.x))
          line.setAttribute('y1', String(n.y))
        }
        if (line.dataset['tgt'] === n.id) {
          line.setAttribute('x2', String(n.x))
          line.setAttribute('y2', String(n.y))
        }
      })
    })
    g.addEventListener('pointerup', () => { dragging = false; g.classList.remove('is-dragging') })
    g.addEventListener('pointercancel', () => { dragging = false; g.classList.remove('is-dragging') })
  }

  // ── View transform: zoom (wheel/pinch) + pan (background drag) ─────────────

  function applyView(): void {
    if (!svg) return
    const vbW = WIDTH / view.scale
    const vbH = HEIGHT / view.scale
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${vbW} ${vbH}`)
  }

  function resetView(): void {
    view.x = 0; view.y = 0; view.scale = 1
    applyView()
  }

  const MIN_SCALE = 0.3
  const MAX_SCALE = 4

  // Zoom so the SVG point under (clientX, clientY) stays fixed on screen.
  function zoomAt(clientX: number, clientY: number, factor: number): void {
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * factor))
    if (next === view.scale) return
    const vbW = WIDTH / view.scale
    const vbH = HEIGHT / view.scale
    const px = (clientX - rect.left) / rect.width
    const py = (clientY - rect.top) / rect.height
    const ux = view.x + px * vbW
    const uy = view.y + py * vbH
    view.scale = next
    view.x = ux - px * (WIDTH / next)
    view.y = uy - py * (HEIGHT / next)
    applyView()
  }

  function attachViewControls(el: SVGSVGElement): void {
    el.addEventListener('wheel', (e) => {
      e.preventDefault()
      interacted = true
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12)
    }, { passive: false })

    // Track active pointers for background pan (1 pointer) and pinch (2 pointers).
    const pts = new Map<number, { x: number; y: number }>()
    let pinchDist = 0
    let panMoved = false

    el.addEventListener('pointerdown', (e) => {
      // Node drags stop propagation, so anything reaching here is a background gesture.
      if ((e.target as Element).closest('.graph-node')) return
      interacted = true
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      panMoved = false
      if (pts.size === 2) pinchDist = pointerDistance(pts)
      el.setPointerCapture(e.pointerId)
    })

    el.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return
      const prev = pts.get(e.pointerId)!
      const dxClient = e.clientX - prev.x
      const dyClient = e.clientY - prev.y
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })

      if (pts.size === 2) {
        const dist = pointerDistance(pts)
        if (pinchDist > 0) {
          const mid = pointerMidpoint(pts)
          zoomAt(mid.x, mid.y, dist / pinchDist)
        }
        pinchDist = dist
        return
      }

      // Single-pointer background drag = pan.
      const rect = el.getBoundingClientRect()
      const vbW = WIDTH / view.scale
      const vbH = HEIGHT / view.scale
      view.x -= dxClient * (vbW / rect.width)
      view.y -= dyClient * (vbH / rect.height)
      if (Math.abs(dxClient) + Math.abs(dyClient) > 1) panMoved = true
      applyView()
    })

    const endPointer = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return
      pts.delete(e.pointerId)
      if (pts.size < 2) pinchDist = 0
      // A background click that didn't pan clears the current focus.
      if (pts.size === 0 && !panMoved && !(e.target as Element).closest('.graph-node')) {
        clearFocus()
      }
    }
    el.addEventListener('pointerup', endPointer)
    el.addEventListener('pointercancel', endPointer)
  }

  // ── Focus / search highlighting ───────────────────────────────────────────

  function nodeMatchesQuery(n: GraphNode, q: string): boolean {
    if (!q) return false
    return getNoteTitle(n.note, 200).toLowerCase().includes(q)
      || (n.note.content ?? '').toLowerCase().includes(q)
  }

  function neighborsOf(id: string): Set<string> {
    const set = new Set<string>([id])
    edges.forEach(e => {
      if (e.source === id) set.add(e.target)
      if (e.target === id) set.add(e.source)
    })
    suggestedEdges.forEach(e => {
      if (e.a === id) set.add(e.b)
      if (e.b === id) set.add(e.a)
    })
    return set
  }

  // Toggle dim/focus/match classes; CSS does the actual fading. Re-run after every
  // renderSvg (the SVG is rebuilt from scratch) and on focus/search changes.
  function applyHighlights(): void {
    if (!svg) return
    const nodeEls = svg.querySelectorAll<SVGGElement>('.graph-node')
    const lineEls = svg.querySelectorAll<SVGLineElement>('line.graph-edge')

    // An active search wins over click-focus for what stays lit.
    if (searchQuery) {
      const matches = new Set(nodes.filter(n => nodeMatchesQuery(n, searchQuery)).map(n => n.id))
      nodeEls.forEach(el => {
        const id = el.dataset['id']!
        el.classList.toggle('is-match', matches.has(id))
        el.classList.toggle('is-dimmed', !matches.has(id))
        el.classList.remove('is-focused')
      })
      lineEls.forEach(el => {
        const lit = matches.has(el.dataset['src']!) && matches.has(el.dataset['tgt']!)
        el.classList.toggle('is-dimmed', !lit)
        el.classList.remove('is-focused')
      })
      return
    }

    if (focusedId && nodes.some(n => n.id === focusedId)) {
      const near = neighborsOf(focusedId)
      nodeEls.forEach(el => {
        const id = el.dataset['id']!
        el.classList.toggle('is-focused', id === focusedId)
        el.classList.toggle('is-dimmed', !near.has(id))
        el.classList.remove('is-match')
      })
      lineEls.forEach(el => {
        const touches = el.dataset['src'] === focusedId || el.dataset['tgt'] === focusedId
        el.classList.toggle('is-focused', touches)
        el.classList.toggle('is-dimmed', !touches)
      })
      return
    }

    nodeEls.forEach(el => el.classList.remove('is-dimmed', 'is-focused', 'is-match'))
    lineEls.forEach(el => el.classList.remove('is-dimmed', 'is-focused'))
  }

  // Pan the view so the node sits in the middle of the canvas (zoom unchanged).
  function centerOnNode(n: GraphNode): void {
    view.x = n.x - (WIDTH / view.scale) / 2
    view.y = n.y - (HEIGHT / view.scale) / 2
    applyView()
  }

  async function showSidebar(n: GraphNode): Promise<void> {
    const aside = document.getElementById('graph-sidebar')!
    const themeName = themes.find(t => t.id === n.themeId)?.name ?? 'geen thema'
    const explicit = edges.filter(e => e.kind === 'explicit' && (e.source === n.id || e.target === n.id))

    aside.innerHTML = `
      <h3 class="sidebar-title">${escHtml(getNoteTitle(n.note, 80))}</h3>
      <div class="sidebar-meta">
        <span class="badge badge-${n.note.status}">${escHtml(n.note.status)}</span>
        <span class="muted">${escHtml(themeName)}</span>
      </div>
      <p class="sidebar-content">${escHtml(n.note.content)}</p>
      ${n.note.ai_summary ? `<p class="sidebar-summary"><em>${escHtml(n.note.ai_summary)}</em></p>` : ''}
      ${(n.note.tags ?? []).length ? `<div class="sidebar-tags">${n.note.tags.map(t => `<span class="badge">${escHtml(t)}</span>`).join('')}</div>` : ''}

      <h4 class="sidebar-subtitle">Expliciete links (${explicit.length})</h4>
      <ul class="sidebar-links">
        ${explicit.map(e => {
          const otherId = e.source === n.id ? e.target : e.source
          const other = nodes.find(x => x.id === otherId)?.note
          if (!other) return ''
          const link = links.find(l => l.id === e.linkId)
          const dir = e.source === n.id ? '→' : '←'
          const typeLabel = link ? LINK_TYPE_LABELS[link.type] : ''
          const meta = [typeLabel, link?.reason].filter(Boolean).join(' · ')
          return `<li>
            <span class="sidebar-link-main">${dir} ${escHtml(getNoteTitle(other, 60))}</span>
            ${meta ? `<span class="sidebar-link-meta">${escHtml(meta)}</span>` : ''}
            <button class="link-del" data-link="${e.linkId}">×</button>
          </li>`
        }).join('')}
      </ul>

      <details class="sidebar-add-link">
        <summary>+ Link toevoegen</summary>
        <select id="link-target">
          <option value="">— kies nota —</option>
          ${nodes
            .filter(o => o.id !== n.id)
            .map(o => `<option value="${o.id}">${escHtml(getNoteTitle(o.note, 60))}</option>`)
            .join('')}
        </select>
        <input type="text" id="link-reason" placeholder="Reden (optioneel)" />
        <button class="btn btn-primary" id="link-add">Toevoegen</button>
      </details>
    `

    aside.querySelectorAll<HTMLButtonElement>('.link-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const linkId = btn.dataset['link']
        if (!linkId) return
        const removed = links.find(l => l.id === linkId)
        try {
          await deleteLink(linkId)
          links = links.filter(l => l.id !== linkId)
          rebuild()
          showSidebar(n)
          if (removed) {
            // Non-blocking undo instead of a native confirm() before the fact.
            showUndoToast('Link verwijderd', async () => {
              try {
                const restored = await createLink({
                  sourceId: removed.source_id,
                  targetId: removed.target_id,
                  type: removed.type,
                  reason: removed.reason ?? undefined
                })
                if (!links.some(l => l.id === restored.id)) links.push(restored)
                rebuild()
                showSidebar(n)
                showToast('Hersteld')
              } catch (err) {
                showToast(`Herstellen mislukt: ${errMsg(err)}`)
              }
            })
          } else {
            showToast('Link verwijderd')
          }
        } catch (err) {
          showToast(`Mislukt: ${errMsg(err)}`)
        }
      })
    })

    document.getElementById('link-add')?.addEventListener('click', async () => {
      const target = (document.getElementById('link-target') as HTMLSelectElement).value
      const reason = (document.getElementById('link-reason') as HTMLInputElement).value.trim()
      if (!target) return
      try {
        const created = await createLink({ sourceId: n.id, targetId: target, reason: reason || undefined })
        links.push(created)
        rebuild()
        showToast('Link toegevoegd')
      } catch (err) {
        showToast(`Mislukt: ${errMsg(err)}`)
      }
    })
  }

  function noteLabel(noteId: string): string {
    const n = notes.find(x => x.id === noteId)
    return n ? getNoteTitle(n, 50) : noteId
  }

  // Surface semantically-related-but-unlinked pairs (no shared theme) as dashed
  // candidate edges + a batch-accept panel. Zero AI tokens (pure pgvector).
  async function suggestBridges(): Promise<void> {
    const btn = document.getElementById('graph-suggest') as HTMLButtonElement | null
    if (!btn) return
    interacted = true
    btn.disabled = true
    btn.textContent = 'Zoeken…'
    try {
      const bridges = await fetchSemanticBridges({ max: 24 })
      if (bridges.length === 0) {
        renderNoBridges()
        return
      }
      suggestedEdges = bridges.map(b => ({ a: b.a_id, b: b.b_id }))
      renderSvg()
      renderSuggestionsPanel(bridges)
    } catch (err) {
      showToast(`Mislukt: ${errMsg(err)}`)
    } finally {
      btn.disabled = false
      btn.textContent = 'Verbindingen voorstellen'
    }
  }

  // Shown when semantic_bridges returns nothing — usually because embeddings
  // haven't been generated yet. Give a real path to Settings instead of a toast.
  function renderNoBridges(): void {
    const aside = document.getElementById('graph-sidebar')!
    aside.innerHTML = `
      <h3 class="sidebar-title">Geen voorstellen</h3>
      <p class="muted">Er zijn geen nieuwe semantische verbanden gevonden. Dit kan ook betekenen dat je nota's nog geen embeddings hebben — die maken slimme suggesties mogelijk.</p>
      <button class="btn btn-ghost" data-nav="settings" id="bridge-settings">Naar Instellingen</button>
    `
    document.getElementById('bridge-settings')?.addEventListener('click', () => navigateTo('/settings'))
  }

  function typeOptsFor(selected: string): string {
    return Object.entries(LINK_TYPE_LABELS)
      .map(([k, v]) => `<option value="${k}"${k === selected ? ' selected' : ''}>${escHtml(v)}</option>`)
      .join('')
  }

  // Optional `enrichment`: AI-chosen type/reason/keep per pair (keyed by pairKey).
  function renderSuggestionsPanel(
    bridges: BridgePair[],
    enrichment?: Map<string, { keep: boolean; type: LinkType; reason: string }>
  ): void {
    const aside = document.getElementById('graph-sidebar')!
    aside.innerHTML = `
      <h3 class="sidebar-title">Voorgestelde verbindingen (${bridges.length})</h3>
      <p class="muted">Semantisch verwante nota's die nog niet gelinkt zijn en geen thema delen. Vink aan wat klopt en koppel in één keer.</p>
      <ul class="sugg-bridge-list">
        ${bridges.map((b, i) => {
          const enr = enrichment?.get(pairKey(b.a_id, b.b_id))
          const checked = enr ? (enr.keep ? 'checked' : '') : 'checked'
          return `
          <li class="sugg-bridge-row">
            <label class="sugg-bridge-check">
              <input type="checkbox" class="bridge-check" data-idx="${i}" ${checked} />
              <span>${escHtml(noteLabel(b.a_id))} <span class="muted">↔</span> ${escHtml(noteLabel(b.b_id))} <span class="muted">(${(b.similarity * 100).toFixed(0)}%)</span></span>
            </label>
            <select class="bridge-type" data-idx="${i}">${typeOptsFor(enr?.type ?? 'related')}</select>
            ${enr?.reason ? `<span class="sugg-bridge-reason">${escHtml(enr.reason)}</span>` : ''}
          </li>`
        }).join('')}
      </ul>
      <div class="sugg-bridge-actions">
        <button class="btn btn-primary" id="bridge-accept">Koppel geselecteerde</button>
        ${isAiEnabled() && !enrichment ? '<button class="btn btn-ghost" id="bridge-enrich">AI verfijnt type &amp; reden</button>' : ''}
      </div>
    `
    document.getElementById('bridge-accept')?.addEventListener('click', () => acceptBridges(bridges))
    document.getElementById('bridge-enrich')?.addEventListener('click', () => enrichSuggestions(bridges))
  }

  // One batched Haiku call types + justifies the surfaced pairs; the result is
  // pre-filled into the panel and STILL human-approved before any link is made.
  async function enrichSuggestions(bridges: BridgePair[]): Promise<void> {
    const btn = document.getElementById('bridge-enrich') as HTMLButtonElement | null
    if (!btn) return
    const cost = await getCostStatus().catch(() => null)
    if (cost?.block) { showToast('Maandbudget bereikt — verhoog de cap in Instellingen.'); return }
    btn.disabled = true
    const stop = startAiThinking(btn, AI_PHASES.clusters)
    try {
      const { links: enriched } = await enrichLinks(bridges.map(b => ({ aId: b.a_id, bId: b.b_id })))
      const map = new Map<string, { keep: boolean; type: LinkType; reason: string }>()
      for (const e of enriched) map.set(pairKey(e.a_id, e.b_id), { keep: e.keep, type: e.type, reason: e.reason })
      stop()
      renderSuggestionsPanel(bridges, map)
    } catch (err) {
      stop()
      showToast(`AI mislukt: ${errMsg(err)}`)
      const again = document.getElementById('bridge-enrich') as HTMLButtonElement | null
      if (again) again.disabled = false
    }
  }

  async function acceptBridges(bridges: BridgePair[]): Promise<void> {
    const checks = Array.from(document.querySelectorAll<HTMLInputElement>('.bridge-check:checked'))
    if (checks.length === 0) { showToast('Niets geselecteerd'); return }
    const btn = document.getElementById('bridge-accept') as HTMLButtonElement | null
    if (btn) { btn.disabled = true; btn.textContent = 'Koppelen…' }
    let created = 0
    for (const c of checks) {
      const idx = Number(c.dataset['idx'])
      const b = bridges[idx]
      if (!b) continue
      const type = (document.querySelector<HTMLSelectElement>(`.bridge-type[data-idx="${idx}"]`)?.value ?? 'related') as LinkType
      try {
        const link = await createLink({ sourceId: b.a_id, targetId: b.b_id, type, reason: 'Semantische brug' })
        if (!links.some(l => l.id === link.id)) links.push(link)
        created++
      } catch { /* duplicate / self-link — ignore */ }
    }
    suggestedEdges = []
    rebuild()
    showToast(`${created} verbinding${created === 1 ? '' : 'en'} gelegd`)
  }
}

// ── Force-directed layout (deterministic, fixed iteration count) ────────────

function runLayout(nodes: GraphNode[], edges: GraphEdge[], iterations: number): void {
  if (nodes.length === 0) return

  const k = Math.sqrt((WIDTH * HEIGHT) / nodes.length) * 0.6
  const cx = WIDTH / 2
  const cy = HEIGHT / 2

  // Resolve edge endpoints once up front. Looking them up with `nodes.find`
  // inside the iteration loop is O(edges · nodes · iterations) — fine for a few
  // hundred nodes, but a multi-second freeze once the full note set (1000s of
  // edges) loads. A Map makes the spring pass O(edges · iterations).
  const byId = new Map(nodes.map(n => [n.id, n]))
  const springs = edges
    .map(e => ({ a: byId.get(e.source), b: byId.get(e.target), kind: e.kind }))
    .filter((s): s is { a: GraphNode; b: GraphNode; kind: GraphEdge['kind'] } => !!s.a && !!s.b)

  // Repulsion is O(n²) per pass, so for the full (unfiltered) graph of many
  // hundreds of nodes, fewer passes keep the initial layout from blocking the
  // main thread for seconds. Filtered, smaller views keep the full pass count.
  const effectiveIterations = nodes.length <= 700
    ? iterations
    : Math.max(90, Math.round(iterations * 700 / nodes.length))

  for (let it = 0; it < effectiveIterations; it++) {
    // Repulsion (all pairs)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j]
        const dx = a.x - b.x
        const dy = a.y - b.y
        const dist = Math.sqrt(dx * dx + dy * dy) + 0.01
        const force = (k * k) / dist
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        a.vx += fx; a.vy += fy
        b.vx -= fx; b.vy -= fy
      }
    }

    // Spring attraction along edges
    springs.forEach(({ a, b, kind }) => {
      const dx = a.x - b.x
      const dy = a.y - b.y
      const dist = Math.sqrt(dx * dx + dy * dy) + 0.01
      const strength = kind === 'explicit' ? 1.0 : 0.3
      const force = ((dist * dist) / k) * strength
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      a.vx -= fx; a.vy -= fy
      b.vx += fx; b.vy += fy
    })

    // Centering pull
    nodes.forEach(n => {
      n.vx += (cx - n.x) * 0.005
      n.vy += (cy - n.y) * 0.005
    })

    // Cooling + integration
    const cool = 0.85
    nodes.forEach(n => {
      n.vx *= cool
      n.vy *= cool
      const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy)
      const max = 8
      const factor = speed > max ? max / speed : 1
      n.x += n.vx * factor
      n.y += n.vy * factor
      // Stay inside viewbox
      n.x = Math.max(20, Math.min(WIDTH - 20, n.x))
      n.y = Math.max(20, Math.min(HEIGHT - 20, n.y))
    })
  }
}

function showToast(msg: string): void {
  const toast = document.getElementById('toast') as HTMLDivElement | null
  if (!toast) return
  toast.textContent = msg
  toast.classList.add('show')
  setTimeout(() => toast.classList.remove('show'), 2500)
}

// A toast that offers a single undo action for a few seconds before fading.
function showUndoToast(msg: string, onUndo: () => void): void {
  const toast = document.getElementById('toast') as HTMLDivElement | null
  if (!toast) return
  toast.innerHTML = `<span>${escHtml(msg)}</span><button type="button" class="toast-undo">Ongedaan maken</button>`
  toast.classList.add('show')
  let done = false
  const hide = () => {
    if (done) return
    done = true
    toast.classList.remove('show')
    setTimeout(() => { toast.textContent = '' }, 200)
  }
  const timer = setTimeout(hide, 6000)
  toast.querySelector<HTMLButtonElement>('.toast-undo')?.addEventListener('click', () => {
    clearTimeout(timer)
    hide()
    onUndo()
  })
}

function pointerDistance(pts: Map<number, { x: number; y: number }>): number {
  const [a, b] = Array.from(pts.values())
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function pointerMidpoint(pts: Map<number, { x: number; y: number }>): { x: number; y: number } {
  const [a, b] = Array.from(pts.values())
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'onbekende fout'
}

function injectGraphStyles(): void {
  if (document.getElementById('graph-styles')) return
  const style = document.createElement('style')
  style.id = 'graph-styles'
  style.textContent = `
    .graph-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
      padding: var(--s-4);
      padding-bottom: calc(var(--bottom-nav-h) + var(--s-4));
      max-width: 1400px;
      width: 100%;
      margin: 0 auto;
    }
    .graph-header {
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }
    .graph-controls {
      display: flex;
      gap: var(--s-3);
      align-items: center;
      flex-wrap: wrap;
    }
    .graph-meta-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--s-3);
      flex-wrap: wrap;
    }
    .graph-search {
      padding: var(--s-2) var(--s-3);
      border: 1px solid var(--border);
      border-radius: var(--r-sm);
      background: var(--surface);
      color: var(--text);
      font-size: var(--fs-sm);
      min-width: 160px;
    }
    .graph-reset-btn { width: auto; }
    .graph-legend {
      display: flex;
      gap: var(--s-3);
      flex-wrap: wrap;
      font-size: var(--fs-sm);
      color: var(--text-muted);
    }
    .legend-item { display: inline-flex; align-items: center; gap: var(--s-1); }
    .legend-swatch {
      width: 18px;
      height: 0;
      border-top-width: 2px;
      border-top-style: solid;
      display: inline-block;
    }
    .legend-theme { border-top-color: var(--border); border-top-width: 1px; }
    .legend-explicit { border-top-color: var(--accent); }
    .legend-suggested { border-top-style: dashed; border-top-color: var(--accent); }
    .graph-filter {
      display: inline-flex;
      align-items: center;
      gap: var(--s-2);
      font-size: var(--fs-sm);
      color: var(--text-muted);
    }
    .graph-filter select {
      padding: var(--s-2) var(--s-3);
      border: 1px solid var(--border);
      border-radius: var(--r-sm);
      background: var(--surface);
      color: var(--text);
      font-size: var(--fs-sm);
    }
    .graph-stats {
      font-size: var(--fs-sm);
      color: var(--text-muted);
    }
    .graph-shell {
      display: grid;
      grid-template-columns: minmax(0, 3fr) minmax(280px, 1fr);
      gap: var(--s-3);
      flex: 1;
    }
    @media (max-width: 900px) {
      .graph-shell { grid-template-columns: 1fr; }
    }
    .graph-canvas-wrap {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      overflow: hidden;
      min-height: 480px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .graph-svg {
      width: 100%;
      height: 100%;
      min-height: 480px;
      display: block;
      cursor: grab;
      touch-action: none;
    }
    .graph-svg:active { cursor: grabbing; }
    .graph-edge {
      stroke-opacity: 0.5;
    }
    .graph-edge-theme {
      stroke: var(--border);
      stroke-width: 0.5;
    }
    .graph-edge-explicit {
      stroke: var(--accent);
      stroke-width: 1.5;
    }
    .graph-edge-suggested {
      stroke: var(--accent);
      stroke-width: 1.5;
      stroke-dasharray: 4 3;
      stroke-opacity: 0.75;
    }
    .graph-suggest-btn { width: auto; }
    .sugg-bridge-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
      margin: var(--s-2) 0;
    }
    .sugg-bridge-row {
      display: flex;
      flex-direction: column;
      gap: var(--s-1);
      padding: var(--s-2);
      background: var(--bg);
      border-radius: var(--r-sm);
      font-size: var(--fs-sm);
    }
    .sugg-bridge-check {
      display: flex;
      gap: var(--s-2);
      align-items: flex-start;
      cursor: pointer;
    }
    .sugg-bridge-check input { margin-top: 3px; flex-shrink: 0; }
    .sugg-bridge-row .bridge-type { width: 100%; }
    .sugg-bridge-reason {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      font-style: italic;
    }
    .sugg-bridge-actions {
      display: flex;
      gap: var(--s-2);
      flex-wrap: wrap;
    }
    .sugg-bridge-actions .btn { width: auto; }
    .graph-node {
      cursor: pointer;
    }
    .graph-node:hover circle {
      stroke: var(--text);
      stroke-width: 2;
    }
    .graph-node-label {
      font-family: var(--font-sans);
      font-size: 10px;
      fill: var(--text-muted);
      pointer-events: none;
    }
    .graph-sidebar {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-4);
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
      overflow-y: auto;
      max-height: 80vh;
    }
    .sidebar-title { font-size: var(--fs-lg); font-weight: 600; }
    .sidebar-subtitle { font-size: var(--fs-sm); color: var(--text-muted); margin-top: var(--s-3); }
    .sidebar-meta { display: flex; gap: var(--s-2); align-items: center; }
    .sidebar-content { font-size: var(--fs-sm); white-space: pre-wrap; line-height: 1.5; }
    .sidebar-summary { font-size: var(--fs-sm); color: var(--text-muted); }
    .sidebar-tags { display: flex; gap: var(--s-1); flex-wrap: wrap; margin-top: var(--s-1); }
    .sidebar-links { list-style: none; display: flex; flex-direction: column; gap: var(--s-1); }
    .sidebar-links li {
      display: flex; justify-content: space-between; align-items: center;
      padding: var(--s-1) var(--s-2);
      background: var(--bg);
      border-radius: var(--r-sm);
      font-size: var(--fs-sm);
    }
    .link-del {
      background: none; border: none; cursor: pointer;
      color: var(--danger); font-size: 18px; line-height: 1;
    }
    .sidebar-add-link {
      margin-top: var(--s-3);
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }
    .sidebar-add-link summary {
      cursor: pointer;
      font-size: var(--fs-sm);
      color: var(--text-muted);
      padding: var(--s-2) 0;
    }
    .sidebar-add-link select,
    .sidebar-add-link input {
      width: 100%;
    }
    .sidebar-add-link .btn { width: auto; }
    .graph-loading,
    .graph-error,
    .graph-empty {
      text-align: center;
      padding: var(--s-7);
      color: var(--text-muted);
    }
    .graph-empty h2 { margin-bottom: var(--s-3); color: var(--text); }
    .graph-error { display: flex; flex-direction: column; align-items: center; gap: var(--s-3); }
    .graph-empty { display: flex; flex-direction: column; align-items: center; gap: var(--s-2); }
    .graph-error .btn,
    .graph-empty .btn { width: auto; }

    /* Focus / search highlighting — fade everything that isn't relevant. */
    .graph-node, .graph-edge { transition: opacity 0.15s ease; }
    .graph-node.is-dimmed, .graph-edge.is-dimmed { opacity: 0.12; }
    .graph-node.is-focused circle { stroke: var(--text); stroke-width: 2.5; }
    .graph-node.is-match circle { stroke: var(--accent); stroke-width: 2.5; }
    .graph-edge.is-focused { stroke-opacity: 0.9; }

    /* Drag affordance + keyboard focus ring. */
    .graph-node.is-dragging circle {
      stroke: var(--accent);
      stroke-width: 2.5;
      filter: drop-shadow(0 2px 4px rgba(0,0,0,0.35));
    }
    .graph-node:focus { outline: none; }
    .graph-node:focus-visible circle {
      stroke: var(--accent);
      stroke-width: 3;
    }

    /* Undo toast action button. */
    .toast .toast-undo {
      margin-left: var(--s-3);
      background: none;
      border: none;
      color: var(--accent);
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      text-decoration: underline;
    }
  `
  document.head.appendChild(style)
}
