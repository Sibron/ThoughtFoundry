// Returns the app's Supadata credit usage for the current billing period, so
// the capture page can show a "x / limit credits" counter. One shared key =
// one shared counter (the app owner's Supadata account).
//
// Supadata's GET /v1/me response shape isn't publicly documented, so the
// parser probes for credit-ish numeric fields by name rather than hard-coding
// a path, and echoes `raw` for verification. No-ops (usage:null) when
// SUPADATA_API_KEY is unset. verify_jwt is enforced at the platform level, so
// only logged-in users reach this.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const key = Deno.env.get('SUPADATA_API_KEY')
  if (!key) return jsonResponse({ usage: null, reason: 'no_key' })

  let res: Response
  try {
    res = await fetch('https://api.supadata.ai/v1/me', {
      headers: { 'x-api-key': key },
      signal: AbortSignal.timeout(15_000)
    })
  } catch (err) {
    console.error('[supadata-usage] fetch failed', err instanceof Error ? err.message : String(err))
    return jsonResponse({ usage: null, reason: 'fetch_failed' })
  }

  const text = await res.text()
  if (!res.ok) {
    console.error('[supadata-usage] error', JSON.stringify({ status: res.status, body: text.slice(0, 300) }))
    return jsonResponse({ usage: null, reason: 'api_error', status: res.status })
  }

  let body: unknown
  try { body = JSON.parse(text) } catch { return jsonResponse({ usage: null, reason: 'bad_json' }) }

  // Log the raw shape once so the exact field names can be verified via logs
  // (the public docs omit them). Safe: only aggregate credit counts, no key.
  console.log('[supadata-usage] /v1/me raw', JSON.stringify(body).slice(0, 800))

  const usage = normalizeUsage(body)
  return jsonResponse({ usage, plan: readPlan(body) })
})

interface Usage { limit: number | null; used: number | null; remaining: number | null }

function normalizeUsage(body: unknown): Usage {
  const nums: Record<string, number> = {}
  collectNumbers(body, '', nums)
  // Prefer keys mentioning "credit"; fall back to all numeric fields.
  const creditOnly = Object.fromEntries(Object.entries(nums).filter(([k]) => k.includes('credit')))
  const pool = Object.keys(creditOnly).length ? creditOnly : nums
  const pick = (subs: string[]): number | null => {
    for (const [k, v] of Object.entries(pool)) if (subs.some(s => k.includes(s))) return v
    return null
  }

  let limit = pick(['limit', 'quota', 'cap'])
  let used = pick(['used', 'consumed', 'spent'])
  let remaining = pick(['remaining', 'left', 'available'])

  if (remaining == null && limit != null && used != null) remaining = limit - used
  if (used == null && limit != null && remaining != null) used = limit - remaining
  if (limit == null && used != null && remaining != null) limit = used + remaining

  return { limit, used, remaining }
}

function collectNumbers(obj: unknown, prefix: string, out: Record<string, number>): void {
  if (!obj || typeof obj !== 'object') return
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = (prefix ? prefix + '.' : '') + k.toLowerCase()
    if (typeof v === 'number' && Number.isFinite(v)) out[path] = v
    else if (v && typeof v === 'object') collectNumbers(v, path, out)
  }
}

function readPlan(body: unknown): string | null {
  const b = body as Record<string, unknown>
  const p = b?.['plan'] ?? b?.['tier'] ?? b?.['planName']
  return typeof p === 'string' ? p : null
}
