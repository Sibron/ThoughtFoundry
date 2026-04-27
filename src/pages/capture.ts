import { insertNote, queueOfflineNote, flushOfflineQueue, type NoteInsert } from '../lib/notes'
import { signOut } from '../lib/auth'
import { navigateTo } from '../router'

export async function renderCapture(app: HTMLElement): Promise<void> {
  if (navigator.onLine) {
    flushOfflineQueue().catch(() => { /* silent */ })
  }

  app.innerHTML = `
    <div class="topbar">
      <span class="topbar-title">ThoughtFoundry</span>
      <div class="topbar-actions">
        <button class="topbar-btn" id="goto-inbox">Inbox</button>
        <button class="topbar-btn" id="logout-btn" title="Afmelden">&#x238B;</button>
      </div>
    </div>
    <div class="capture-body">
      <textarea
        id="capture-content"
        class="capture-textarea"
        placeholder="Typ hier je idee…"
        autofocus
        rows="6"
      ></textarea>

      <details class="capture-extra" id="extra-details">
        <summary class="capture-extra-toggle">+ Extra notitie</summary>
        <textarea
          id="capture-mini"
          class="capture-mini-textarea"
          placeholder="Aanvullende context…"
          rows="3"
        ></textarea>
      </details>

      <details class="capture-extra" id="bron-details">
        <summary class="capture-extra-toggle">+ Bron</summary>
        <div class="capture-bron-fields">
          <input type="text" id="capture-source-url" placeholder="URL" />
          <input type="text" id="capture-source-title" placeholder="Titel" />
          <input type="text" id="capture-source-author" placeholder="Auteur" />
        </div>
      </details>

      <div class="capture-footer">
        <button class="btn btn-primary" id="save-btn" disabled>Opslaan</button>
      </div>
    </div>
    <div class="toast" id="toast"></div>
  `

  injectCaptureStyles()

  const textarea = document.getElementById('capture-content') as HTMLTextAreaElement
  const miniTextarea = document.getElementById('capture-mini') as HTMLTextAreaElement
  const sourceUrl = document.getElementById('capture-source-url') as HTMLInputElement
  const sourceTitle = document.getElementById('capture-source-title') as HTMLInputElement
  const sourceAuthor = document.getElementById('capture-source-author') as HTMLInputElement
  const saveBtn = document.getElementById('save-btn') as HTMLButtonElement

  textarea.addEventListener('input', () => {
    saveBtn.disabled = textarea.value.trim() === ''
  })

  textarea.focus()

  document.getElementById('goto-inbox')?.addEventListener('click', () => navigateTo('/inbox'))
  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    await signOut()
    navigateTo('/login')
  })

  textarea.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      if (!saveBtn.disabled) saveBtn.click()
    }
  })

  saveBtn.addEventListener('click', async () => {
    const content = textarea.value.trim()
    if (!content) return

    saveBtn.disabled = true

    const note: NoteInsert = { content }
    if (miniTextarea.value.trim()) note.mini_notes = miniTextarea.value.trim()
    if (sourceUrl.value.trim()) note.source_url = sourceUrl.value.trim()
    if (sourceTitle.value.trim()) note.source_title = sourceTitle.value.trim()
    if (sourceAuthor.value.trim()) note.source_author = sourceAuthor.value.trim()

    try {
      if (navigator.onLine) {
        await insertNote(note)
      } else {
        await queueOfflineNote(note)
      }
      textarea.value = ''
      miniTextarea.value = ''
      sourceUrl.value = ''
      sourceTitle.value = ''
      sourceAuthor.value = ''
      ;(document.getElementById('extra-details') as HTMLDetailsElement).open = false
      ;(document.getElementById('bron-details') as HTMLDetailsElement).open = false
      showToast(navigator.onLine ? 'Opgeslagen' : 'Opgeslagen (offline wachtrij)')
    } catch (err) {
      showToast('Opslaan mislukt. Probeer opnieuw.')
      console.error(err)
    } finally {
      saveBtn.disabled = true
      textarea.focus()
    }
  })
}

function showToast(msg: string): void {
  const toast = document.getElementById('toast') as HTMLDivElement
  toast.textContent = msg
  toast.classList.add('show')
  setTimeout(() => toast.classList.remove('show'), 2500)
}

function injectCaptureStyles(): void {
  if (document.getElementById('capture-styles')) return
  const style = document.createElement('style')
  style.id = 'capture-styles'
  style.textContent = `
    .capture-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      padding: var(--s-4);
      gap: var(--s-3);
      max-width: 640px;
      width: 100%;
      margin: 0 auto;
      padding-bottom: calc(var(--s-7) + env(safe-area-inset-bottom));
    }
    .capture-textarea {
      min-height: 40vh;
      font-size: var(--fs-lg);
      line-height: 1.6;
      resize: none;
    }
    .capture-mini-textarea {
      margin-top: var(--s-2);
    }
    .capture-extra {
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      overflow: hidden;
    }
    .capture-extra-toggle {
      padding: var(--s-3) var(--s-4);
      cursor: pointer;
      font-size: var(--fs-sm);
      color: var(--text-muted);
      list-style: none;
      user-select: none;
    }
    .capture-extra-toggle::-webkit-details-marker { display: none; }
    .capture-extra[open] .capture-extra-toggle {
      border-bottom: 1px solid var(--border);
    }
    .capture-extra textarea,
    .capture-bron-fields {
      padding: var(--s-3) var(--s-4);
    }
    .capture-bron-fields {
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }
    .capture-footer {
      position: sticky;
      bottom: 0;
      background: var(--bg);
      padding: var(--s-3) 0;
    }
  `
  document.head.appendChild(style)
}
