// Phase 4: cluster a set of notes into a chapter outline.
// Input: theme_id (optional) + array of note ids → Anthropic returns title, summary, sections.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { callAnthropic, estimateCost, parseJsonFromResponse } from '../_shared/anthropic.ts'
import { getUserClient, requireUserId, logUsage } from '../_shared/supabase.ts'

interface ChapterRequest {
  themeId?: string
  noteIds: string[]
  angle?: string // optional steering text from the user
  model?: 'claude-sonnet-4-6' | 'claude-haiku-4-5' | 'claude-opus-4-7'
}

interface NoteRow {
  id: string
  content: string
  mini_notes: string | null
  ai_title: string | null
  ai_summary: string | null
  tags: string[] | null
  types: string[] | null
}

interface ChapterPlan {
  title: string
  summary: string
  sections: { heading: string; intent: string; note_ids: string[] }[]
}

const SYSTEM_PROMPT = `Je bent een redacteur die ruwe nota's samenbrengt tot een hoofdstukschets voor een informatief boek.

Schrijf in het Nederlands. Antwoord ALLEEN met JSON:
{
  "title": "korte hoofdstuktitel",
  "summary": "2-3 zinnen kerngedachte van het hoofdstuk",
  "sections": [
    {
      "heading": "sectie-titel",
      "intent": "wat deze sectie wil zeggen",
      "note_ids": ["uuid", ...]
    }
  ]
}

Regels:
- Maximaal 5 secties.
- Elke note_id mag in maximaal één sectie voorkomen.
- Sluit nota's uit die er niet bij passen (laat ze gewoon weg).
- Maak de structuur logisch: opbouw van algemeen naar specifiek of van probleem naar oplossing.`

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')   return jsonResponse({ error: 'Method not allowed' }, 405)

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return jsonResponse({ error: 'ANTHROPIC_API_KEY not configured' }, 500)

  let body: ChapterRequest
  try { body = await req.json() } catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }
  if (!Array.isArray(body.noteIds) || body.noteIds.length === 0) {
    return jsonResponse({ error: 'noteIds (non-empty array) required' }, 400)
  }

  const model = body.model ?? 'claude-sonnet-4-6'
  const supabase = getUserClient(req)

  let userId: string
  try { userId = await requireUserId(supabase) }
  catch { return jsonResponse({ error: 'Unauthorized' }, 401) }

  const { data: notesData, error: notesErr } = await supabase
    .from('notes')
    .select('id, content, mini_notes, ai_title, ai_summary, tags, types')
    .in('id', body.noteIds)

  if (notesErr) return jsonResponse({ error: notesErr.message }, 500)
  const notes = (notesData ?? []) as NoteRow[]
  if (notes.length === 0) return jsonResponse({ error: 'No notes found' }, 404)

  let themeName: string | null = null
  if (body.themeId) {
    const { data: theme } = await supabase.from('themes').select('name').eq('id', body.themeId).single()
    themeName = theme?.name ?? null
  }

  const userPrompt = buildPrompt(notes, themeName, body.angle)

  let result
  try {
    result = await callAnthropic({
      apiKey, model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 2048
    })
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'AI call failed' }, 502)
  }

  let plan: ChapterPlan
  try { plan = parseJsonFromResponse<ChapterPlan>(result.text) }
  catch { return jsonResponse({ error: 'AI returned invalid JSON', raw: result.text }, 502) }

  // Strip hallucinated note ids
  const validIds = new Set(notes.map(n => n.id))
  plan.sections = (plan.sections ?? [])
    .map(s => ({ ...s, note_ids: (s.note_ids ?? []).filter(id => validIds.has(id)) }))
    .filter(s => s.note_ids.length > 0)
    .slice(0, 5)

  const cost = estimateCost(model, result.inputTokens, result.outputTokens)
  await logUsage(supabase, {
    userId, model,
    operation: 'generate-chapter',
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: cost
  })

  return jsonResponse({
    plan,
    usage: {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: cost
    }
  })
})

function buildPrompt(notes: NoteRow[], themeName: string | null, angle: string | undefined): string {
  const noteText = notes.map(n => {
    const head = n.ai_title ? n.ai_title : n.content.slice(0, 60)
    const body = n.ai_summary ?? n.content
    const tags = (n.tags ?? []).join(', ')
    return `### [${n.id}] ${head}\n${body}${tags ? `\nTags: ${tags}` : ''}`
  }).join('\n\n')

  const themeLine = themeName ? `Thema: **${themeName}**` : 'Thema: (geen)'
  const angleLine = angle ? `Invalshoek van de gebruiker: ${angle}` : ''

  return `${themeLine}
${angleLine}

## Nota's

${noteText}

Geef het hoofdstukplan als JSON.`
}
