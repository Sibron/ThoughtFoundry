import { fetchNotes, getNoteTitle, type Note } from '../lib/notes'
import { fetchThemes, fetchAllNoteThemes, type Theme } from '../lib/themes'
import { fetchLinks, createLink, deleteLink, LINK_TYPE_LABELS, type LinkType, type NoteLink } from '../lib/links'
import { fetchSemanticBridges, type BridgePair } from '../lib/semantic'
import { pairKey } from '../lib/similarity'
import { enrichLinks } from '../lib/ai'
import { getCostStatus } from '../lib/cost'
import { startAiThinking, AI_PHASES } from '../lib/ai-thinking'
import { renderTopbar, attachTopbar, isAiEnabled } from '../lib/nav'

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
        <label class="graph-filter">
          Filter thema:
          <select id="graph-theme-filter">
            <option value="">Alle</option>
          </select>
        </label>
        <label class="graph-filter graph-toggle">
          <input type="checkbox" id="graph-theme-edges" />
          Toon thema-verbanden
        </label>
        <button class="btn btn-ghost graph-suggest-btn" id="graph-suggest">Verbindingen voorstellen</button>
        <span class="graph-stats" id="graph-stats"></span>
      </header>
      <div class="graph-shell">
        <div class="graph-canvas-wrap" id="graph-canvas-wrap">
          <div class="graph-loading">Laden…</div>
        </div>
        <aside class="graph-sidebar" id="graph-sidebar">
          <p class="muted">Klik op een knoop om details te zien. Sleep om te verplaatsen.</p>
        </aside>
      </div>
    </div>
  `

  injectGraphStyles()

  let notes: Note[] = []
  let themes: Theme[] = []
  let noteThemes: { note_id: string; theme_id: string }[] = []
  let links: NoteLink[] = []

  try {
    [notes, themes, noteThemes, links] = await Promise.all([
      fetchNotes(0, 500),
      fetchThemes(),
      fetchAllNoteThemes(),
      fetchLinks()
    ])
  } catch (err) {
    document.getElementById('graph-canvas-wrap')!.innerHTML =
      `<div class="graph-error">Laden mislukt: ${escHtml(errMsg(err))}</div>`
    return
  }

  const themeSelect = document.getElementById('graph-theme-filter') as HTMLSelectElement
  themes.forEach(t => {
    const opt = document.createElement('option')
    opt.value = t.id
    opt.textContent = t.name
    themeSelect.appendChild(opt)
  })

  if (notes.length === 0) {
    document.getElementById('graph-canvas-wrap')!.innerHTML = `
      <div class="graph-empty">
        <h2>Nog geen nota's</h2>
        <p>Capture eerst wat ideeën, verwerk ze, en kom dan terug om de graaf te zien.</p>
      </div>
    `
    return
  }

  let selectedTheme = ''
  themeSelect.addEventListener('change', () => {
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

  document.getElementById('graph-suggest')?.addEventListener('click', suggestBridges)

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
    svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`)
    svg.setAttribute('class', 'graph-svg')
    wrap.appendChild(svg)

    // Arrowhead marker for explicit (typed) links so direction reads at a glance.
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs')
    defs.innerHTML = `<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
        markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
      </marker>`
    svg.appendChild(defs)

    // Edges first (so nodes paint on top). Theme edges only when toggled on;
    // explicit links always, painted last via array order so they sit on top.
    edges.forEach(e => {
      if (e.kind === 'theme' && !showThemeEdges) return
      const a = nodes.find(n => n.id === e.source)
      const b = nodes.find(n => n.id === e.target)
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
        const link = links.find(l => l.id === e.linkId)
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
      const a = nodes.find(n => n.id === e.a)
      const b = nodes.find(n => n.id === e.b)
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

      g.addEventListener('click', () => showSidebar(n))
      attachDrag(g, n)
      svg!.appendChild(g)
    })
  }

  function attachDrag(g: SVGGElement, n: GraphNode): void {
    let dragging = false
    let lastX = 0, lastY = 0

    g.addEventListener('pointerdown', (e) => {
      dragging = true
      lastX = e.clientX
      lastY = e.clientY
      g.setPointerCapture(e.pointerId)
      e.preventDefault()
    })
    g.addEventListener('pointermove', (e) => {
      if (!dragging || !svg) return
      const rect = svg.getBoundingClientRect()
      const scale = WIDTH / rect.width
      const dx = (e.clientX - lastX) * scale
      const dy = (e.clientY - lastY) * scale
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
    g.addEventListener('pointerup', () => { dragging = false })
    g.addEventListener('pointercancel', () => { dragging = false })
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
        if (!confirm('Link verwijderen?')) return
        try {
          await deleteLink(linkId)
          links = links.filter(l => l.id !== linkId)
          rebuild()
          showToast('Link verwijderd')
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
    btn.disabled = true
    btn.textContent = 'Zoeken…'
    try {
      const bridges = await fetchSemanticBridges({ max: 24 })
      if (bridges.length === 0) {
        showToast("Geen nieuwe verbanden gevonden (of nog geen embeddings — zie Instellingen).")
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

  for (let it = 0; it < iterations; it++) {
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
    edges.forEach(e => {
      const a = nodes.find(n => n.id === e.source)
      const b = nodes.find(n => n.id === e.target)
      if (!a || !b) return
      const dx = a.x - b.x
      const dy = a.y - b.y
      const dist = Math.sqrt(dx * dx + dy * dy) + 0.01
      const strength = e.kind === 'explicit' ? 1.0 : 0.3
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
      justify-content: space-between;
      gap: var(--s-3);
      align-items: center;
      flex-wrap: wrap;
    }
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
    }
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
  `
  document.head.appendChild(style)
}
