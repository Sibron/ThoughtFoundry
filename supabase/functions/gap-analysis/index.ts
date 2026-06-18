// Gap-analyse: identify white spots, missing counter-arguments, unelaborated questions
// and corpus risks for a given book project.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { callAnthropic, estimateCost } from '../_shared/anthropic.ts'
import { getUserClient, requireUserId, logUsage } from '../_shared/supabase.ts'

interface GapRequest {
  projectId: string
  persona?: string
  model?: 'claude-haiku-4-5' | 'claude-sonnet-4-6'
}

const BASE_SYSTEM = `Je bent een kritische gap-analist voor een kennisproject.
Je ontvangt de kernvraag en beschrijving van een boekproject plus alle bijbehorende nota's.
Jouw taak: identificeer wat er ontbreekt, wat onvolledig is, en waar risico's zitten.
Wees concreet en specifiek. Verwijs waar relevant naar de nota's.
Schrijf in het Nederlands.`

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')   return jsonResponse({ error: 'Method not allowed' }, 405)

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return jsonResponse({ error: 'ANTHROPIC_API_KEY not configured' }, 500)

  let body: GapRequest
  try { body = await req.json() } catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }
  if (!body.projectId?.trim()) return jsonResponse({ error: 'projectId required' }, 400)

  const model = body.model ?? 'claude-sonnet-4-6'
  const supabase = getUserClient(req)

  let userId: string
  try { userId = await requireUserId(supabase) }
  catch { return jsonResponse({ error: 'Unauthorized' }, 401) }

  // Load project
  const { data: project, error: projErr } = await supabase
    .from('book_projects')
    .select('id, title, core_question, description, status')
    .eq('id', body.projectId)
    .maybeSingle()

  if (projErr) return jsonResponse({ error: projErr.message }, 500)
  if (!project) return jsonResponse({ error: 'Project niet gevonden' }, 404)

  // Load note IDs for this project
  const { data: links, error: linksErr } = await supabase
    .from('note_book_projects')
    .select('note_id')
    .eq('project_id', body.projectId)

  if (linksErr) return jsonResponse({ error: linksErr.message }, 500)
  const noteIds = (links ?? []).map((l: { note_id: string }) => l.note_id)

  // Load the actual notes
  let notes: { id: string; content: string; ai_title: string | null; note_type: string; core_idea: string | null }[] = []
  if (noteIds.length > 0) {
    const { data: notesData, error: notesErr } = await supabase
      .from('notes')
      .select('id, content, ai_title, note_type, core_idea')
      .in('id', noteIds)

    if (notesErr) return jsonResponse({ error: notesErr.message }, 500)
    notes = (notesData ?? []) as typeof notes
  }

  // Build prompt
  const projectBlock = [
    `**Titel:** ${project.title}`,
    `**Kernvraag:** ${project.core_question}`,
    project.description ? `**Beschrijving:** ${project.description}` : null,
    `**Status:** ${project.status}`,
  ].filter(Boolean).join('\n')

  const notesBlock = notes.length === 0
    ? '_(geen nota\'s gekoppeld aan dit project)_'
    : notes.map((n, i) => {
        const title = n.ai_title ?? n.core_idea ?? `Nota ${i + 1}`
        const body = n.core_idea ?? n.content.slice(0, 400)
        return `### ${i + 1}. ${title} [${n.note_type}]\n${body}`
      }).join('\n\n')

  const userPrompt = `## Project\n\n${projectBlock}\n\n## Nota's in dit project (${notes.length})\n\n${notesBlock}\n\n## Jouw analyse\n\nGeef een gestructureerde gap-analyse met de volgende vier secties:\n\n## WITTE PLEKKEN\nWelke thema's, perspectieven of aspecten van de kernvraag ontbreken volledig in het huidige corpus?\n\n## ONTBREKENDE TEGENARGUMENTEN\nWelke tegenwerpingen, kritiek of afwijkende standpunten zijn niet vertegenwoordigd?\n\n## ONUITGEWERKTE VRAGEN\nWelke vragen of deelthema's zijn aangeraakt maar niet uitgewerkt?\n\n## RISICO VAN HET HUIDIGE CORPUS\nWelke aannames, blinde vlekken of structurele zwakheden zitten er in het huidige corpus als geheel?`

  const system = [body.persona?.trim(), BASE_SYSTEM].filter(Boolean).join('\n\n')

  let result
  try {
    result = await callAnthropic({
      apiKey, model,
      system,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 2000
    })
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'AI call failed' }, 502)
  }

  const cost = estimateCost(model, result.inputTokens, result.outputTokens)
  await logUsage(supabase, {
    userId, model, operation: 'gap-analysis',
    inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost
  })

  return jsonResponse({
    analysis: result.text,
    usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost }
  })
})
