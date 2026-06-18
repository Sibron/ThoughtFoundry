// Spark: synthesize insights from the user's own notes matching a query.
// The user provides a query and output type; we score notes by keyword overlap,
// send the top matches to Claude, and return a synthesis.
// This function does NOT modify any notes.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { callAnthropic, estimateCost } from '../_shared/anthropic.ts'
import { getUserClient, requireUserId, logUsage } from '../_shared/supabase.ts'

interface SparkRequest {
  query: string
  outputType: 'reflectie' | 'coaching' | 'beslissing' | 'blogdraft' | 'gesprekskader'
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

  // Fetch all processed notes
  const { data: notesData, error: notesErr } = await supabase
    .from('notes')
    .select('id, content, ai_title, ai_summary, tags, section')
    .neq('status', 'archief')
    .order('created_at', { ascending: false })
    .limit(200)

  if (notesErr) return jsonResponse({ error: notesErr.message }, 500)
  const notes = (notesData ?? []) as {
    id: string; content: string; ai_title: string | null
    ai_summary: string | null; tags: string[] | null; section: string | null
  }[]

  // Score notes by keyword overlap with query
  const queryWords = tokenize(body.query)
  const scored = notes
    .map(n => {
      const text = [n.ai_title, n.ai_summary, n.content, ...(n.tags ?? [])].filter(Boolean).join(' ')
      const noteWords = tokenize(text)
      const overlap = [...queryWords].filter(w => noteWords.has(w)).length
      return { note: n, score: overlap }
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)

  if (scored.length === 0) {
    return jsonResponse({ synthesis: null, matchCount: 0, message: 'Geen nota\'s gevonden die passen bij deze query.' })
  }

  const noteBlock = scored.map(({ note }) => {
    const title = note.ai_title ?? '(geen titel)'
    const body = note.ai_summary ?? note.content.slice(0, 300)
    return `### ${title}\n${body}`
  }).join('\n\n')

  const instruction = OUTPUT_TYPE_INSTRUCTIONS[body.outputType] ?? OUTPUT_TYPE_INSTRUCTIONS['reflectie']

  const userPrompt = `## Query / thema\n${body.query}\n\n## Geselecteerde nota's (${scored.length})\n\n${noteBlock}\n\n## Jouw taak\n${instruction}`

  let result
  try {
    result = await callAnthropic({
      apiKey, model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 1500
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
    matchCount: scored.length,
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
