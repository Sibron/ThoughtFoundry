import { signIn } from '../lib/auth'
import { navigateTo } from '../router'

export function renderLogin(app: HTMLElement): void {
  app.innerHTML = `
    <div class="login-wrapper">
      <div class="login-card">
        <h1 class="login-logo">ThoughtFoundry</h1>
        <form id="login-form" class="login-form" novalidate>
          <div class="field">
            <label for="email">E-mail</label>
            <input type="email" id="email" name="email" autocomplete="email" required />
          </div>
          <div class="field">
            <label for="password">Wachtwoord</label>
            <input type="password" id="password" name="password" autocomplete="current-password" required />
          </div>
          <div id="login-error" class="error-msg" aria-live="polite"></div>
          <button type="submit" class="btn btn-primary" id="login-btn">Aanmelden</button>
        </form>
      </div>
    </div>
  `

  injectLoginStyles()

  const form = document.getElementById('login-form') as HTMLFormElement
  const errorEl = document.getElementById('login-error') as HTMLDivElement
  const btn = document.getElementById('login-btn') as HTMLButtonElement

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const email = (document.getElementById('email') as HTMLInputElement).value.trim()
    const password = (document.getElementById('password') as HTMLInputElement).value
    errorEl.textContent = ''
    btn.disabled = true
    btn.textContent = 'Bezig...'
    try {
      await signIn(email, password)
      navigateTo('/capture')
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : 'Aanmelden mislukt.'
      btn.disabled = false
      btn.textContent = 'Aanmelden'
    }
  })
}

function injectLoginStyles(): void {
  if (document.getElementById('login-styles')) return
  const style = document.createElement('style')
  style.id = 'login-styles'
  style.textContent = `
    .login-wrapper {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--s-5);
      min-height: 100vh;
    }
    .login-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      padding: var(--s-7) var(--s-6);
      width: 100%;
      max-width: 380px;
      box-shadow: var(--shadow-card);
    }
    .login-logo {
      font-size: var(--fs-xl);
      font-weight: 800;
      color: var(--accent);
      text-align: center;
      margin-bottom: var(--s-6);
      letter-spacing: -0.03em;
    }
    .login-form {
      display: flex;
      flex-direction: column;
      gap: var(--s-4);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }
    .field label {
      font-size: var(--fs-sm);
      font-weight: 500;
      color: var(--text-muted);
    }
  `
  document.head.appendChild(style)
}
