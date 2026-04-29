import { insertNote, queueOfflineNote, flushOfflineQueue, offlineQueueSize, type NoteInsert } from '../lib/notes'
import { signOut } from '../lib/auth'
import { navigateTo } from '../router'

export async function renderCapture(app: HTMLElement): Promise<void> {
  // Best-effort flush on render — the helper itself returns silently if offline.
  flushOfflineQueue().catch(() => { /* silent */ })

  app.innerHTML = `
    <div class="topbar">
      <span class="topbar-title">ThoughtFoundry</span>
      <div class="topbar-actions">
        <span class="online-indicator" id="online-indicator" title=""></span>
        <button class="topbar-btn" id="goto-inbox">Inbox</button>
        <button class="topbar-btn" id="goto-process">Verwerken</button>
        <button class="topbar-btn" id="goto-graph">Graaf</button>
        <button class="topbar-btn" id="goto-book">Boek</button>
        <button class="topbar-btn" id="goto-themes">Thema's</button>
        <button class="topbar-btn" id="goto-settings">⚙</button>
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
  document.getElementById('goto-process')?.addEventListener('click', () => navigateTo('/process'))
  document.getElementById('goto-graph')?.addEventListener('click', () => navigateTo('/graph'))
  document.getElementById('goto-book')?.addEventListener('click', () => navigateTo('/book'))
  document.getElementById('goto-themes')?.addEventListener('click', () => navigateTo('/themes'))
  document.getElementById('goto-settings')?.addEventListener('click', () => navigateTo('/settings'))
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
    if (miniTextarea.value.trim())  note.mini_notes = miniTextarea.value.trim()
    if (sourceUrl.value.trim())     note.source_url = sourceUrl.value.trim()
    if (sourceTitle.value.trim())   note.source_title = sourceTitle.value.trim()
    if (sourceAuthor.value.trim())  note.source_author = sourceAuthor.value.trim()

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
      await refreshOnlineIndicator()
    } catch (err) {
      showToast('Opslaan mislukt. Probeer opnieuw.')
      console.error(err)
    } finally {
      saveBtn.disabled = true
      textarea.focus()
    }
  })

  // Online/offline indicator + auto-flush on reconnect
  await refreshOnlineIndicator()

  const onOnline = async () => {
    const flushed = await flushOfflineQueue()
    if (flushed > 0) showToast(`${flushed} offline-nota('s) gesynchroniseerd`)
    await refreshOnlineIndicator()
  }
  const onOffline = () => refreshOnlineIndicator()
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
}

async function refreshOnlineIndicator(): Promise<void> {
  const el = document.getElementById('online-indicator')
  if (!el) return
  const queue = await offlineQueueSize().catch(() => 0)
  if (!navigator.onLine) {
    el.textContent = queue > 0 ? `⚫ offline (${queue})` : '⚫ offline'
    el.className = 'online-indicator offline'
    el.title = `Offline${queue > 0 ? ` — ${queue} nota('s) wachten op sync` : ''}`
  } else if (queue > 0) {
    el.textContent = `🟡 sync (${queue})`
    el.className = 'online-indicator sync'
    el.title = `${queue} nota('s) wachten op sync`
  } else {
    el.textContent = '🟢 online'
    el.className = 'online-indicator online'
    el.title = 'Online'
  }
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
    .online-indicator {
      font-size: 12px;
      padding: 2px var(--s-2);
      border-radius: var(--r-sm);
      color: var(--text-muted);
      cursor: default;
    }
    .online-indicator.offline { color: var(--danger); }
    .online-indicator.sync    { color: #B57C00; }
    .online-indicator.online  { color: var(--accent-hover); }
  `
  document.head.appendChild(style)
}
