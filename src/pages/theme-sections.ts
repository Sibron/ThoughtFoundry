import { SECTIONS } from '../lib/sections'
import { fetchThemes, type Theme } from '../lib/themes'
import { fetchNotesByTheme } from '../lib/notes'
import { renderTopbar, attachTopbar } from '../lib/nav'
import { navigateTo } from '../router'

export async function renderThemeSections(app: HTMLElement): Promise<void> {
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
  const themeId = params.get('id')

  app.innerHTML = `
    ${renderTopbar('Secties', 'themes')}
    <div class="ts-body" id="ts-body">
      <div class="ts-loading">Laden…</div>
    </div>
  `
  injectStyles()
  attachTopbar()

  if (!themeId) {
    document.getElementById('ts-body')!.innerHTML = '<p class="ts-error">Geen thema opgegeven.</p>'
    return
  }

  let theme: Theme | undefined
  let notes: { id: string; ai_title: string | null; section: string | null }[] = []

  try {
    const [themes, fetchedNotes] = await Promise.all([
      fetchThemes(),
      fetchNotesByTheme(themeId)
    ])
    theme = themes.find(t => t.id === themeId)
    notes = fetchedNotes
  } catch (err) {
    document.getElementById('ts-body')!.innerHTML =
      `<p class="ts-error">Laden mislukt: ${escHtml(errMsg(err))}</p>`
    return
  }

  const body = document.getElementById('ts-body')!

  const notesBySection = new Map<string | null, typeof notes>()
  for (const n of notes) {
    const key = n.section ?? null
    if (!notesBySection.has(key)) notesBySection.set(key, [])
    notesBySection.get(key)!.push(n)
  }

  const sectionHtml = SECTIONS.map(sec => {
    const secNotes = notesBySection.get(sec.slug) ?? []
    return `
      <div class="ts-section">
        <h3 class="ts-section-title ${secNotes.length > 0 ? 'ts-filled' : 'ts-empty'}">
          ${escHtml(sec.label)}
          <span class="ts-count">${secNotes.length}</span>
        </h3>
        ${secNotes.length > 0
          ? `<ul class="ts-notes">${secNotes.map(n => `
              <li>
                <button class="ts-note-link" data-id="${escHtml(n.id)}">
                  ${escHtml(n.ai_title ?? '(geen titel)')}
                </button>
              </li>`).join('')}</ul>`
          : `<p class="ts-empty-hint">Nog geen nota's in deze sectie.</p>`
        }
      </div>
    `
  }).join('')

  const unassigned = notesBySection.get(null) ?? []
  const unassignedHtml = unassigned.length > 0 ? `
    <div class="ts-section ts-section--unassigned">
      <h3 class="ts-section-title ts-empty">
        Zonder sectie
        <span class="ts-count">${unassigned.length}</span>
      </h3>
      <ul class="ts-notes">${unassigned.map(n => `
        <li>
          <button class="ts-note-link" data-id="${escHtml(n.id)}">
            ${escHtml(n.ai_title ?? '(geen titel)')}
          </button>
        </li>`).join('')}</ul>
    </div>
  ` : ''

  body.innerHTML = `
    <div class="ts-header">
      <button class="ts-back" id="ts-back">← Terug</button>
      <div class="ts-theme-label">
        <span class="ts-dot" style="background:${escHtml(theme?.color ?? '#888')}"></span>
        <h2>${escHtml(theme?.name ?? 'Onbekend thema')}</h2>
        <button class="ts-book-btn" id="ts-book-btn" title="Open boekwerkbank voor dit thema">Genereer hoofdstuk →</button>
      </div>
      <p class="ts-subtitle">Nota's georganiseerd per sectie van het boek in wording</p>
    </div>
    <div class="ts-sections">
      ${sectionHtml}
      ${unassignedHtml}
    </div>
  `

  document.getElementById('ts-back')?.addEventListener('click', () => navigateTo('/themes'))
  document.getElementById('ts-book-btn')?.addEventListener('click', () => navigateTo(`/book?theme=${themeId}`))
  body.querySelectorAll<HTMLElement>('.ts-note-link').forEach(el => {
    el.addEventListener('click', () => navigateTo(`/note?id=${el.dataset['id']}`))
  })
}

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'onbekende fout'
}

function injectStyles(): void {
  if (document.getElementById('theme-sections-styles')) return
  const style = document.createElement('style')
  style.id = 'theme-sections-styles'
  style.textContent = `
    .ts-body {
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
    .ts-header {
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }
    .ts-back {
      background: none;
      border: none;
      color: var(--accent);
      cursor: pointer;
      font-size: var(--fs-sm);
      padding: 0;
      text-align: left;
      width: fit-content;
    }
    .ts-back:hover { text-decoration: underline; }
    .ts-theme-label {
      display: flex;
      align-items: center;
      gap: var(--s-2);
    }
    .ts-dot {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .ts-theme-label h2 { font-size: var(--fs-xl); font-weight: 600; flex: 1; }
    .ts-book-btn {
      background: var(--accent);
      border: none;
      border-radius: var(--r-sm);
      color: #fff;
      cursor: pointer;
      font-size: var(--fs-sm);
      padding: var(--s-1) var(--s-3);
      white-space: nowrap;
    }
    .ts-book-btn:hover { opacity: 0.85; }
    .ts-subtitle { font-size: var(--fs-sm); color: var(--text-muted); }
    .ts-sections {
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
    }
    .ts-section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-3) var(--s-4);
    }
    .ts-section--unassigned {
      border-style: dashed;
      opacity: 0.8;
    }
    .ts-section-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: var(--fs-base);
      font-weight: 600;
      margin-bottom: var(--s-2);
    }
    .ts-section-title.ts-filled { color: var(--text); }
    .ts-section-title.ts-empty { color: var(--text-muted); }
    .ts-count {
      font-size: var(--fs-sm);
      font-weight: 400;
      color: var(--text-muted);
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--r-sm);
      padding: 1px 7px;
    }
    .ts-notes {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: var(--s-1);
      margin: 0;
      padding: 0;
    }
    .ts-note-link {
      background: none;
      border: none;
      color: var(--accent);
      cursor: pointer;
      font-size: var(--fs-sm);
      padding: 2px 0;
      text-align: left;
      width: 100%;
    }
    .ts-note-link:hover { text-decoration: underline; }
    .ts-empty-hint {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      font-style: italic;
      margin: 0;
    }
    .ts-loading,
    .ts-error {
      text-align: center;
      padding: var(--s-7);
      color: var(--text-muted);
    }
  `
  document.head.appendChild(style)
}
