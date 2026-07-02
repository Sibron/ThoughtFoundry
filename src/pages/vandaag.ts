// "Vandaag" — the home dashboard. Books are the goals, so the screen answers
// three questions the moment it opens: (1) what am I working toward and is
// there momentum, (2) what wants my attention now, (3) where do I drop this
// thought — a quick-capture box keeps capture one keystroke away even though
// the full capture page moved one tap out.
//
// Loading is best-effort and after-paint: the quick capture is interactive
// immediately; goal cards and week stats fill in when their queries land, and
// render nothing (rather than an error wall) when offline.

import { insertNote, queueOfflineNote, countByStatus, fetchConnectedNoteIds, fetchNotes } from '../lib/notes'
import { fetchProjects, fetchProjectNoteIds, BOOK_STATUSES, type BookProject } from '../lib/projects'
import { fetchWeekStats, countCreatedThisWeek } from '../lib/weekstats'
import { getReviewWeekday } from '../lib/user-settings'
import { renderTopbar, attachTopbar, isAiEnabled } from '../lib/nav'
import { showToast, esc, errMsg } from '../lib/crud-list'
import { embedNote } from '../lib/ai'
import { navigateTo } from '../router'

export async function renderVandaag(app: HTMLElement): Promise<void> {
  app.innerHTML = `
    ${renderTopbar('Vandaag', 'vandaag')}
    <div class="vd-body">
      <section class="vd-capture-card">
        <textarea id="vd-capture" class="vd-capture-input" rows="2"
          placeholder="Wat denk je nu? Gooi het erin…"></textarea>
        <div class="vd-capture-row">
          <button class="btn btn-primary" id="vd-save" disabled>Opslaan</button>
          <button class="btn btn-ghost" id="vd-more">Meer velden →</button>
        </div>
      </section>

      <section class="vd-section" id="vd-goals-section">
        <header class="vd-section-head">
          <h2 class="vd-h2">Doelen</h2>
          <button class="btn btn-ghost btn-sm" id="vd-goals-manage">Beheer →</button>
        </header>
        <div id="vd-goals" class="vd-goals"><div class="vd-skeleton"></div></div>
      </section>

      <section class="vd-section" id="vd-week-section">
        <header class="vd-section-head">
          <h2 class="vd-h2">Weekoverzicht</h2>
        </header>
        <div id="vd-week" class="vd-week"><div class="vd-skeleton"></div></div>
      </section>
    </div>
    <div class="toast" id="toast"></div>
  `
  injectVandaagStyles()
  attachTopbar()

  wireQuickCapture()
  document.getElementById('vd-more')?.addEventListener('click', () => navigateTo('/capture'))
  document.getElementById('vd-goals-manage')?.addEventListener('click', () => navigateTo('/library?tab=book'))

  // Fill in after paint; each block independently best-effort.
  void renderGoals()
  void renderWeek()
}

// ── Quick capture ───────────────────────────────────────────────────────────

function wireQuickCapture(): void {
  const textarea = document.getElementById('vd-capture') as HTMLTextAreaElement
  const saveBtn = document.getElementById('vd-save') as HTMLButtonElement

  textarea.addEventListener('input', () => {
    saveBtn.disabled = textarea.value.trim() === ''
  })
  textarea.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !saveBtn.disabled) saveBtn.click()
  })

  saveBtn.addEventListener('click', async () => {
    const content = textarea.value.trim()
    if (!content) return
    saveBtn.disabled = true
    try {
      if (navigator.onLine) {
        const saved = await insertNote({ content, note_type: 'fleeting' })
        void embedNote(saved.id).catch(() => {})
        showToast('Opgeslagen')
      } else {
        await queueOfflineNote({ content, note_type: 'fleeting' })
        showToast('Opgeslagen (offline wachtrij)')
      }
      textarea.value = ''
    } catch (err) {
      showToast(`Opslaan mislukt: ${errMsg(err)}`)
      saveBtn.disabled = false
      return
    }
    saveBtn.disabled = true
    textarea.focus()
  })

  textarea.focus()
}

// ── Doelen (active book projects) ───────────────────────────────────────────

async function renderGoals(): Promise<void> {
  const host = document.getElementById('vd-goals')
  if (!host) return
  try {
    const projects = (await fetchProjects())
      .filter(p => p.status === 'active' || p.status === 'exploring')
      .sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1))

    if (projects.length === 0) {
      host.innerHTML = `
        <div class="vd-empty">
          <p>Nog geen actieve boekprojecten. Een boek begint met één kernvraag.</p>
          <button class="btn btn-ghost" id="vd-goal-new">Start een project →</button>
        </div>`
      document.getElementById('vd-goal-new')?.addEventListener('click', () => navigateTo('/library?tab=book'))
      return
    }

    const inboxCount = await countByStatus('inbox').catch(() => 0)

    const cards = await Promise.all(projects.map(async p => {
      const noteIds = await fetchProjectNoteIds(p.id).catch(() => [] as string[])
      const thisWeek = await countCreatedThisWeek(noteIds).catch(() => 0)
      return goalCard(p, noteIds.length, thisWeek, inboxCount)
    }))
    host.innerHTML = cards.join('')
    host.querySelectorAll<HTMLElement>('[data-goal-nav]').forEach(el => {
      el.addEventListener('click', () => navigateTo(el.dataset['goalNav']!))
    })
  } catch {
    host.innerHTML = '<p class="muted">Doelen konden niet laden.</p>'
  }
}

function goalCard(p: BookProject, noteCount: number, thisWeek: number, inboxCount: number): string {
  const status = BOOK_STATUSES[p.status]
  const target = p.target_date
    ? `<span class="vd-goal-target">🎯 ${new Date(p.target_date + 'T00:00:00').toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })}</span>`
    : ''
  const momentum = thisWeek > 0 ? ` · <strong>+${thisWeek} deze week</strong>` : ''

  // One suggested next action per goal, cheapest signal first.
  let action: string
  if (noteCount === 0) action = 'Koppel je eerste noten aan dit project'
  else if (inboxCount > 0 && isAiEnabled()) action = `Verwerk je vangbak (${inboxCount}) — voedt je projecten`
  else if (isAiEnabled()) action = 'Klaar voor een gap-analyse of nieuw hoofdstuk?'
  else action = 'Blijf noten koppelen en verbinden'

  return `
    <div class="vd-goal-card" data-goal-nav="/library?tab=book" role="button" tabindex="0"
         style="border-left: 3px solid ${status.color}">
      <div class="vd-goal-top">
        <span class="vd-goal-status" style="color:${status.color}">${esc(status.label)}</span>
        ${target}
      </div>
      <div class="vd-goal-title">${esc(p.title)}</div>
      <div class="vd-goal-question">${esc(p.core_question)}</div>
      <div class="vd-goal-progress">${noteCount} ${noteCount === 1 ? 'noot' : 'noten'}${momentum}</div>
      <div class="vd-goal-action">→ ${esc(action)}</div>
    </div>`
}

// ── Weekoverzicht ───────────────────────────────────────────────────────────

async function renderWeek(): Promise<void> {
  const host = document.getElementById('vd-week')
  if (!host) return
  try {
    const [stats, inboxCount, orphans] = await Promise.all([
      fetchWeekStats(),
      countByStatus('inbox').catch(() => 0),
      countOrphans().catch(() => null),
    ])

    const isReviewDay = new Date().getDay() === getReviewWeekday()
    const reviewBanner = isReviewDay
      ? '<div class="vd-review-banner">Het is je weekoverzicht-dag — neem vijf minuten om terug te kijken.</div>'
      : ''

    host.innerHTML = `
      ${reviewBanner}
      <div class="vd-week-stats">
        <span class="vd-stat"><strong>${stats.captured}</strong> vastgelegd</span>
        <span class="vd-stat"><strong>${stats.processed}</strong> verwerkt</span>
        <span class="vd-stat"><strong>${stats.linked}</strong> verbindingen</span>
      </div>
      <div class="vd-week-ctas">
        ${inboxCount > 0 ? `<button class="btn btn-ghost btn-sm" data-week-nav="${isAiEnabled() ? '/process' : '/inbox'}">Verwerk vangbak (${inboxCount})</button>` : ''}
        ${orphans ? `<button class="btn btn-ghost btn-sm" data-week-nav="/inbox">Wezen: ${orphans} losse notities</button>` : ''}
        <button class="btn btn-ghost btn-sm" data-week-nav="/inbox?view=graph">Bekijk je graaf</button>
      </div>
    `
    host.querySelectorAll<HTMLElement>('[data-week-nav]').forEach(el => {
      el.addEventListener('click', () => navigateTo(el.dataset['weekNav']!))
    })
  } catch {
    host.innerHTML = '<p class="muted">Weekoverzicht kon niet laden.</p>'
  }
}

async function countOrphans(): Promise<number> {
  const connected = await fetchConnectedNoteIds()
  const pool = await fetchNotes(0, 300)
  return pool.filter(n => n.status !== 'archief' && !connected.has(n.id)).length
}

// ── Styles ──────────────────────────────────────────────────────────────────

function injectVandaagStyles(): void {
  if (document.getElementById('vandaag-styles')) return
  const style = document.createElement('style')
  style.id = 'vandaag-styles'
  style.textContent = `
    .vd-body {
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
    .vd-capture-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      border-radius: var(--r-md);
      padding: var(--s-3);
      display: flex; flex-direction: column; gap: var(--s-2);
    }
    .vd-capture-input {
      border: none; background: transparent; resize: none;
      font-size: var(--fs-lg); line-height: 1.5; outline: none;
      font-family: inherit; color: var(--text);
    }
    .vd-capture-row { display: flex; gap: var(--s-2); }
    .vd-capture-row .btn { width: auto; }
    .vd-section { display: flex; flex-direction: column; gap: var(--s-2); }
    .vd-section-head { display: flex; align-items: baseline; justify-content: space-between; }
    .vd-h2 { font-size: var(--fs-lg); font-weight: 600; }
    .vd-section-head .btn { width: auto; }
    .vd-goals { display: flex; flex-direction: column; gap: var(--s-2); }
    .vd-goal-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-3) var(--s-4);
      display: flex; flex-direction: column; gap: var(--s-1);
      cursor: pointer;
    }
    .vd-goal-card:hover { border-color: var(--accent); }
    .vd-goal-top { display: flex; justify-content: space-between; align-items: baseline; }
    .vd-goal-status { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
    .vd-goal-target { font-size: var(--fs-sm); color: var(--text-muted); }
    .vd-goal-title { font-weight: 600; font-size: var(--fs-lg); }
    .vd-goal-question { font-size: var(--fs-sm); color: var(--text-muted); font-style: italic; }
    .vd-goal-progress { font-size: var(--fs-sm); color: var(--text); }
    .vd-goal-action { font-size: var(--fs-sm); color: var(--accent); }
    .vd-week-stats { display: flex; gap: var(--s-4); flex-wrap: wrap; }
    .vd-stat { font-size: var(--fs-sm); color: var(--text-muted); }
    .vd-stat strong { color: var(--text); font-size: var(--fs-lg); }
    .vd-week-ctas { display: flex; gap: var(--s-2); flex-wrap: wrap; margin-top: var(--s-1); }
    .vd-week-ctas .btn { width: auto; }
    .vd-review-banner {
      background: var(--surface);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      border-radius: var(--r-sm);
      padding: var(--s-2) var(--s-3);
      font-size: var(--fs-sm);
      margin-bottom: var(--s-2);
    }
    .vd-empty {
      background: var(--surface); border: 1px dashed var(--border); border-radius: var(--r-md);
      padding: var(--s-4); display: flex; flex-direction: column; gap: var(--s-2);
      color: var(--text-muted); font-size: var(--fs-sm);
    }
    .vd-empty .btn { width: auto; }
    .vd-skeleton {
      height: 72px; border-radius: var(--r-md);
      background: linear-gradient(100deg, var(--surface) 40%, var(--bg) 50%, var(--surface) 60%);
      background-size: 200% 100%;
      animation: vd-shimmer 1.2s infinite linear;
    }
    @keyframes vd-shimmer { to { background-position: -200% 0; } }
    .muted { color: var(--text-muted); font-size: var(--fs-sm); }
  `
  document.head.appendChild(style)
}
