// Enrich a batch of candidate note-pairs: for each, decide keep/skip, the best
// link type, and a one-line reason — in ONE Haiku call. The pairs are pre-filtered
// (by semantic_bridges / note_neighbors), so the model never scans the corpus.
// Nothing is written here; the client persists accepted links after review.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { callAnthropic, estimateCost, parseJsonFromResponse } from '../_shared/anthropic.ts'
import { getUserClient, requireUserId, logUsage } from '../_shared/supabase.ts'

interface EnrichRequest {
  pairs: { aId: string; bId: string }[]
  persona?: string
  model?: 'claude-haiku-4-5' | 'claude-sonnet-4-6'
}

interface EnrichedLink {
  a_id: string
  b_id: string
  keep: boolean
  type: string
  reason: string
}

const VALID_TYPES = new Set(['builds_on', 'contradicts', 'example_of', 'contrasts', 'applies_to', 'related'])
const MAX_PAIRS = 40

const SYSTEM_PROMPT = `Je beoordeelt kandidaat-verbindingen tussen atomische nota's in een persoonlijk denksysteem (ThoughtFoundry).
Voor ELK aangeleverd paar bepaal je:
- keep: is de verbinding sterk en betekenisvol genoeg om te leggen? Wees streng — sla zwakke, triviale of toevallige verbanden over (keep:false).
- type: het best passende link-type uit precies deze zes:
  - builds_on   (de een bouwt voort op / verdiept de ander)
  - contradicts (ze spreken elkaar tegen)
  - example_of  (de een is een concreet voorbeeld van de ander)
  - contrasts   (ze belichten hetzelfde vanuit tegengestelde hoek)
  - applies_to  (de een past de ander toe in de praktijk)
  - related     (algemeen verwant, geen van bovenstaande past beter)
- reason: één bondige Nederlandse zin die het verband uitlegt.

Schrijf in het Nederlands. Antwoord ALLEEN met geldige JSON in dit exacte formaat:
{
  "links": [
    { "a_id": "<id>", "b_id": "<id>", "keep": true, "type": "related", "reason": "..." }
  ]
}
Geef voor elk aangeleverd paar exact één object terug, met dezelfde a_id en b_id.`

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')   return jsonResponse({ error: 'Method not allowed' }, 405)

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return jsonResponse({ error: 'ANTHROPIC_API_KEY not configured' }, 500)

  let body: EnrichRequest
  try { body = await req.json() } catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }
  const pairs = (body.pairs ?? []).slice(0, MAX_PAIRS)
  if (pairs.length === 0) return jsonResponse({ error: 'pairs required' }, 400)

  const model = body.model ?? 'claude-haiku-4-5'
  const supabase = getUserClient(req)

  let userId: string
  try { userId = await requireUserId(supabase) }
  catch { return jsonResponse({ error: 'Unauthorized' }, 401) }

  // Load the referenced notes once (RLS-scoped) and index by id.
  const ids = [...new Set(pairs.flatMap(p => [p.aId, p.bId]))]
  const { data: notesData, error: notesErr } = await supabase
    .from('notes')
    .select('id, ai_title, ai_summary, content')
    .in('id', ids)
  if (notesErr) return jsonResponse({ error: notesErr.message }, 500)

  const noteMap = new Map<string, { title: string; text: string }>()
  for (const n of (notesData ?? []) as { id: string; ai_title: string | null; ai_summary: string | null; content: string }[]) {
    noteMap.set(n.id, {
      title: n.ai_title ?? '(geen titel)',
      text: (n.ai_summary ?? n.content).slice(0, 200).replace(/\s+/g, ' ')
    })
  }

  // Only keep pairs where both notes actually exist for this user.
  const validPairs = pairs.filter(p => noteMap.has(p.aId) && noteMap.has(p.bId))
  if (validPairs.length === 0) return jsonResponse({ error: 'No valid pairs' }, 400)

  const pairBlock = validPairs.map((p, i) => {
    const a = noteMap.get(p.aId)!
    const b = noteMap.get(p.bId)!
    return `Paar ${i + 1}:
  A [${p.aId}] ${a.title}: ${a.text}
  B [${p.bId}] ${b.title}: ${b.text}`
  }).join('\n\n')

  const userPrompt = `## Kandidaat-paren (${validPairs.length})\n\n${pairBlock}\n\nGeef je beoordeling als JSON.`
  const system = [body.persona?.trim(), SYSTEM_PROMPT].filter(Boolean).join('\n\n')

  let result
  try {
    result = await callAnthropic({
      apiKey,
      model,
      system,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 1024,
      operation: 'enrich-links'
    })
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'AI call failed' }, 502)
  }

  let parsed: { links: EnrichedLink[] }
  try {
    parsed = parseJsonFromResponse<{ links: EnrichedLink[] }>(result.text)
  } catch {
    return jsonResponse({ error: 'AI returned invalid JSON', raw: result.text }, 502)
  }

  // Validate: only pairs we actually sent, clamp type to the enum, coerce keep.
  const sentKeys = new Set(validPairs.map(p => pairKey(p.aId, p.bId)))
  const seen = new Set<string>()
  const links: EnrichedLink[] = (parsed.links ?? [])
    .filter(l => l && typeof l.a_id === 'string' && typeof l.b_id === 'string')
    .map(l => ({
      a_id: l.a_id,
      b_id: l.b_id,
      keep: l.keep !== false,
      type: VALID_TYPES.has(l.type) ? l.type : 'related',
      reason: typeof l.reason === 'string' ? l.reason.slice(0, 200) : ''
    }))
    .filter(l => {
      const k = pairKey(l.a_id, l.b_id)
      if (!sentKeys.has(k) || seen.has(k)) return false
      seen.add(k)
      return true
    })

  const cost = estimateCost(model, result.inputTokens, result.outputTokens)
  await logUsage(supabase, {
    userId,
    model,
    operation: 'enrich-links',
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: cost
  })

  return jsonResponse({
    links,
    usage: {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: cost
    }
  })
})

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}
