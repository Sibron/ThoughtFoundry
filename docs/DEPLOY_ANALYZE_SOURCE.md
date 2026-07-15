# Deploy: bron analyseren (`analyze-source`)

Eén edge function. Geen migraties. Vereist de bestaande `ANTHROPIC_API_KEY`.
De frontend (Capture → "Bron analyseren (AI)") werkt pas nadat deze functie
live staat; tot die tijd geeft de knop een nette foutmelding.

## Optioneel: automatische YouTube-transcripten (`SUPADATA_API_KEY`)

YouTube blokkeert het ophalen van ondertitels vanaf datacenter-IP's (zoals die
van Supabase), dus zónder deze secret vraagt de app je bij YouTube-video's om
het transcript handmatig te plakken. Zet je een `SUPADATA_API_KEY`, dan haalt
de functie het transcript automatisch op via [Supadata](https://supadata.ai)
(gratis tier ~100 video's/maand; transcribeert via Whisper zelfs video's zónder
ondertitels). Websites werken sowieso automatisch.

Instellen: dashboard → project → **Edge Functions** → **Secrets** → nieuwe
secret `SUPADATA_API_KEY` met je Supadata-key. De functie no-opt netjes zonder
deze secret, dus je kunt 'm later toevoegen zonder de code te wijzigen.

## Optie A — CLI

```bash
supabase functions deploy analyze-source
```

## Optie B — Dashboard (geen CLI)

1. Open https://supabase.com/dashboard → project **ThoughtFoundry**.
2. Linkerzijbalk → **Edge Functions** → **Deploy a new function** / **Create function**.
3. Naam: `analyze-source` (exact — de frontend roept deze naam aan).
4. Plak de single-file versie hieronder in `index.ts` (shared helpers zijn
   ge-inlined, de `_shared` map is niet nodig) → **Deploy**.

### `analyze-source` → index.ts

```ts
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

type AnthropicModel = 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-7'
const PRICING: Record<AnthropicModel, { input: number; output: number }> = {
  'claude-haiku-4-5':  { input: 1.0,  output: 5.0  },
  'claude-sonnet-4-6': { input: 3.0,  output: 15.0 },
  'claude-opus-4-7':   { input: 5.0,  output: 25.0 }
}
function estimateCost(model: AnthropicModel, i: number, o: number): number {
  const p = PRICING[model]; return (i * p.input + o * p.output) / 1_000_000
}
async function callAnthropic(opts: { apiKey: string; model: AnthropicModel; system: string; messages: { role: 'user' | 'assistant'; content: string }[]; maxTokens?: number }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: opts.model, max_tokens: opts.maxTokens ?? 1024, system: opts.system, messages: opts.messages })
  })
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const text = (data.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('')
  return { text, inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 }
}
function parseJsonFromResponse<T>(text: string): T {
  const trimmed = text.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  return JSON.parse(fence ? fence[1].trim() : trimmed) as T
}

function getUserClient(req: Request): SupabaseClient {
  const authHeader = req.headers.get('Authorization') ?? ''
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } })
}
async function requireUserId(client: SupabaseClient): Promise<string> {
  const { data, error } = await client.auth.getUser()
  if (error || !data.user) throw new Error('Unauthorized')
  return data.user.id
}
async function logUsage(client: SupabaseClient, args: { userId: string; model: string; operation: string; inputTokens: number; outputTokens: number; costUsd: number }): Promise<void> {
  await client.from('ai_usage').insert({
    user_id: args.userId, model: args.model, operation: args.operation,
    input_tokens: args.inputTokens, output_tokens: args.outputTokens, cost_usd: args.costUsd
  })
}
const DEFAULT_CAP_USD = 5
async function enforceBudget(client: SupabaseClient, body: { overrideCap?: unknown }): Promise<Response | null> {
  if (body.overrideCap === true) return null
  let cap = DEFAULT_CAP_USD
  try {
    const { data } = await client.from('user_settings').select('ai_monthly_cap_usd').maybeSingle()
    if (data && data.ai_monthly_cap_usd != null) cap = Number(data.ai_monthly_cap_usd)
  } catch { return null }
  let spend = 0
  try {
    const { data, error } = await client.rpc('ai_cost_this_month')
    if (error) return null
    spend = Number(data ?? 0)
  } catch { return null }
  if (spend >= cap) return jsonResponse({ error: 'ai_budget_exceeded', spend, cap }, 402)
  return null
}

interface AnalyzeRequest {
  overrideCap?: boolean
  url?: string
  pastedText?: string
  persona?: string
  model?: 'claude-haiku-4-5' | 'claude-sonnet-4-6'
}
interface Proposal {
  title: string
  author: string | null
  source_type: string
  summary: string
  insights: { content: string; core_idea?: string; tags?: string[] }[]
}
interface SourceMeta {
  title: string | null
  author: string | null
  url: string
  source_type: 'video' | 'article'
}

const VALID_SOURCE_TYPES = new Set(['book', 'article', 'paper', 'podcast', 'video', 'course', 'other'])
const CONTENT_CHAR_BUDGET = 18_000
const MAX_HTML_BYTES = 1_500_000
const FETCH_TIMEOUT_MS = 12_000
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const SYSTEM_PROMPT = `Je bent een kennis-assistent voor een persoonlijk denksysteem (ThoughtFoundry).
De gebruiker capteert atomische ideeën over o.a. autisme/neurodiversiteit, relaties, coaching, management en persoonlijke ontwikkeling.

Jouw taak: de inhoud van één externe bron (artikel of videotranscript) kort analyseren en de potentiële inzichten eruit destilleren als losse gedachte-notities.

Schrijf alle teksten in het Nederlands.

Antwoord ALLEEN met geldige JSON, in dit exacte formaat:
{
  "title": "titel van de bron, max 120 chars",
  "author": "auteur of maker, of null als onbekend",
  "source_type": "video",
  "summary": "2-4 zinnen: waar gaat deze bron over",
  "insights": [
    {
      "content": "een zelfstandige, atomaire gedachte-notitie van 1-4 zinnen",
      "core_idea": "de kern in één zin",
      "tags": ["max 5 tags, lowercase, single-word of-met-streepje"]
    }
  ]
}

Geldige waarden voor "source_type": "book", "article", "paper", "podcast", "video", "course", "other".

Regels voor de insights:
- 3 tot 8 inzichten. Liever minder goede dan opvulling — geef alleen inzichten waar de gebruiker op kan voortbouwen.
- Elk inzicht is een ZELFSTANDIGE gedachte-notitie: een idee, claim of vraag die op zichzelf leesbaar is zonder de bron erbij. Geen citaten, geen samenvattingspuntjes, geen "de video zegt dat...".
- Formuleer in de stijl van een eigen notitie: direct, inhoudelijk, prikkelend.
- "core_idea" is één zin die de kern vangt.`

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')   return jsonResponse({ error: 'Method not allowed' }, 405)

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return jsonResponse({ error: 'ANTHROPIC_API_KEY not configured' }, 500)

  let body: AnalyzeRequest
  try { body = await req.json() } catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }

  const rawUrl = typeof body.url === 'string' ? body.url.trim() : ''
  const pastedText = typeof body.pastedText === 'string' ? body.pastedText.trim() : ''
  if (!rawUrl && !pastedText) return jsonResponse({ error: 'url or pastedText required' }, 400)

  let url: URL | null = null
  if (rawUrl) {
    try { url = new URL(rawUrl) } catch { return jsonResponse({ error: 'Invalid URL' }, 400) }
    if (!isSafeUrl(url)) return jsonResponse({ error: 'URL not allowed' }, 400)
  }

  const model = body.model ?? 'claude-haiku-4-5'
  const supabase = getUserClient(req)

  let userId: string
  try { userId = await requireUserId(supabase) }
  catch { return jsonResponse({ error: 'Unauthorized' }, 401) }

  const blocked = await enforceBudget(supabase, body)
  if (blocked) return blocked

  const kind = url ? detectUrlKind(url) : null
  let meta: SourceMeta = {
    title: null,
    author: null,
    url: url?.toString() ?? '',
    source_type: kind === 'youtube' ? 'video' : 'article'
  }
  let content = ''
  let retrieval: 'captions' | 'pasted' | 'html' | 'supadata' = 'pasted'

  if (kind === 'youtube' && url) {
    const videoId = extractYoutubeId(url)
    const oembed = await fetchYoutubeOembed(url.toString())
    meta = { ...meta, title: oembed?.title ?? null, author: oembed?.author ?? null, source_type: 'video' }

    if (pastedText) {
      content = pastedText
      retrieval = 'pasted'
    } else {
      let transcript = videoId ? await fetchYoutubeTranscript(videoId) : null
      let via: typeof retrieval = 'captions'
      if (!transcript || transcript.length < 200) {
        const supa = await fetchSupadataTranscript(url.toString())
        if (supa && supa.length >= 200) { transcript = supa; via = 'supadata' }
      }
      if (!transcript || transcript.length < 200) {
        return jsonResponse({ needsManualText: true, reason: 'no_captions', meta })
      }
      content = transcript
      retrieval = via
    }
  } else if (kind === 'website' && url) {
    const page = await fetchWebsite(url.toString())
    if (page) {
      meta = { ...meta, title: page.title, author: page.author, source_type: page.sourceType }
    }
    if (pastedText) {
      content = pastedText
      retrieval = 'pasted'
    } else if (!page) {
      return jsonResponse({ needsManualText: true, reason: 'fetch_failed', meta })
    } else if (page.text.length < 200) {
      return jsonResponse({ needsManualText: true, reason: 'empty_content', meta })
    } else {
      content = page.text
      retrieval = 'html'
    }
  } else {
    content = pastedText
    retrieval = 'pasted'
    meta = { ...meta, source_type: 'article' }
  }

  content = content.slice(0, CONTENT_CHAR_BUDGET)

  const userPrompt = buildUserPrompt(meta, content, retrieval)
  const system = [body.persona?.trim(), SYSTEM_PROMPT].filter(Boolean).join('\n\n')

  let result
  try {
    result = await callAnthropic({
      apiKey, model, system,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 2000
    })
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'AI call failed' }, 502)
  }

  let proposal: Proposal
  try {
    proposal = parseJsonFromResponse<Proposal>(result.text)
  } catch {
    return jsonResponse({ error: 'AI returned invalid JSON', raw: result.text }, 502)
  }

  proposal.title = (meta.title ?? proposal.title ?? '').toString().slice(0, 200) || 'Onbekende bron'
  proposal.author = meta.author ?? (proposal.author ? String(proposal.author) : null)
  if (!VALID_SOURCE_TYPES.has(proposal.source_type ?? '')) proposal.source_type = meta.source_type
  proposal.summary = (proposal.summary ?? '').toString()
  proposal.insights = (proposal.insights ?? [])
    .filter(i => i && typeof i.content === 'string' && i.content.trim().length > 0)
    .slice(0, 8)
    .map(i => ({
      content: i.content.trim(),
      core_idea: typeof i.core_idea === 'string' ? i.core_idea.trim() : undefined,
      tags: (Array.isArray(i.tags) ? i.tags : [])
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .map(t => t.trim().toLowerCase())
        .slice(0, 5)
    }))

  const cost = estimateCost(model, result.inputTokens, result.outputTokens)
  await logUsage(supabase, {
    userId, model, operation: 'analyze-source',
    inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost
  })

  return jsonResponse({
    proposal,
    retrieval,
    contentChars: content.length,
    usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost }
  })
})

function buildUserPrompt(meta: SourceMeta, content: string, retrieval: string): string {
  const kindLabel = retrieval === 'captions' ? 'videotranscript (automatische ondertitels — kan spreektaal en fouten bevatten)'
    : retrieval === 'html' ? 'tekst van een webpagina (kan restjes navigatie bevatten)'
    : 'door de gebruiker geplakte tekst'
  const metaLines = [
    meta.url ? `URL: ${meta.url}` : null,
    meta.title ? `Titel: ${meta.title}` : null,
    meta.author ? `Auteur/maker: ${meta.author}` : null
  ].filter(Boolean).join('\n')
  return `## Bron\n\n${metaLines || '(geen metadata bekend)'}\n\nInhoud (${kindLabel}):\n\n${content}\n\nAnalyseer deze bron en geef je voorstel als JSON.`
}

function isSafeUrl(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false
  if (host.startsWith('[') || host.includes(':')) return false
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a === 0 || a === 10 || a === 127 || a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
  }
  return true
}

function detectUrlKind(url: URL): 'youtube' | 'website' {
  const host = url.hostname.toLowerCase().replace(/^www\.|^m\./, '')
  if (host === 'youtu.be') return 'youtube'
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    const p = url.pathname
    if (p === '/watch' || p.startsWith('/shorts/') || p.startsWith('/live/') || p.startsWith('/embed/')) {
      return 'youtube'
    }
  }
  return 'website'
}

function extractYoutubeId(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^www\.|^m\./, '')
  let id: string | null = null
  if (host === 'youtu.be') {
    id = url.pathname.slice(1).split('/')[0]
  } else if (url.pathname === '/watch') {
    id = url.searchParams.get('v')
  } else {
    const m = url.pathname.match(/^\/(?:shorts|live|embed)\/([^/?]+)/)
    id = m ? m[1] : null
  }
  return id && /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : null
}

async function fetchYoutubeOembed(watchUrl: string): Promise<{ title: string; author: string | null } | null> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`,
      { signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) return null
    const data = await res.json()
    if (typeof data.title !== 'string') return null
    return { title: data.title, author: typeof data.author_name === 'string' ? data.author_name : null }
  } catch {
    return null
  }
}

async function fetchSupadataTranscript(youtubeUrl: string): Promise<string | null> {
  const key = Deno.env.get('SUPADATA_API_KEY')
  if (!key) return null
  try {
    const res = await fetch(
      `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(youtubeUrl)}&text=true`,
      { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(60_000) }
    )
    if (!res.ok) {
      console.error('[supadata] error', JSON.stringify({ status: res.status, body: (await res.text()).slice(0, 300) }))
      return null
    }
    const data = await res.json()
    let text = ''
    if (typeof data.content === 'string') text = data.content
    else if (Array.isArray(data.content)) {
      text = data.content.map((c: { text?: string }) => c.text ?? '').join(' ')
    }
    text = text.replace(/\s+/g, ' ').trim()
    return text.length > 0 ? text : null
  } catch (err) {
    console.error('[supadata] fetch failed', err instanceof Error ? err.message : String(err))
    return null
  }
}

async function fetchYoutubeTranscript(videoId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'nl,en;q=0.8' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok) return null
    const html = await res.text()

    const tracksJson = extractJsonArrayAfter(html, '"captionTracks":')
    if (!tracksJson) return null
    let tracks: { baseUrl?: string; languageCode?: string; kind?: string }[]
    try { tracks = JSON.parse(tracksJson) } catch { return null }
    if (!Array.isArray(tracks) || tracks.length === 0) return null

    const track = pickCaptionTrack(tracks)
    if (!track?.baseUrl) return null
    const baseUrl = track.baseUrl.replace(/\\u0026/g, '&')

    const json3 = await fetchCaptionJson3(baseUrl)
    if (json3) return json3
    return await fetchCaptionXml(baseUrl)
  } catch {
    return null
  }
}

function pickCaptionTrack(
  tracks: { baseUrl?: string; languageCode?: string; kind?: string }[]
): { baseUrl?: string } | null {
  const byLang = (lang: string) => tracks.filter(t => (t.languageCode ?? '').startsWith(lang))
  for (const pool of [byLang('nl'), byLang('en'), tracks]) {
    if (pool.length === 0) continue
    return pool.find(t => t.kind !== 'asr') ?? pool[0]
  }
  return null
}

async function fetchCaptionJson3(baseUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}&fmt=json3`, {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok) return null
    const data = await res.json()
    const events = Array.isArray(data.events) ? data.events : []
    const text = events
      .flatMap((e: { segs?: { utf8?: string }[] }) => (e.segs ?? []).map(s => s.utf8 ?? ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

async function fetchCaptionXml(baseUrl: string): Promise<string | null> {
  try {
    const res = await fetch(baseUrl, {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok) return null
    const xml = await res.text()
    const text = decodeEntities(xml.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

function extractJsonArrayAfter(html: string, marker: string): string | null {
  const start = html.indexOf(marker)
  if (start === -1) return null
  const open = html.indexOf('[', start + marker.length)
  if (open === -1) return null
  let depth = 0
  let inString = false
  for (let i = open; i < html.length && i < open + 500_000; i++) {
    const ch = html[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
    } else if (ch === '[') {
      depth++
    } else if (ch === ']') {
      depth--
      if (depth === 0) return html.slice(open, i + 1)
    }
  }
  return null
}

async function fetchWebsite(pageUrl: string): Promise<{
  title: string | null
  author: string | null
  sourceType: 'video' | 'article'
  text: string
} | null> {
  try {
    const res = await fetch(pageUrl, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'nl,en;q=0.8'
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok) return null
    const html = (await res.text()).slice(0, MAX_HTML_BYTES)

    const title = metaContent(html, 'og:title') ?? tagContent(html, 'title')
    const author = metaContent(html, 'author') ?? metaContent(html, 'article:author')
    const ogType = metaContent(html, 'og:type') ?? ''
    return {
      title,
      author,
      sourceType: ogType.startsWith('video') ? 'video' : 'article',
      text: htmlToText(html)
    }
  } catch {
    return null
  }
}

function metaContent(html: string, key: string): string | null {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${k}["']`, 'i')
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (m && m[1].trim()) return decodeEntities(m[1].trim())
  }
  return null
}

function tagContent(html: string, tag: string): string | null {
  const m = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
  return m ? decodeEntities(m[1].replace(/\s+/g, ' ').trim()) || null : null
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|nav|header|footer|form|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
}
```

## Controleren

1. Open de app → **Capture** → vouw **Bron analyseren (AI)** open.
2. Plak een URL (website of YouTube) → **Analyseer bron**.
3. Bewerk het voorstel, vink aan wat je wilt houden → **Bewaar N inzichten in Vangbak**.
4. Check de **Vangbak** (`/inbox`): de inzichten staan er als literatuur-notities,
   gekoppeld aan een nieuwe bron in de bibliotheek.

Let op bij YouTube: het ophalen van ondertitels is een onofficiële route en
wordt door YouTube regelmatig geblokkeerd vanaf datacenter-IP's. In dat geval
toont de app automatisch een tekstvak — plak daar het transcript (YouTube →
beschrijving → "Transcript weergeven" → kopiëren) en analyseer opnieuw. De
titel en maker worden dan alsnog automatisch ingevuld via oEmbed.
