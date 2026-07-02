// Spark: synthesize insights from the user's own notes matching a query.
// The user provides a query and output type; we retrieve the best-matching
// notes BY MEANING (gte-small embedding of the query + the match_notes
// pgvector RPC, zero cost), send them to Claude, and return a synthesis.
// Falls back to lexical keyword overlap when the corpus has no embeddings.
// This function does NOT modify any notes.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { callAnthropic, estimateCost } from '../_shared/anthropic.ts'
import { getUserClient, requireUserId, logUsage } from '../_shared/supabase.ts'
import { enforceBudget } from '../_shared/budget.ts'

// Supabase.ai is provided by the edge runtime and isn't part of Deno's types.
// deno-lint-ignore no-explicit-any
declare const Supabase: any

// Module scope — see embed-note/index.ts for why (HTTP 546 otherwise).
const embedSession = new Supabase.ai.Session('gte-small')

interface SparkRequest {
  overrideCap?: boolean
  query: string
  outputType: 'reflectie' | 'coaching' | 'beslissing' | 'blogdraft' | 'gesprekskader'
  persona?: string
  model?: 'claude-haiku-4-5' | 'claude-sonnet-4-6'
}

const OUTPUT_TYPE_INSTRUCTIONS: Record<string, string> = {
  reflectie:     'Schrijf een persoonlijke reflectie (1e persoon, inzichtelijk, 3-4 alinea\'s).',
  coaching:      'Schrijf coachingvragen en inzichten geschikt voor een coachingsgesprek (2-3 kernvragen + toelichting).',
  beslissing:    'Syntheseer de afwegingen en maak de kernspanning zichtbaar die bij de beslissing hoort (pro/contra + aanbeveling).',
  blogdraft:     'Schrijf een ruwe blogpost-draft (inleiding, 2-3 punten, afsluiting, informele maar heldere toon).',
  gesprekskader: 'Maak een gespreksframework (korte intro + 4-5 gespreksthema\'s met één uitlegzin elk).',
}

const SYSTEM_PROMPT = `Je bent een kennisassistent voor ThoughtFoundry.
Je ontvangt een selectie van de persoonlijke nota's van de gebruiker en een query/thema.
Jouw taak: een gerichte synthese schrijven op basis van ALLEEN de aangeleverde nota's.
Verzin geen informatie die niet in de nota's staat.
Schrijf in het Nederlands.
Geef een gestructureerde output zoals gevraagd.`

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')   return jsonResponse({ error: 'Method not allowed' }, 405)

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return jsonResponse({ error: 'ANTHROPIC_API_KEY not configured' }, 500)

  let body: SparkRequest
  try { body = await req.json() } catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }
  if (!body.query?.trim()) return jsonResponse({ error: 'query required' }, 400)
  if (!body.outputType)    return jsonResponse({ error: 'outputType required' }, 400)

  const model = body.model ?? 'claude-sonnet-4-6'
  const supabase = getUserClient(req)

  try { await requireUserId(supabase) }
  catch { return jsonResponse({ error: 'Unauthorized' }, 401) }

  // Monthly budget cap — real since M1. 402 + {spend, cap} unless the
  // client explicitly confirmed the overrun (overrideCap: true).
  const blocked = await enforceBudget(supabase, body)
  if (blocked) return blocked

  type NoteRow = {
    id: string; content: string; ai_title: string | null
    ai_summary: string | null; tags: string[] | null; section: string | null
  }

  // ── Retrieval: by meaning first, by words as fallback ──────────────────────
  let matched: NoteRow[] = []
  let retrieval: 'semantisch' | 'lexicaal' = 'lexicaal'

  try {
    const qEmbedding = await embedSession.run(body.query, { mean_pool: true, normalize: true }) as number[]
    const { data: knn, error: knnErr } = await supabase.rpc('match_notes', {
      query_embedding: qEmbedding,
      match_count: 20
    })
    const hits = ((knn ?? []) as { id: string; similarity: number }[])
      .filter(h => h.similarity >= 0.5)
    if (!knnErr && hits.length > 0) {
      const { data: rows, error: rowsErr } = await supabase
        .from('notes')
        .select('id, content, ai_title, ai_summary, tags, section')
        .in('id', hits.map(h => h.id))
        .neq('status', 'archief')
      if (!rowsErr && rows?.length) {
        // Preserve the KNN similarity order.
        const order = new Map(hits.map((h, i) => [h.id, i]))
        matched = (rows as NoteRow[]).sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99))
        retrieval = 'semantisch'
      }
    }
  } catch { /* no embeddings yet or model hiccup — fall back to lexical */ }

  if (matched.length === 0) {
    const { data: notesData, error: notesErr } = await supabase
      .from('notes')
      .select('id, content, ai_title, ai_summary, tags, section')
      .neq('status', 'archief')
      .order('created_at', { ascending: false })
      .limit(200)

    if (notesErr) return jsonResponse({ error: notesErr.message }, 500)
    const notes = (notesData ?? []) as NoteRow[]

    const queryWords = tokenize(body.query)
    matched = notes
      .map(n => {
        const text = [n.ai_title, n.ai_summary, n.content, ...(n.tags ?? [])].filter(Boolean).join(' ')
        const noteWords = tokenize(text)
        const overlap = [...queryWords].filter(w => noteWords.has(w)).length
        return { note: n, score: overlap }
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map(x => x.note)
    retrieval = 'lexicaal'
  }

  if (matched.length === 0) {
    return jsonResponse({ synthesis: null, matchCount: 0, retrieval, message: 'Geen nota\'s gevonden die passen bij deze query.' })
  }

  const noteBlock = matched.map(note => {
    const title = note.ai_title ?? '(geen titel)'
    const body = note.ai_summary ?? note.content.slice(0, 300)
    return `### ${title}\n${body}`
  }).join('\n\n')

  const instruction = OUTPUT_TYPE_INSTRUCTIONS[body.outputType] ?? OUTPUT_TYPE_INSTRUCTIONS['reflectie']

  const userPrompt = `## Query / thema\n${body.query}\n\n## Geselecteerde nota's (${matched.length})\n\n${noteBlock}\n\n## Jouw taak\n${instruction}`

  const system = [body.persona?.trim(), SYSTEM_PROMPT].filter(Boolean).join('\n\n')

  let result
  try {
    result = await callAnthropic({
      apiKey, model,
      system,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 1500,
      operation: 'spark'
    })
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'AI call failed' }, 502)
  }

  const cost = estimateCost(model, result.inputTokens, result.outputTokens)
  const userId = (await supabase.auth.getUser()).data.user?.id ?? ''
  await logUsage(supabase, {
    userId, model, operation: 'spark',
    inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost
  })

  return jsonResponse({
    synthesis: result.text,
    matchCount: matched.length,
    retrieval,
    usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost }
  })
})

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9À-ɏ\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3)
  )
}
