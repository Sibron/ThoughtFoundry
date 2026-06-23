import { saveSupabaseConfig } from '../lib/supabase'

export function renderSetup(app: HTMLElement): void {
  app.innerHTML = `
    <div class="setup-wrap">
      <div class="setup-card">
        <h1 class="setup-title">ThoughtFoundry instellen</h1>
        <p class="setup-intro">
          Vul hieronder je Supabase-projectgegevens in. Je vindt deze in je
          Supabase dashboard onder <strong>Project Settings → API</strong>.
          De gegevens worden lokaal opgeslagen in deze browser.
        </p>

        <div class="setup-field">
          <label for="setup-url" class="setup-label">Project URL</label>
          <input
            id="setup-url"
            type="url"
            class="setup-input"
            placeholder="https://jouw-project.supabase.co"
            autocomplete="off"
            spellcheck="false"
          />
        </div>

        <div class="setup-field">
          <label for="setup-key" class="setup-label">Anon / public key</label>
          <input
            id="setup-key"
            type="text"
            class="setup-input setup-input--mono"
            placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…"
            autocomplete="off"
            spellcheck="false"
          />
          <span class="setup-hint">
            Gebruik de <code>anon</code> key — nooit de <code>service_role</code> key.
          </span>
        </div>

        <div id="setup-error" class="setup-error" hidden></div>

        <button id="setup-save" class="setup-btn">Verbinden</button>

        <details class="setup-help">
          <summary>Waar vind ik deze gegevens?</summary>
          <ol>
            <li>Ga naar <strong>supabase.com</strong> en open je project.</li>
            <li>Klik op <strong>Project Settings</strong> (tandwiel) → <strong>API</strong>.</li>
            <li>Kopieer de <strong>Project URL</strong> en de <strong>anon public</strong> key.</li>
          </ol>
        </details>
      </div>
    </div>
  `

  injectSetupStyles()

  const urlInput  = document.getElementById('setup-url')  as HTMLInputElement
  const keyInput  = document.getElementById('setup-key')  as HTMLInputElement
  const saveBtn   = document.getElementById('setup-save') as HTMLButtonElement
  const errorBox  = document.getElementById('setup-error') as HTMLDivElement

  function showError(msg: string): void {
    errorBox.textContent = msg
    errorBox.hidden = false
  }

  saveBtn.addEventListener('click', () => {
    errorBox.hidden = true
    const url    = urlInput.value.trim()
    const anonKey = keyInput.value.trim()

    if (!url) { showError('Vul de Project URL in.'); urlInput.focus(); return }
    if (!anonKey) { showError('Vul de anon key in.'); keyInput.focus(); return }

    try {
      new URL(url)
    } catch {
      showError('De URL ziet er niet geldig uit. Controleer of hij begint met https://.')
      urlInput.focus()
      return
    }

    if (!anonKey.startsWith('eyJ')) {
      showError('De anon key lijkt niet correct — hij hoort te beginnen met "eyJ".')
      keyInput.focus()
      return
    }

    saveBtn.disabled = true
    saveBtn.textContent = 'Verbinden…'
    saveSupabaseConfig(url, anonKey) // reloads the page
  })
}

function injectSetupStyles(): void {
  if (document.getElementById('setup-styles')) return
  const style = document.createElement('style')
  style.id = 'setup-styles'
  style.textContent = `
    .setup-wrap {
      min-height: 100dvh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--s-5);
      background: var(--bg);
    }
    .setup-card {
      width: 100%;
      max-width: 480px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      padding: var(--s-6);
      display: flex;
      flex-direction: column;
      gap: var(--s-4);
    }
    .setup-title {
      font-size: var(--fs-xl);
      font-weight: 700;
    }
    .setup-intro {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      line-height: 1.6;
    }
    .setup-field {
      display: flex;
      flex-direction: column;
      gap: var(--s-1);
    }
    .setup-label {
      font-size: var(--fs-sm);
      font-weight: 600;
    }
    .setup-input {
      width: 100%;
      padding: var(--s-2) var(--s-3);
      border: 1px solid var(--border);
      border-radius: var(--r-sm);
      background: var(--bg);
      color: var(--text);
      font-size: var(--fs-sm);
    }
    .setup-input--mono { font-family: monospace; font-size: 0.75rem; }
    .setup-input:focus { outline: 2px solid var(--accent); outline-offset: 2px; }
    .setup-hint {
      font-size: var(--fs-xs, 0.72rem);
      color: var(--text-muted);
    }
    .setup-hint code {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 1px 4px;
      font-family: monospace;
    }
    .setup-error {
      background: #fde8e8;
      border: 1px solid var(--danger, #c0392b);
      border-radius: var(--r-sm);
      padding: var(--s-2) var(--s-3);
      font-size: var(--fs-sm);
      color: var(--danger, #c0392b);
    }
    .setup-btn {
      padding: var(--s-2) var(--s-4);
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: var(--r-sm);
      font-size: var(--fs-sm);
      font-weight: 600;
      cursor: pointer;
      align-self: flex-start;
    }
    .setup-btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .setup-help {
      font-size: var(--fs-sm);
      color: var(--text-muted);
    }
    .setup-help summary {
      cursor: pointer;
      font-weight: 500;
      color: var(--text);
    }
    .setup-help ol {
      margin: var(--s-2) 0 0 var(--s-4);
      line-height: 1.8;
    }
  `
  document.head.appendChild(style)
}
