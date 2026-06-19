import { fetchNotes, type Note } from '../lib/notes'
import { fetchThemes, fetchAllNoteThemes, type Theme } from '../lib/themes'
import { fetchLinks, createLink, deleteLink, LINK_TYPE_LABELS, type NoteLink } from '../lib/links'
import { renderTopbar, attachTopbar } from '../lib/nav'

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
    <div class="graph-body">
      <header class="graph-header">
        <label class="graph-filter">
          Filter thema:
          <select id="graph-theme-filter">
            <option value="">Alle</option>
          </select>
        </label>
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
    <div class="toast" id="toast"></div>
  `

  injectGraphStyles()
  attachTopbar()

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

  let nodes: GraphNode[] = []
  let edges: GraphEdge[] = []
  let svg: SVGSVGElement | null = null
  let usingTemporalFallback = false

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

    // Theme-based edges (notes sharing the same theme connect)
    const byTheme: Record<string, string[]> = {}
    noteThemes.forEach(nt => {
      if (!ids.has(nt.note_id)) return
      ;(byTheme[nt.theme_id] ??= []).push(nt.note_id)
    })
    Object.values(byTheme).forEach(group => {
      // connect each pair lightly
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          edges.push({ source: group[i], target: group[j], kind: 'theme' })
        }
      }
    })

    // Explicit links
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

    // Edges first (so nodes paint on top)
    edges.forEach(e => {
      const a = nodes.find(n => n.id === e.source)
      const b = nodes.find(n => n.id === e.target)
      if (!a || !b) return
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('x1', String(a.x))
      line.setAttribute('y1', String(a.y))
      line.setAttribute('x2', String(b.x))
      line.setAttribute('y2', String(b.y))
      line.setAttribute('class', e.kind === 'explicit' ? 'graph-edge graph-edge-explicit' : 'graph-edge graph-edge-theme')
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

      const label = (n.note.ai_title ?? n.note.content.slice(0, 28)).slice(0, 28)
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
      // also update edges connected to this node
      svg.querySelectorAll<SVGLineElement>('line.graph-edge').forEach((line, idx) => {
        const e2 = edges[idx]
        if (!e2) return
        if (e2.source === n.id) {
          line.setAttribute('x1', String(n.x))
          line.setAttribute('y1', String(n.y))
        }
        if (e2.target === n.id) {
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
      <h3 class="sidebar-title">${escHtml(n.note.ai_title ?? n.note.content.slice(0, 80))}</h3>
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
            <span class="sidebar-link-main">${dir} ${escHtml(other.ai_title ?? other.content.slice(0, 60))}</span>
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
            .map(o => `<option value="${o.id}">${escHtml(o.note.ai_title ?? o.note.content.slice(0, 60))}</option>`)
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
