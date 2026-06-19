import { signOut } from '../lib/auth'
import { supabase } from '../lib/supabase'
import { renderTopbar, attachTopbar, isAiEnabled, setAiEnabled } from '../lib/nav'
import { navigateTo } from '../router'
import { getMonthlyCap, setMonthlyCap, getCostStatus, formatUsd } from '../lib/cost'
import { fetchRecentUsage, summarize, type UsageRow } from '../lib/usage'
import { buildExport, downloadJson, importFromJson, type ExportPayload } from '../lib/exporter'
import { getInstallPrompt, clearInstallPrompt } from '../lib/pwa'
import { countByStatus } from '../lib/notes'
import { getPersona, setPersona, getDefaultPersona } from '../lib/persona'
import { fetchThemes, updateTheme, type Theme } from '../lib/themes'
import { getDensity, setDensity, getMotion, setMotion } from '../lib/display'

export async function renderSettings(app: HTMLElement): Promise<void> {
  app.innerHTML = `
    ${renderTopbar('Instellingen', 'settings')}
    <div class="settings-body" id="settings-body">
      <div class="settings-loading">Laden…</div>
    </div>
    <div class="toast" id="toast"></div>
  `

  injectSettingsStyles()
  attachTopbar()

  let usage: UsageRow[] = []
  let cost
  let inboxCount = 0
  let verwerktCount = 0
  let archiefCount = 0
  let userEmail: string | null = null
  let themes: Theme[] = []

  try {
    const [u, c, ib, vw, ar, userResp, th] = await Promise.all([
      fetchRecentUsage(50),
      getCostStatus(),
      countByStatus('inbox').catch(() => 0),
      countByStatus('verwerkt').catch(() => 0),
      countByStatus('archief').catch(() => 0),
      supabase.auth.getUser(),
      fetchThemes().catch(() => [] as Theme[])
    ])
    usage = u
    cost = c
    inboxCount = ib
    verwerktCount = vw
    archiefCount = ar
    userEmail = userResp.data.user?.email ?? null
    themes = th
  } catch (err) {
    document.getElementById('settings-body')!.innerHTML =
      `<div class="settings-error">Laden mislukt: ${escHtml(errMsg(err))}</div>`
    return
  }

  const summary = summarize(usage)

  document.getElementById('settings-body')!.innerHTML = `
    <section class="settings-section" id="pwa-install-section" ${getInstallPrompt() ? '' : 'hidden'}>
      <h2>App installeren</h2>
      <p class="muted">Installeer ThoughtFoundry op je apparaat voor snelle toegang zonder browser — werkt ook offline.</p>
      <button class="btn btn-primary" id="pwa-install-btn">Installeer app</button>
    </section>

    <section class="settings-section">
      <h2>Account</h2>
      <p>${escHtml(userEmail ?? 'onbekend')}</p>
      <button class="btn btn-ghost" id="settings-logout">Afmelden</button>
    </section>

    <section class="settings-section">
      <h2>AI-functies</h2>
      <p class="muted">Verwerken, graaf en boekgeneratie gebruiken Claude (AI). Standaard uit — de kern (capture, inbox, thema's) werkt volledig zonder AI.</p>
      <label class="ai-toggle">
        <input type="checkbox" id="ai-toggle" ${isAiEnabled() ? 'checked' : ''} />
        <span>AI inschakelen</span>
      </label>
      ${isAiEnabled()
        ? ''
        : '<p class="muted">Zet dit pas aan als de edge functions en <code>ANTHROPIC_API_KEY</code> in Supabase geconfigureerd zijn.</p>'}
    </section>

    <section class="settings-section">
      <h2>Weergave</h2>
      <p class="muted">Pas dichtheid en beweging aan naar wat voor jou rustig werkt.</p>
      <label class="field">
        <span class="field-label">Dichtheid</span>
        <select id="density-select">
          <option value="comfortabel"${getDensity() === 'comfortabel' ? ' selected' : ''}>Comfortabel (ruim)</option>
          <option value="compact"${getDensity() === 'compact' ? ' selected' : ''}>Compact (dicht)</option>
        </select>
      </label>
      <label class="ai-toggle">
        <input type="checkbox" id="motion-toggle" ${getMotion() === 'reduced' ? 'checked' : ''} />
        <span>Beweging beperken (geen animaties / overgangen)</span>
      </label>
    </section>

    <section class="settings-section">
      <h2>Terugkeermomenten</h2>
      <p class="muted">Plan een vast verwerkmoment in je agenda — 25 minuten per week is genoeg.</p>
      <a class="btn btn-ghost"
         href="https://www.google.com/calendar/render?action=TEMPLATE&text=TF+verwerken&details=ThoughtFoundry+verwerkingssessie+(max+25+min)&recur=RRULE:FREQ%3DWEEKLY&sf=true&output=xml"
         target="_blank" rel="noopener noreferrer">
        Voeg wekelijks TF-moment toe aan Google Agenda
      </a>
    </section>

    <section class="settings-section">
      <h2>Persoonlijke context voor AI</h2>
      <p class="muted">Deze tekst wordt aan elk AI-verzoek toegevoegd zodat de AI jouw rol, werkstijl en voorkeuren kent. Leeg laten = standaard uitgeschakeld.</p>
      <textarea id="persona-textarea" rows="6" style="font-size:var(--fs-sm);line-height:1.5">${escHtml(getPersona())}</textarea>
      <div style="display:flex;gap:var(--s-2);flex-wrap:wrap">
        <button class="btn btn-primary" id="persona-save">Opslaan</button>
        <button class="btn btn-ghost" id="persona-reset">Herstel standaard</button>
      </div>
    </section>

    <section class="settings-section">
      <h2>Nota-overzicht</h2>
      <ul class="stats-grid">
        <li><span class="stat-label">Inbox</span><span class="stat-value">${inboxCount}</span></li>
        <li><span class="stat-label">Verwerkt</span><span class="stat-value">${verwerktCount}</span></li>
        <li><span class="stat-label">Archief</span><span class="stat-value">${archiefCount}</span></li>
      </ul>
    </section>

    <section class="settings-section">
      <h2>Gevoelige thema's</h2>
      <p class="muted">Noten met een gevoelig thema krijgen gerichte, afsluitende AI-suggesties (geen open vragen).</p>
      ${themes.length === 0
        ? '<p class="muted">Nog geen thema\'s aangemaakt.</p>'
        : themes.map(t => `
        <label class="sensitive-theme-label">
          <input type="checkbox" class="sensitive-theme-check" data-theme-id="${t.id}" ${t.is_sensitive ? 'checked' : ''} />
          <span class="theme-dot-mini" style="background:${escHtml(t.color)}"></span>
          ${escHtml(t.name)}
        </label>`).join('')
      }
    </section>

    <section class="settings-section">
      <h2>AI-kostenplafond</h2>
      <p class="muted">Maandelijkse waarschuwingsdrempel. Boven de cap krijg je een expliciete confirm. Lokaal opgeslagen — niet gesynchroniseerd.</p>
      <div class="cost-row">
        <label class="field">
          <span class="field-label">Cap (USD)</span>
          <input type="number" id="cap-input" min="0" step="0.5" value="${getMonthlyCap()}" />
        </label>
        <button class="btn btn-primary" id="cap-save">Opslaan</button>
      </div>
      <p class="cost-summary">
        Deze maand uitgegeven: <strong>${formatUsd(cost?.spendUsd ?? 0)}</strong>
        van <strong>${formatUsd(cost?.capUsd ?? 0)}</strong>
        (${((cost?.ratio ?? 0) * 100).toFixed(0)}%)
      </p>
    </section>

    <section class="settings-section">
      <h2>Recent AI-gebruik (laatste ${usage.length})</h2>
      ${usage.length === 0 ? '<p class="muted">Nog geen AI-aanroepen.</p>' : `
        <div class="usage-summary">
          <div><span class="muted">Totaal in lijst:</span> <strong>${formatUsd(summary.totalCost)}</strong></div>
          <div>
            ${Object.entries(summary.byOperation).map(([op, v]) =>
              `<span class="badge">${escHtml(op)}: ${v.count}× / ${formatUsd(v.cost)}</span>`
            ).join(' ')}
          </div>
        </div>
        <div class="usage-table-wrap">
          <table class="usage-table">
            <thead>
              <tr><th>Wanneer</th><th>Operatie</th><th>Model</th><th>Tokens</th><th>Kost</th></tr>
            </thead>
            <tbody>
              ${usage.map(r => `
                <tr>
                  <td>${escHtml(formatRelative(r.created_at))}</td>
                  <td>${escHtml(r.operation)}</td>
                  <td>${escHtml(r.model)}</td>
                  <td>${r.input_tokens} → ${r.output_tokens}</td>
                  <td>${formatUsd(Number(r.cost_usd ?? 0))}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </section>

    <section class="settings-section">
      <h2>Data-export</h2>
      <p class="muted">Download al je nota's, thema's, koppelingen, hoofdstukken en boeken als JSON. Volledig portable; geen vendor lock-in.</p>
      <button class="btn btn-primary" id="export-btn">Exporteer JSON</button>
    </section>

    <section class="settings-section">
      <h2>Data-import</h2>
      <p class="muted">Importeer nota's vanuit een eerder geëxporteerd ThoughtFoundry JSON-bestand. Bestaande nota's (zelfde ID) worden overgeslagen.</p>
      <label class="field">
        <span class="field-label">JSON-bestand kiezen</span>
        <input type="file" id="import-file" accept=".json,application/json" />
      </label>
      <div id="import-preview" hidden class="import-preview"></div>
      <button class="btn btn-primary" id="import-btn" hidden>Importeer</button>
    </section>
  `

  document.getElementById('settings-logout')?.addEventListener('click', async () => {
    await signOut()
    navigateTo('/login')
  })

  document.getElementById('ai-toggle')?.addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked
    setAiEnabled(on)
    showToast(on ? 'AI ingeschakeld' : 'AI uitgeschakeld')
    renderSettings(app) // re-render so nav + hints reflect the new state
  })

  document.getElementById('density-select')?.addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value === 'compact' ? 'compact' : 'comfortabel'
    setDensity(v)
    showToast('Weergave bijgewerkt')
  })

  document.getElementById('motion-toggle')?.addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked
    setMotion(on ? 'reduced' : 'auto')
    showToast(on ? 'Beweging beperkt' : 'Beweging ingeschakeld')
  })

  document.getElementById('persona-save')?.addEventListener('click', () => {
    const val = (document.getElementById('persona-textarea') as HTMLTextAreaElement).value.trim()
    setPersona(val)
    showToast('Persoonlijke context opgeslagen')
  })

  document.getElementById('persona-reset')?.addEventListener('click', () => {
    const ta = document.getElementById('persona-textarea') as HTMLTextAreaElement
    ta.value = getDefaultPersona()
    setPersona(getDefaultPersona())
    showToast('Standaard hersteld')
  })

  document.getElementById('cap-save')?.addEventListener('click', () => {
    const v = Number((document.getElementById('cap-input') as HTMLInputElement).value)
    if (!Number.isFinite(v) || v <= 0) { showToast('Geef een positief getal'); return }
    setMonthlyCap(v)
    showToast('Cap bijgewerkt')
  })

  document.getElementById('export-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('export-btn') as HTMLButtonElement
    btn.disabled = true
    btn.textContent = 'Bezig…'
    try {
      const payload = await buildExport()
      const date = new Date().toISOString().slice(0, 10)
      downloadJson(payload, `thoughtfoundry-export-${date}.json`)
      showToast('Export klaar')
    } catch (err) {
      showToast(`Export mislukt: ${errMsg(err)}`)
    } finally {
      btn.disabled = false
      btn.textContent = 'Exporteer JSON'
    }
  })

  let pendingImport: ExportPayload | null = null

  document.getElementById('import-file')?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string) as ExportPayload
        const noteCount = (parsed.notes ?? []).length
        const themeCount = (parsed.themes ?? []).length
        const linkCount = (parsed.note_links ?? []).length
        const sourceCount = ((parsed as unknown as Record<string, unknown>)['sources'] as unknown[] ?? []).length
        const previewEl = document.getElementById('import-preview') as HTMLDivElement
        const importBtn = document.getElementById('import-btn') as HTMLButtonElement
        previewEl.hidden = false
        const parts = [`${noteCount} nota${noteCount === 1 ? '' : "'s"}`]
        if (themeCount) parts.push(`${themeCount} thema's`)
        if (sourceCount) parts.push(`${sourceCount} bronnen`)
        if (linkCount) parts.push(`${linkCount} links`)
        previewEl.textContent = `Gevonden: ${parts.join(', ')}. Bestaande nota's (zelfde ID) worden overgeslagen.`
        importBtn.hidden = false
        pendingImport = parsed
      } catch {
        showToast('Ongeldig JSON-bestand')
        pendingImport = null
      }
    }
    reader.readAsText(file)
  })

  document.getElementById('pwa-install-btn')?.addEventListener('click', async () => {
    const prompt = getInstallPrompt()
    if (!prompt) return
    await prompt.prompt()
    const { outcome } = await prompt.userChoice
    if (outcome === 'accepted') {
      clearInstallPrompt()
      document.getElementById('pwa-install-section')?.setAttribute('hidden', '')
      showToast('App geïnstalleerd!')
    }
  })

  document.querySelectorAll<HTMLInputElement>('.sensitive-theme-check').forEach(cb => {
    cb.addEventListener('change', async () => {
      const themeId = cb.dataset['themeId']!
      try {
        await updateTheme(themeId, { is_sensitive: cb.checked })
        showToast(cb.checked ? 'Thema gemarkeerd als gevoelig' : 'Markering verwijderd')
      } catch (err) {
        showToast(`Mislukt: ${errMsg(err)}`)
        cb.checked = !cb.checked
      }
    })
  })

  document.getElementById('import-btn')?.addEventListener('click', async () => {
    if (!pendingImport) return
    const btn = document.getElementById('import-btn') as HTMLButtonElement
    btn.disabled = true
    btn.textContent = 'Importeren…'
    try {
      const result = await importFromJson(pendingImport)
      const parts = [`${result.imported} nota${result.imported === 1 ? '' : "'s"}`]
      if (result.themes) parts.push(`${result.themes} thema's`)
      if (result.sources) parts.push(`${result.sources} bronnen`)
      if (result.links) parts.push(`${result.links} links`)
      if (result.skipped) parts.push(`${result.skipped} overgeslagen`)
      showToast(`Geïmporteerd: ${parts.join(', ')}`)
      if (result.errors.length > 0) {
        console.warn('Import errors:', result.errors)
      }
      pendingImport = null
      const previewEl = document.getElementById('import-preview') as HTMLDivElement
      previewEl.hidden = true
      btn.hidden = true
      ;(document.getElementById('import-file') as HTMLInputElement).value = ''
    } catch (err) {
      showToast(`Import mislukt: ${errMsg(err)}`)
    } finally {
      btn.disabled = false
      btn.textContent = 'Importeer'
    }
  })
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

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1)   return 'net'
  if (min < 60)  return `${min}m geleden`
  const hr = Math.floor(min / 60)
  if (hr < 24)   return `${hr}u geleden`
  const day = Math.floor(hr / 24)
  if (day < 7)   return `${day}d geleden`
  return new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })
}

function injectSettingsStyles(): void {
  if (document.getElementById('settings-styles')) return
  const style = document.createElement('style')
  style.id = 'settings-styles'
  style.textContent = `
    .settings-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: var(--s-5);
      padding: var(--s-4);
      max-width: 760px;
      width: 100%;
      margin: 0 auto;
    }
    .settings-section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: var(--s-4);
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
    }
    .settings-section h2 {
      font-size: var(--fs-lg);
      font-weight: 600;
    }
    .settings-section .btn { width: auto; }
    .import-preview {
      padding: var(--s-2) var(--s-3);
      background: #E8F5EE;
      border: 1px solid var(--accent);
      border-radius: var(--r-sm);
      font-size: var(--fs-sm);
      color: var(--text);
    }
    .stats-grid {
      list-style: none;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: var(--s-2);
    }
    .stats-grid li {
      background: var(--bg);
      border-radius: var(--r-sm);
      padding: var(--s-3);
      display: flex;
      flex-direction: column;
      gap: var(--s-1);
      text-align: center;
    }
    .stat-label { font-size: var(--fs-sm); color: var(--text-muted); }
    .stat-value { font-size: var(--fs-xl); font-weight: 600; }
    .cost-row {
      display: flex;
      gap: var(--s-2);
      align-items: end;
      flex-wrap: wrap;
    }
    .cost-row input {
      width: 140px;
    }
    .cost-summary {
      font-size: var(--fs-sm);
      color: var(--text-muted);
    }
    .ai-toggle {
      display: inline-flex;
      align-items: center;
      gap: var(--s-2);
      cursor: pointer;
      font-weight: 500;
    }
    .ai-toggle input { width: 18px; height: 18px; }
    .field { display: flex; flex-direction: column; gap: var(--s-1); }
    .field-label { font-size: var(--fs-sm); color: var(--text-muted); font-weight: 500; }
    .usage-summary {
      display: flex;
      gap: var(--s-3);
      flex-wrap: wrap;
      font-size: var(--fs-sm);
    }
    .usage-table-wrap {
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: var(--r-sm);
    }
    .usage-table {
      width: 100%;
      border-collapse: collapse;
      font-size: var(--fs-sm);
    }
    .usage-table th,
    .usage-table td {
      padding: var(--s-2) var(--s-3);
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    .usage-table th {
      background: var(--bg);
      font-weight: 500;
      color: var(--text-muted);
    }
    .usage-table tr:last-child td { border-bottom: none; }
    .settings-loading,
    .settings-error {
      text-align: center;
      padding: var(--s-7);
      color: var(--text-muted);
    }
    .muted { color: var(--text-muted); font-size: var(--fs-sm); }
    .sensitive-theme-label {
      display: flex;
      align-items: center;
      gap: var(--s-2);
      cursor: pointer;
      font-size: var(--fs-sm);
    }
    .sensitive-theme-label input { width: 16px; height: 16px; }
    .theme-dot-mini {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }
  `
  document.head.appendChild(style)
}
