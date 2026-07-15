// Analyze an external source (website or YouTube video) and propose insights.
// Returns a PROPOSAL (source metadata + 3-8 potential insight notes) — the
// client shows a review panel and persists the accepted ones itself (RLS),
// this function never writes notes or sources.
//
// Content retrieval is best-effort by design: YouTube regularly refuses
// caption requests from datacenter IPs, and many sites block bots. When the
// content can't be fetched the function returns { needsManualText, reason,
// meta } (HTTP 200 — not an error), so the UI can offer a paste-it-yourself
// textarea and re-call with `pastedText`.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { callAnthropic, estimateCost, parseJsonFromResponse } from '../_shared/anthropic.ts'
import { getUserClient, requireUserId, logUsage } from '../_shared/supabase.ts'
import { enforceBudget } from '../_shared/budget.ts'

interface AnalyzeRequest {
  overrideCap?: boolean
  url?: string
  pastedText?: string
  persona?: string
  model?: 'claude-haiku-4-5' | 'claude-sonnet-4-6'
  // Two-stage flow. Omitted → legacy one-shot (retrieval + insights, back-compat
  // for older clients). 'frame' → retrieval + summary + tailored angles. 'insights'
  // → generate insights from provided pastedText, steered by count + angles.
  stage?: 'frame' | 'insights'
  count?: 'auto' | 'few' | 'medium' | 'many'
  angles?: string[]
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

// The AI sees at most this many chars of source content (~5k tokens on Haiku).
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

// Stage 'frame': inkaderen vóór de gebruiker kiest welke inzichten eruit komen.
const FRAMING_SYSTEM_PROMPT = `Je bent een kennis-assistent voor een persoonlijk denksysteem (ThoughtFoundry).
De gebruiker capteert atomische ideeën over o.a. autisme/neurodiversiteit, relaties, coaching, management en persoonlijke ontwikkeling.

Jouw taak: een externe bron (artikel of videotranscript) kort inkaderen, vóórdat de gebruiker kiest welke inzichten eruit gedestilleerd worden.

Schrijf alle teksten in het Nederlands.

Antwoord ALLEEN met geldige JSON, in dit exacte formaat:
{
  "summary": "2-4 zinnen: waar gaat deze bron over",
  "angles": ["3 tot 6 concrete invalshoeken/thema's die ECHT in deze bron zitten, elk 2-5 woorden"]
}

Regels:
- "angles" zijn de mogelijke richtingen waarin de gebruiker inzichten kan laten destilleren — concreet en specifiek voor DEZE bron, geen algemene categorieën.
- Verzin geen invalshoeken die niet in de bron voorkomen.`

// Stage 'insights': destilleren, met aantal + invalshoeken uit de user-prompt.
const INSIGHTS_SYSTEM_PROMPT = `Je bent een kennis-assistent voor een persoonlijk denksysteem (ThoughtFoundry).
De gebruiker capteert atomische ideeën over o.a. autisme/neurodiversiteit, relaties, coaching, management en persoonlijke ontwikkeling.

Jouw taak: uit de inhoud van één externe bron (artikel of videotranscript) de potentiële inzichten destilleren als losse gedachte-notities.

Schrijf alle teksten in het Nederlands.

Antwoord ALLEEN met geldige JSON, in dit exacte formaat:
{
  "insights": [
    {
      "content": "een zelfstandige, atomaire gedachte-notitie van 1-4 zinnen",
      "core_idea": "de kern in één zin",
      "tags": ["max 5 tags, lowercase, single-word of-met-streepje"]
    }
  ]
}

Regels voor de insights:
- Elk inzicht is een ZELFSTANDIGE gedachte-notitie: een idee, claim of vraag die op zichzelf leesbaar is zonder de bron erbij. Geen citaten, geen samenvattingspuntjes, geen "de video zegt dat...".
- Formuleer in de stijl van een eigen notitie: direct, inhoudelijk, prikkelend.
- "core_idea" is één zin die de kern vangt.
- Liever minder sterke inzichten dan zwakke opvulling.`

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

  // ---- Gather content + metadata -------------------------------------------
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
      // 1) Free scrape (works occasionally, costs nothing). 2) Supadata, if a
      // SUPADATA_API_KEY secret is set — reliable from datacenter IPs and even
      // transcribes caption-less videos via Whisper. 3) Manual paste.
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
    // No URL — pure pasted text; Claude decides the source_type.
    content = pastedText
    retrieval = 'pasted'
    meta = { ...meta, source_type: 'article' }
  }

  content = content.slice(0, CONTENT_CHAR_BUDGET)

  // ---- AI analysis ----------------------------------------------------------
  const stage = body.stage // undefined = legacy one-shot, else 'frame' | 'insights'

  const system = [
    body.persona?.trim(),
    stage === 'frame' ? FRAMING_SYSTEM_PROMPT
      : stage === 'insights' ? INSIGHTS_SYSTEM_PROMPT
      : SYSTEM_PROMPT
  ].filter(Boolean).join('\n\n')

  const userPrompt = stage === 'frame' ? buildFramingPrompt(meta, content, retrieval)
    : stage === 'insights' ? buildInsightsPrompt(meta, content, retrieval, body.count, body.angles)
    : buildUserPrompt(meta, content, retrieval)

  let result
  try {
    result = await callAnthropic({
      apiKey,
      model,
      system,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: stage === 'frame' ? 700 : 2500,
      operation: stage === 'frame' ? 'analyze-source-frame'
        : stage === 'insights' ? 'analyze-source-insights'
        : 'analyze-source'
    })
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'AI call failed' }, 502)
  }

  const cost = estimateCost(model, result.inputTokens, result.outputTokens)
  const usage = { inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost }
  await logUsage(supabase, {
    userId,
    model,
    operation: stage === 'frame' ? 'analyze-source-frame'
      : stage === 'insights' ? 'analyze-source-insights'
      : 'analyze-source',
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: cost
  })

  // ---- Stage 'frame': summary + tailored angles ----------------------------
  if (stage === 'frame') {
    let framing: { summary: string; angles: string[] }
    try {
      const parsed = parseJsonFromResponse<{ summary?: unknown; angles?: unknown }>(result.text)
      framing = {
        summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
        angles: (Array.isArray(parsed.angles) ? parsed.angles : [])
          .filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
          .map(a => a.trim())
          .slice(0, 6)
      }
    } catch {
      return jsonResponse({ error: 'AI returned invalid JSON', raw: result.text }, 502)
    }
    return jsonResponse({
      meta: { title: meta.title, author: meta.author, url: meta.url, source_type: meta.source_type },
      content,
      retrieval,
      framing,
      contentChars: content.length,
      usage
    })
  }

  // ---- Stage 'insights': variable-count list, steered by angles -------------
  if (stage === 'insights') {
    let insights: { content: string; core_idea?: string; tags: string[] }[]
    try {
      const parsed = parseJsonFromResponse<{ insights?: unknown }>(result.text)
      insights = sanitizeInsights(parsed.insights)
    } catch {
      return jsonResponse({ error: 'AI returned invalid JSON', raw: result.text }, 502)
    }
    return jsonResponse({ insights, retrieval, contentChars: content.length, usage })
  }

  // ---- Legacy one-shot (no stage): full proposal ---------------------------
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
  proposal.insights = sanitizeInsights(proposal.insights).slice(0, 8)

  return jsonResponse({ proposal, retrieval, contentChars: content.length, usage })
})

// Normalize a raw model `insights` array: drop empties, trim, lowercase tags
// (max 5), cap the list at 15 so "Veel"/"Auto" aren't clipped.
function sanitizeInsights(raw: unknown): { content: string; core_idea?: string; tags: string[] }[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((i): i is { content: string; core_idea?: unknown; tags?: unknown } =>
      !!i && typeof i === 'object' && typeof (i as { content?: unknown }).content === 'string' &&
      (i as { content: string }).content.trim().length > 0)
    .slice(0, 15)
    .map(i => ({
      content: (i.content as string).trim(),
      core_idea: typeof i.core_idea === 'string' ? i.core_idea.trim() : undefined,
      tags: (Array.isArray(i.tags) ? i.tags : [])
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .map(t => t.trim().toLowerCase())
        .slice(0, 5)
    }))
}

function buildUserPrompt(meta: SourceMeta, content: string, retrieval: string): string {
  const kindLabel = retrieval === 'captions' ? 'videotranscript (automatische ondertitels — kan spreektaal en fouten bevatten)'
    : retrieval === 'html' ? 'tekst van een webpagina (kan restjes navigatie bevatten)'
    : 'door de gebruiker geplakte tekst'

  const metaLines = [
    meta.url ? `URL: ${meta.url}` : null,
    meta.title ? `Titel: ${meta.title}` : null,
    meta.author ? `Auteur/maker: ${meta.author}` : null
  ].filter(Boolean).join('\n')

  return `## Bron

${metaLines || '(geen metadata bekend)'}

Inhoud (${kindLabel}):

${content}

Analyseer deze bron en geef je voorstel als JSON.`
}

function sourceBlock(meta: SourceMeta, content: string, retrieval: string): string {
  const kindLabel = retrieval === 'captions' || retrieval === 'supadata'
    ? 'videotranscript (automatische ondertitels — kan spreektaal en fouten bevatten)'
    : retrieval === 'html' ? 'tekst van een webpagina (kan restjes navigatie bevatten)'
    : 'door de gebruiker geplakte tekst'
  const metaLines = [
    meta.url ? `URL: ${meta.url}` : null,
    meta.title ? `Titel: ${meta.title}` : null,
    meta.author ? `Auteur/maker: ${meta.author}` : null
  ].filter(Boolean).join('\n')
  return `## Bron\n\n${metaLines || '(geen metadata bekend)'}\n\nInhoud (${kindLabel}):\n\n${content}`
}

function buildFramingPrompt(meta: SourceMeta, content: string, retrieval: string): string {
  return `${sourceBlock(meta, content, retrieval)}

Vat de bron samen en geef de mogelijke invalshoeken als JSON.`
}

function buildInsightsPrompt(
  meta: SourceMeta,
  content: string,
  retrieval: string,
  count: AnalyzeRequest['count'],
  angles: string[] | undefined
): string {
  const countInstr = count === 'few' ? 'Geef 2 tot 3 inzichten: alleen de allersterkste.'
    : count === 'medium' ? 'Geef 4 tot 6 inzichten.'
    : count === 'many' ? 'Geef 7 tot 10 inzichten.'
    : 'Geef zoveel inzichten als de bron rechtvaardigt: soms 2, soms 12 of meer. Forceer geen vast aantal — laat de rijkdom van de bron het aantal bepalen.'

  const clean = (Array.isArray(angles) ? angles : [])
    .filter(a => typeof a === 'string' && a.trim().length > 0)
    .map(a => a.trim())
  const angleInstr = clean.length > 0
    ? `Richt de inzichten specifiek op deze invalshoeken: ${clean.join('; ')}. Negeer wat daarbuiten valt.`
    : 'Kies zelf de sterkste invalshoeken uit de bron.'

  return `${sourceBlock(meta, content, retrieval)}

${countInstr}
${angleInstr}

Geef je inzichten als JSON.`
}

// ---- URL handling -----------------------------------------------------------

// Cheap SSRF guard: this function is an authenticated fetch proxy, so refuse
// obviously internal targets. Not a full defense (no DNS resolution), but the
// edge runtime has no privileged internal network to speak of.
function isSafeUrl(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false
  // IPv6 literal
  if (host.startsWith('[') || host.includes(':')) return false
  // IPv4 literal in a private/reserved range
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

// ---- YouTube retrieval --------------------------------------------------------

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

// Optional paid fallback: Supadata resolves transcripts from a residential
// network (YouTube blocks datacenter IPs like Supabase's) and falls back to
// Whisper for caption-less videos. No-ops to null when SUPADATA_API_KEY is
// unset, so the function keeps working (manual-paste) without it.
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
    // With text=true `content` is a plain string; keep the segmented shape as a
    // fallback in case the flag is ignored.
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

// Unofficial caption scrape — every step degrades to null (→ needsManualText).
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

    // Prefer json3 (structured); fall back to the default XML format.
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
  // Language preference nl → en → first; human captions beat auto-generated (asr).
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

// Extract the JSON array that follows a marker like `"captionTracks":` using a
// bracket scanner that respects strings/escapes — regex alone breaks on nested
// brackets inside caption names.
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

// ---- Website retrieval --------------------------------------------------------

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

// <meta property="og:title" content="..."> / <meta name="author" content="...">
// — attribute order varies per site, so match both orders.
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
