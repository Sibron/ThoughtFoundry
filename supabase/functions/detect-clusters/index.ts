// Detect-clusters: identifies 2-4 implicit thematic clusters across processed notes.
// Shows which notes belong, what the implicit theme is, and what permanent note is missing.
// This function does NOT modify any notes.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { callAnthropic, estimateCost, parseJsonFromResponse } from '../_shared/anthropic.ts'
import { getUserClient, requireUserId, logUsage } from '../_shared/supabase.ts'

interface Cluster {
  name: string
  implicit_theme: string
  missing_note: string
  note_ids: string[]
}

interface ClustersResponse {
  clusters: Cluster[]
}

const SYSTEM_PROMPT = `Je bent een kennisarchitect voor ThoughtFoundry.
Je ontvangt een overzicht van de verwerkte nota's van de gebruiker.
Jouw taak: identificeer 2-4 impliciete thematische clusters — patronen die de gebruiker zelf nog niet bewust als thema heeft gelabeld.

Per cluster:
- "name": een korte naam voor het cluster (max 40 chars)
- "implicit_theme": wat de diepere samenhang is (1 zin)
- "missing_note": welke permanente nota ontbreekt om dit cluster compleet te maken (1 zin als aanbeveling)
- "note_ids": de UUIDs van de nota's die bij dit cluster horen

Richtlijnen:
- Zoek naar niet-voor-de-hand-liggende verbanden die de bestaande thema's overstijgen.
- Wees specifiek over welke nota's erbij horen.
- Schrijf in het Nederlands.

Antwoord ALLEEN met geldige JSON:
{
  "clusters": [
    {
      "name": "...",
      "implicit_theme": "...",
      "missing_note": "...",
      "note_ids": ["uuid", ...]
    }
  ]
}`

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')   return jsonResponse({ error: 'Method not allowed' }, 405)

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return jsonResponse({ error: 'ANTHROPIC_API_KEY not configured' }, 500)

  let body: { persona?: string } = {}
  try { body = await req.json() } catch { /* body is optional */ }

  const model = 'claude-sonnet-4-6'
  const supabase = getUserClient(req)

  let userId: string
  try { userId = await requireUserId(supabase) }
  catch { return jsonResponse({ error: 'Unauthorized' }, 401) }

  const { data: notesData, error: notesErr } = await supabase
    .from('notes')
    .select('id, content, ai_title, ai_summary, tags, section')
    .eq('status', 'verwerkt')
    .order('created_at', { ascending: false })
    .limit(100)

  if (notesErr) return jsonResponse({ error: notesErr.message }, 500)
  const notes = (notesData ?? []) as {
    id: string; content: string; ai_title: string | null
    ai_summary: string | null; tags: string[] | null; section: string | null
  }[]

  if (notes.length < 5) {
    return jsonResponse({
      clusters: [],
      message: 'Te weinig verwerkte nota\'s voor clusteranalyse. Verwerk er minimaal 5.'
    })
  }

  const noteBlock = notes.map(n => {
    const title = n.ai_title ?? '(geen titel)'
    const text = n.ai_summary ?? n.content.slice(0, 200)
    const tags = (n.tags ?? []).join(', ')
    return `[${n.id}] **${title}**${tags ? ` (${tags})` : ''}: ${text}`
  }).join('\n')

  const userPrompt = `## Verwerkte nota's (${notes.length})\n\n${noteBlock}\n\nIdentificeer 2-4 impliciete clusters.`

  const system = [body.persona?.trim(), SYSTEM_PROMPT].filter(Boolean).join('\n\n')

  let result
  try {
    result = await callAnthropic({
      apiKey, model,
      system,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 1200,
      operation: 'detect-clusters'
    })
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'AI call failed' }, 502)
  }

  let parsed: ClustersResponse
  try {
    parsed = parseJsonFromResponse<ClustersResponse>(result.text)
  } catch {
    return jsonResponse({ error: 'AI returned invalid JSON', raw: result.text }, 502)
  }

  // Validate note_ids — strip any hallucinated UUIDs
  const validIds = new Set(notes.map(n => n.id))
  const clusters = (parsed.clusters ?? []).slice(0, 4).map(c => ({
    ...c,
    note_ids: (c.note_ids ?? []).filter(id => validIds.has(id))
  }))

  const cost = estimateCost(model, result.inputTokens, result.outputTokens)
  await logUsage(supabase, {
    userId, model, operation: 'detect-clusters',
    inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost
  })

  return jsonResponse({
    clusters,
    noteCount: notes.length,
    usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost }
  })
})
