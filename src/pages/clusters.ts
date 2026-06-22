import { detectClusters, type Cluster } from '../lib/ai'
import { getCostStatus, formatUsd, type CostStatus } from '../lib/cost'
import { renderTopbar, attachTopbar } from '../lib/nav'
import { insertNote, fetchNotesByIds } from '../lib/notes'
import { createLink } from '../lib/links'

export async function renderClusters(app: HTMLElement): Promise<void> {
  app.innerHTML = `
    ${renderTopbar('Clusters', 'clusters')}
    <div class="clusters-body">
      <div class="clusters-intro-card">
        <p class="clusters-intro">
          AI analyseert je verwerkte nota's en detecteert 2-4 impliciete thema-clusters — patronen die je nog niet bewust als thema hebt gelabeld, inclusief welke permanente nota ontbreekt.
        </p>
        <div class="clusters-run-row">
          <button class="btn btn-primary" id="clusters-run">Clusters detecteren</button>
          <span id="clusters-cost" class="cost-note"></span>
        </div>
        <p class="muted">Gebruikt Sonnet (hogere kwaliteit). Vereist minimaal 5 verwerkte nota's.</p>
      </div>

      <div id="clusters-result" hidden></div>
    </div>
    <div class="toast" id="toast"></div>
  `

  injectClustersStyles()
  attachTopbar()

  try {
    const cost = await getCostStatus()
    renderCostNote(cost)
  } catch { /* non-critical */ }

  document.getElementById('clusters-run')?.addEventListener('click', onRun)

  async function onRun(): Promise<void> {
    const btn = document.getElementById('clusters-run') as HTMLButtonElement
    btn.disabled = true
    btn.textContent = 'Analyseren…'

    try {
      const result = await detectClusters()
      const resultEl = document.getElementById('clusters-result') as HTMLDivElement
      resultEl.hidden = false

      if (!result.clusters.length) {
        resultEl.innerHTML = `<div class="clusters-empty"><p>${escHtml(result.message ?? 'Geen clusters gevonden.')}</p></div>`
        return
      }

      resultEl.innerHTML = `
        <p class="clusters-meta">${result.clusters.length} cluster${result.clusters.length === 1 ? '' : 's'} gevonden in ${result.noteCount ?? '?'} verwerkte nota's</p>
        <div class="clusters-list" id="clusters-list">
          ${result.clusters.map((c, i) => renderCluster(c, i)).join('')}
        </div>
      `

      // Wire up "Create missing note" buttons
      result.clusters.forEach((c, i) => {
        document.getElementById(`cluster-create-${i}`)?.addEventListener('click', () => onCreateMissingNote(c, i))
      })

      // Populate cluster note pills with real titles
      const allIds = result.clusters.flatMap(c => c.note_ids)
      if (allIds.length > 0) {
        fetchNotesByIds(allIds).then(notes => {
          const titleMap = new Map(notes.map(n => [n.id, n.ai_title ?? n.content.slice(0, 60)]))
          document.querySelectorAll<HTMLSpanElement>('.cluster-pill[data-id]').forEach(pill => {
            const title = titleMap.get(pill.dataset['id']!)
            if (title) pill.textContent = title + (title.length === 60 ? '…' : '')
            else pill.remove()
          })
        }).catch(() => { /* non-critical */ })
      }

      const freshCost = await getCostStatus()
      renderCostNote(freshCost)
    } catch (err) {
      showToast(`Detectie mislukt: ${errMsg(err)}`)
    } finally {
      btn.disabled = false
      btn.textContent = 'Clusters detecteren'
    }
  }

  function renderCluster(c: Cluster, i: number): string {
    return `
      <div class="cluster-card" id="cluster-${i}">
        <div class="cluster-header">
          <span class="cluster-index">${i + 1}</span>
          <h3 class="cluster-name">${escHtml(c.name)}</h3>
          <span class="cluster-count">${c.note_ids.length} nota${c.note_ids.length === 1 ? '' : "'s"}</span>
        </div>
        <p class="cluster-theme">${escHtml(c.implicit_theme)}</p>
        <div class="cluster-missing">
          <span class="missing-label">Ontbrekende nota</span>
          <p class="missing-text">${escHtml(c.missing_note)}</p>
          <button class="btn btn-ghost btn-sm" id="cluster-create-${i}">Aanmaken als nota</button>
        </div>
        ${c.note_ids.length > 0 ? `
          <div class="cluster-notes">
            <span class="cluster-notes-label">Nota's in dit cluster</span>
            <div class="cluster-note-pills">
              ${c.note_ids.map(id => `<span class="cluster-pill" data-id="${id}">laden…</span>`).join('')}
            </div>
          </div>
        ` : ''}
      </div>
    `
  }

  async function onCreateMissingNote(c: Cluster, i: number): Promise<void> {
    const btn = document.getElementById(`cluster-create-${i}`) as HTMLButtonElement
    btn.disabled = true
    btn.textContent = 'Aanmaken…'
    try {
      const created = await insertNote({
        content: c.missing_note,
        mini_notes: `Automatisch aangemaakt door Cluster-detectie: "${c.name}"`,
      })
      // Connect the new note to the cluster it came from, so the detected gap
      // becomes a linked synthesis rather than an orphan in the inbox.
      let linked = 0
      for (const targetId of c.note_ids) {
        try {
          await createLink({ sourceId: created.id, targetId, type: 'related', reason: `Cluster: ${c.name}` })
          linked++
        } catch { /* skip self/duplicate/missing */ }
      }
      btn.textContent = 'Aangemaakt ✓'
      showToast(linked ? `Nota aangemaakt en aan ${linked} nota's gekoppeld` : 'Nota aangemaakt in inbox')
    } catch (err) {
      showToast(`Mislukt: ${errMsg(err)}`)
      btn.disabled = false
      btn.textContent = 'Aanmaken als nota'
    }
  }

  function renderCostNote(cost: CostStatus): void {
    const el = document.getElementById('clusters-cost')
    if (!el) return
    el.textContent = `AI deze maand: ${formatUsd(cost.spendUsd)} / ${formatUsd(cost.capUsd)}`
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

function injectClustersStyles(): void {
  if (document.getElementById('clusters-styles')) return
  const style = document.createElement('style')
  style.id = 'clusters-styles'
  style.textContent = `
    .clusters-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: var(--s-4);
      padding: var(--s-4);
      padding-bottom: calc(var(--bottom-nav-h) + var(--s-4));
      max-width: 760px;
      width: 100%;
      margin: 0 auto;
    }
    .clusters-intro-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-4);
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
    }
    .clusters-intro {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      line-height: 1.5;
    }
    .clusters-run-row {
      display: flex;
      gap: var(--s-3);
      align-items: center;
      flex-wrap: wrap;
    }
    .clusters-run-row .btn { width: auto; }
    .cost-note { font-size: var(--fs-sm); color: var(--text-muted); }
    .clusters-meta {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      margin-bottom: var(--s-2);
    }
    .clusters-list {
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
    }
    .clusters-empty {
      padding: var(--s-5);
      text-align: center;
      color: var(--text-muted);
    }
    .cluster-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-4);
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
    }
    .cluster-header {
      display: flex;
      align-items: center;
      gap: var(--s-2);
    }
    .cluster-index {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--accent);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: var(--fs-sm);
      font-weight: 600;
      flex-shrink: 0;
    }
    .cluster-name {
      flex: 1;
      font-size: var(--fs-lg);
      font-weight: 600;
    }
    .cluster-count {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      white-space: nowrap;
    }
    .cluster-theme {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      font-style: italic;
      line-height: 1.5;
    }
    .cluster-missing {
      background: #FFF7E6;
      border: 1px solid #FFD27F;
      border-radius: var(--r-sm);
      padding: var(--s-3);
      display: flex;
      flex-direction: column;
      gap: var(--s-1);
    }
    .missing-label {
      font-size: var(--fs-sm);
      font-weight: 500;
      color: #6B4A00;
    }
    .missing-text {
      font-size: var(--fs-sm);
      color: #4A3300;
      line-height: 1.5;
    }
    .cluster-missing .btn { width: auto; margin-top: var(--s-1); }
    .btn-sm { min-height: 30px !important; padding: var(--s-1) var(--s-2) !important; font-size: var(--fs-sm) !important; }
    .cluster-notes-label {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      font-weight: 500;
    }
    .cluster-notes {
      display: flex;
      flex-direction: column;
      gap: var(--s-1);
    }
    .cluster-note-pills {
      display: flex;
      flex-wrap: wrap;
      gap: var(--s-1);
    }
    .cluster-pill {
      font-size: var(--fs-sm);
      padding: 3px var(--s-2);
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--r-sm);
      color: var(--text-muted);
    }
    .muted { color: var(--text-muted); font-size: var(--fs-sm); }
  `
  document.head.appendChild(style)
}
