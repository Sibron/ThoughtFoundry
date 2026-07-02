// «Voorgestelde verbindingen» — the connections review queue.
//
// The graph can *show* suggested bridges, but reviewing them one-by-one on a
// canvas is fiddly. This view turns discovery into a habit: a list of
// semantically-close, unlinked, cross-theme pairs (semantic_bridges RPC, zero
// AI cost) that you either Koppel (with a relation type) or Wijs af — and a
// dismissal never comes back, on any device (connection_dismissals). Optional
// per-batch AI typing via the existing enrich-links function.

import { fetchSemanticBridges, hasEmbeddings, fetchDismissedPairKeys, dismissPair, type BridgePair } from '../lib/semantic'
import { createLink, LINK_TYPE_LABELS, type LinkType } from '../lib/links'
import { fetchNotesByIds, getNoteTitle, type Note } from '../lib/notes'
import { enrichLinks } from '../lib/ai'
import { createAiAction } from '../lib/ai-action'
import { isAiEnabled } from '../lib/nav'
import { showToast, esc, errMsg } from '../lib/crud-list'
import { navigateTo } from '../router'

// Band presets calibrated for gte-small cosine similarity: above ~0.85 pairs
// are near-duplicates, below ~0.55 the relation gets too thin to judge.
const BANDS = {
  verrassend: { label: 'Verrassend', lo: 0.55, hi: 0.72 },
  dichtbij:   { label: 'Dichtbij',   lo: 0.72, hi: 0.85 },
} as const
type BandKey = keyof typeof BANDS

export async function mountConnections(root: HTMLElement): Promise<void> {
  injectConnectionsStyles()

  let band: BandKey = 'verrassend'
  let pairs: BridgePair[] = []
  let noteMap = new Map<string, Note>()

  root.innerHTML = `
    <div class="conn-body">
      <header class="conn-header">
        <div class="conn-bands" role="radiogroup" aria-label="Verwantschapsband">
          ${(Object.keys(BANDS) as BandKey[]).map(k => `
            <button class="conn-band${k === band ? ' active' : ''}" data-band="${k}" role="radio" aria-checked="${k === band}">
              ${BANDS[k].label}
            </button>`).join('')}
        </div>
        <div class="conn-ai-host" id="conn-ai-host"></div>
      </header>
      <p class="muted conn-intro">Paren die semantisch dicht bij elkaar liggen maar nog niet verbonden zijn en geen thema delen. Koppel wat klopt, wijs af wat niet klopt — afgewezen paren komen niet terug.</p>
      <div class="conn-list" id="conn-list"><div class="conn-loading">Laden…</div></div>
    </div>
  `

  const listEl = root.querySelector<HTMLDivElement>('#conn-list')!

  root.querySelectorAll<HTMLButtonElement>('.conn-band').forEach(btn => {
    btn.addEventListener('click', () => {
      band = btn.dataset['band'] as BandKey
      root.querySelectorAll('.conn-band').forEach(b => {
        b.classList.toggle('active', b === btn)
        b.setAttribute('aria-checked', String(b === btn))
      })
      void load()
    })
  })

  if (isAiEnabled()) {
    createAiAction(root.querySelector<HTMLElement>('#conn-ai-host')!, {
      label: 'Leg uit (AI)',
      defaultModel: 'claude-haiku-4-5',
      expectedOutputTokens: 500,
      estimateInputChars: () => pairs.length * 400 + 800,
      phases: ['Paren lezen…', 'Relaties benoemen…', 'Redenen formuleren…'],
      beforeRun: () => {
        if (pairs.length === 0) { showToast('Geen voorstellen om uit te leggen'); return false }
        return true
      },
      run: async (model, overrideCap) => {
        const { links, usage } = await enrichLinks(
          pairs.map(p => ({ aId: p.a_id, bId: p.b_id })),
          { model, overrideCap }
        )
        for (const l of links) {
          const card = listEl.querySelector<HTMLElement>(`[data-pair="${l.a_id}|${l.b_id}"]`)
          if (!card) continue
          const select = card.querySelector<HTMLSelectElement>('.conn-type')
          if (select && l.keep) select.value = l.type
          const reasonEl = card.querySelector<HTMLElement>('.conn-reason')
          if (reasonEl) {
            reasonEl.textContent = l.keep ? l.reason : `AI twijfelt: ${l.reason}`
            reasonEl.hidden = false
            reasonEl.dataset['reason'] = l.keep ? l.reason : ''
          }
        }
        showToast('AI heeft relaties voorgesteld — jij beslist')
        return usage
      },
    })
  }

  async function load(): Promise<void> {
    listEl.innerHTML = '<div class="conn-loading">Laden…</div>'
    try {
      if (!(await hasEmbeddings())) {
        listEl.innerHTML = `
          <div class="conn-empty">
            <p>Semantische voorstellen hebben embeddings nodig.</p>
            <button class="btn btn-ghost" id="conn-to-settings">Naar Instellingen →</button>
          </div>`
        document.getElementById('conn-to-settings')?.addEventListener('click', () => navigateTo('/settings'))
        return
      }

      const { lo, hi } = BANDS[band]
      const [bridges, dismissed] = await Promise.all([
        fetchSemanticBridges({ bandLo: lo, bandHi: hi, max: 20 }),
        fetchDismissedPairKeys().catch(() => new Set<string>()),
      ])
      pairs = bridges.filter(p => !dismissed.has(`${p.a_id}|${p.b_id}`))

      if (pairs.length === 0) {
        listEl.innerHTML = `
          <div class="conn-empty">
            <p>Geen nieuwe voorstellen in deze band — leg meer gedachten vast${band === 'dichtbij' ? ' of probeer Verrassend' : ''}.</p>
          </div>`
        return
      }

      const ids = [...new Set(pairs.flatMap(p => [p.a_id, p.b_id]))]
      const notes = await fetchNotesByIds(ids)
      noteMap = new Map(notes.map(n => [n.id, n]))

      listEl.innerHTML = pairs.map(renderPair).join('')
      wireCards()
    } catch (err) {
      listEl.innerHTML = `<div class="conn-empty"><p>Laden mislukt: ${esc(errMsg(err))}</p></div>`
    }
  }

  function renderPair(p: BridgePair): string {
    const a = noteMap.get(p.a_id)
    const b = noteMap.get(p.b_id)
    if (!a || !b) return ''
    const typeOptions = Object.entries(LINK_TYPE_LABELS)
      .map(([k, v]) => `<option value="${k}"${k === 'related' ? ' selected' : ''}>${esc(v)}</option>`)
      .join('')
    return `
      <div class="conn-card" data-pair="${p.a_id}|${p.b_id}">
        <div class="conn-pair">
          ${pairSide(a)}
          <span class="conn-vs">×</span>
          ${pairSide(b)}
        </div>
        <div class="conn-meta">
          <span class="conn-sim">${Math.round(p.similarity * 100)}% verwant</span>
          <span class="conn-reason" hidden></span>
        </div>
        <div class="conn-actions">
          <select class="conn-type" aria-label="Relatietype">${typeOptions}</select>
          <button class="btn btn-primary btn-sm conn-link">Koppel</button>
          <button class="btn btn-ghost btn-sm conn-dismiss">Wijs af</button>
        </div>
      </div>`
  }

  function pairSide(n: Note): string {
    return `
      <button type="button" class="conn-note" data-note="${n.id}" title="Open nota">
        <span class="conn-note-title">${esc(getNoteTitle(n, 60))}</span>
        <span class="conn-note-snippet">${esc(n.content.slice(0, 100))}${n.content.length > 100 ? '…' : ''}</span>
      </button>`
  }

  function wireCards(): void {
    listEl.querySelectorAll<HTMLButtonElement>('.conn-note').forEach(btn => {
      btn.addEventListener('click', () => navigateTo('/note?id=' + btn.dataset['note']))
    })
    listEl.querySelectorAll<HTMLElement>('.conn-card').forEach(card => {
      const [aId, bId] = card.dataset['pair']!.split('|')
      card.querySelector('.conn-link')?.addEventListener('click', async () => {
        const type = (card.querySelector('.conn-type') as HTMLSelectElement).value as LinkType
        const reason = card.querySelector<HTMLElement>('.conn-reason')?.dataset['reason'] || 'Semantische brug'
        try {
          await createLink({ sourceId: aId, targetId: bId, type, reason })
          pairs = pairs.filter(p => !(p.a_id === aId && p.b_id === bId))
          card.remove()
          showToast('Verbinding gelegd')
        } catch (err) {
          showToast(`Koppelen mislukt: ${errMsg(err)}`)
        }
      })
      card.querySelector('.conn-dismiss')?.addEventListener('click', async () => {
        try {
          await dismissPair(aId, bId)
          pairs = pairs.filter(p => !(p.a_id === aId && p.b_id === bId))
          card.remove()
          showToast('Afgewezen — komt niet terug')
        } catch (err) {
          showToast(`Afwijzen mislukt: ${errMsg(err)}`)
        }
      })
    })
  }

  await load()
}

function injectConnectionsStyles(): void {
  if (document.getElementById('connections-styles')) return
  const style = document.createElement('style')
  style.id = 'connections-styles'
  style.textContent = `
    .conn-body {
      display: flex; flex-direction: column; gap: var(--s-3);
      padding: var(--s-4);
      padding-bottom: calc(var(--bottom-nav-h) + var(--s-4));
      max-width: 760px; width: 100%; margin: 0 auto;
    }
    .conn-header { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--s-3); flex-wrap: wrap; }
    .conn-bands { display: flex; gap: var(--s-1); }
    .conn-band {
      border: 1px solid var(--border); border-radius: var(--r-sm);
      background: var(--bg); color: var(--text-muted);
      padding: 4px var(--s-3); font-size: var(--fs-sm); cursor: pointer;
    }
    .conn-band.active { border-color: var(--accent); color: var(--accent); background: var(--surface); font-weight: 600; }
    .conn-intro { font-size: var(--fs-sm); }
    .conn-list { display: flex; flex-direction: column; gap: var(--s-3); }
    .conn-loading, .conn-empty { padding: var(--s-5); text-align: center; color: var(--text-muted); }
    .conn-empty .btn { width: auto; margin-top: var(--s-2); }
    .conn-card {
      background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md);
      padding: var(--s-3) var(--s-4);
      display: flex; flex-direction: column; gap: var(--s-2);
    }
    .conn-pair { display: flex; gap: var(--s-2); align-items: stretch; }
    .conn-vs { align-self: center; color: var(--text-muted); font-weight: 600; }
    .conn-note {
      flex: 1; text-align: left; cursor: pointer;
      background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-sm);
      padding: var(--s-2); display: flex; flex-direction: column; gap: 2px;
    }
    .conn-note:hover { border-color: var(--accent); }
    .conn-note-title { font-weight: 600; font-size: var(--fs-sm); color: var(--text); }
    .conn-note-snippet { font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.4; }
    .conn-meta { display: flex; gap: var(--s-3); align-items: baseline; flex-wrap: wrap; }
    .conn-sim { font-size: var(--fs-sm); color: var(--accent); font-weight: 600; }
    .conn-reason { font-size: var(--fs-sm); color: var(--text-muted); font-style: italic; }
    .conn-actions { display: flex; gap: var(--s-2); align-items: center; flex-wrap: wrap; }
    .conn-actions .btn { width: auto; }
    .conn-type { max-width: 200px; }
    .muted { color: var(--text-muted); }
  `
  document.head.appendChild(style)
}
