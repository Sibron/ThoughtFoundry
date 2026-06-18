// Denkpartner: generates 4-5 sharp critical questions about a scope of notes.
// Scope can be all notes, notes with a specific tag, or notes linked to a theme.
// This function does NOT modify any notes.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { callAnthropic, estimateCost, parseJsonFromResponse } from '../_shared/anthropic.ts'
import { getUserClient, requireUserId, logUsage } from '../_shared/supabase.ts'

interface DenkpartnerRequest {
  scope: 'all' | 'tag' | 'theme'
  tag?: string
  themeId?: string
  persona?: string
  model?: 'claude-haiku-4-5' | 'claude-sonnet-4-6'
}

interface DenkpartnerResponse {
  questions: { question: string; context: string }[]
}

const SYSTEM_PROMPT = `Je bent een kritische denkpartner voor ThoughtFoundry.
Je ontvangt een selectie van de persoonlijke nota's van de gebruiker.
Jouw taak: genereer 4-5 scherpe, uitdagende vragen die de gebruiker aanmoedigen dieper na te denken.

Richtlijnen:
- Stel vragen die aannames uitdagen, niet vragen waarop de nota's al een antwoord geven.
- Zoek naar tegenstrijdigheden, blinde vlekken, of wat de gebruiker nog NIET heeft opgeschreven.
- Gebruik "Wat als...", "Waarom eigenlijk...", "Wat ontbreekt er in...", "Hoe verhoudt ... zich tot...".
- Schrijf in het Nederlands.

Antwoord ALLEEN met geldige JSON:
{
  "questions": [
    { "question": "De vraag zelf", "context": "Korte uitleg waarom deze vraag ertoe doet (1 zin)" },
    ...
  ]
}`

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')   return jsonResponse({ error: 'Method not allowed' }, 405)

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return jsonResponse({ error: 'ANTHROPIC_API_KEY not configured' }, 500)

  let body: DenkpartnerRequest
  try { body = await req.json() } catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }

  const model = body.model ?? 'claude-haiku-4-5'
  const supabase = getUserClient(req)

  let userId: string
  try { userId = await requireUserId(supabase) }
  catch { return jsonResponse({ error: 'Unauthorized' }, 401) }

  let query = supabase
    .from('notes')
    .select('id, content, ai_title, ai_summary, tags')
    .neq('status', 'archief')
    .order('created_at', { ascending: false })

  if (body.scope === 'tag' && body.tag) {
    query = query.contains('tags', [body.tag])
  } else if (body.scope === 'theme' && body.themeId) {
    // fetch note ids for this theme first
    const { data: ntData } = await supabase
      .from('note_themes')
      .select('note_id')
      .eq('theme_id', body.themeId)
    const ids = (ntData ?? []).map((r: { note_id: string }) => r.note_id)
    if (ids.length === 0) {
      return jsonResponse({ questions: [], message: 'Geen nota\'s gevonden voor dit thema.' })
    }
    query = query.in('id', ids)
  }

  const { data: notesData, error: notesErr } = await query.limit(50)
  if (notesErr) return jsonResponse({ error: notesErr.message }, 500)
  const notes = (notesData ?? []) as { id: string; content: string; ai_title: string | null; ai_summary: string | null; tags: string[] | null }[]

  if (notes.length === 0) {
    return jsonResponse({ questions: [], message: 'Geen nota\'s gevonden voor dit bereik.' })
  }

  const noteBlock = notes.map(n => {
    const title = n.ai_title ?? '(geen titel)'
    const text = n.ai_summary ?? n.content.slice(0, 250)
    return `- **${title}**: ${text}`
  }).join('\n')

  const userPrompt = `## Nota's (${notes.length} totaal)\n\n${noteBlock}\n\nGenereer 4-5 scherpe vragen die de kern van dit denken uitdagen.`

  const system = [body.persona?.trim(), SYSTEM_PROMPT].filter(Boolean).join('\n\n')

  let result
  try {
    result = await callAnthropic({
      apiKey, model,
      system,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 800
    })
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'AI call failed' }, 502)
  }

  let parsed: DenkpartnerResponse
  try {
    parsed = parseJsonFromResponse<DenkpartnerResponse>(result.text)
  } catch {
    return jsonResponse({ error: 'AI returned invalid JSON', raw: result.text }, 502)
  }

  const cost = estimateCost(model, result.inputTokens, result.outputTokens)
  await logUsage(supabase, {
    userId, model, operation: 'denkpartner',
    inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost
  })

  return jsonResponse({
    questions: (parsed.questions ?? []).slice(0, 5),
    noteCount: notes.length,
    usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost }
  })
})
