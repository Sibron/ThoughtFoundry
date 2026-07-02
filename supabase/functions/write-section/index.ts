// Write-section: AI writing assists for the schrijfstudio. Four modes over
// one section — draft (write it from its attached notes), rewrite / tighten
// (a selection or the whole text), continue (pick up where the prose stops).
// Grounded strictly in the supplied notes: the model must mark claims it
// cannot support with [check]. Returns plain markdown prose — the client
// shows it as a PROPOSAL; nothing is persisted here.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { callAnthropic, estimateCost, type AnthropicModel } from '../_shared/anthropic.ts'
import { getUserClient, requireUserId, logUsage } from '../_shared/supabase.ts'
import { enforceBudget } from '../_shared/budget.ts'

interface WriteSectionRequest {
  overrideCap?: boolean
  sectionId?: string
  // Inline alternative to sectionId (e.g. unsaved sections):
  heading?: string
  intent?: string
  noteIds?: string[]
  mode: 'draft' | 'rewrite' | 'tighten' | 'continue'
  /** Selected fragment for rewrite/tighten; falls back to the whole text. */
  selection?: string
  /** Current prose of the section (context; required for continue). */
  currentText?: string
  /** Optional user steer ("meer voorbeelden", "zakelijker", …). */
  instruction?: string
  persona?: string
  model?: 'claude-haiku-4-5' | 'claude-sonnet-4-6'
}

const BASE_SYSTEM = `Je bent een Nederlandstalige redacteur/schrijfpartner voor een non-fictie boek.
Grondregels:
- Baseer inhoudelijke beweringen UITSLUITEND op de meegeleverde nota's van de auteur.
- Kun je iets niet onderbouwen vanuit de nota's, markeer het dan inline met [check].
- Schrijf in de je-vorm alleen als de nota's dat ook doen; volg de toon van de auteur.
- Lever ALLEEN de gevraagde tekst als platte markdown-proza. Geen JSON, geen preambule, geen nabeschouwing, geen kop tenzij gevraagd.`

const MODE_INSTRUCTIONS: Record<WriteSectionRequest['mode'], string> = {
  draft:    'Schrijf deze sectie volledig uit als vloeiend proza (3-6 alinea\'s), op basis van de nota\'s. Verweef de ideeën tot één lopende tekst — geen opsomming van losse nota\'s.',
  rewrite:  'Herschrijf de aangeleverde passage. Behoud de betekenis en de feiten; verbeter structuur, ritme en helderheid.',
  tighten:  'Maak de aangeleverde passage strakker: schrap herhaling en vulwoorden, behoud alle inhoudelijke punten. Streef naar ±30% korter.',
  continue: 'Schrijf verder waar de huidige tekst stopt (1-3 alinea\'s), in dezelfde stijl, richting de intentie van de sectie.',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')   return jsonResponse({ error: 'Method not allowed' }, 405)

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return jsonResponse({ error: 'ANTHROPIC_API_KEY not configured' }, 500)

  let body: WriteSectionRequest
  try { body = await req.json() } catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }
  if (!body.mode || !(body.mode in MODE_INSTRUCTIONS)) return jsonResponse({ error: 'mode required' }, 400)

  const model: AnthropicModel = body.model ?? 'claude-sonnet-4-6'
  const supabase = getUserClient(req)

  let userId: string
  try { userId = await requireUserId(supabase) }
  catch { return jsonResponse({ error: 'Unauthorized' }, 401) }

  // Monthly budget cap — real since M1. 402 + {spend, cap} unless the
  // client explicitly confirmed the overrun (overrideCap: true).
  const blocked = await enforceBudget(supabase, body)
  if (blocked) return blocked

  // ── Resolve the section (row or inline) ────────────────────────────────────
  let heading = body.heading ?? ''
  let intent = body.intent ?? ''
  let noteIds = body.noteIds ?? []
  let chapterTitle = ''

  if (body.sectionId) {
    const { data: section, error: secErr } = await supabase
      .from('chapter_sections')
      .select('heading, intent, note_ids, chapter_id')
      .eq('id', body.sectionId)
      .maybeSingle()
    if (secErr) return jsonResponse({ error: secErr.message }, 500)
    if (!section) return jsonResponse({ error: 'Sectie niet gevonden' }, 404)
    heading = section.heading ?? heading
    intent = section.intent ?? intent
    noteIds = (section.note_ids ?? []) as string[]
    const { data: chapter } = await supabase
      .from('chapters').select('title').eq('id', section.chapter_id).maybeSingle()
    chapterTitle = chapter?.title ?? ''
  }

  const passage = (body.selection?.trim() || body.currentText?.trim() || '')
  if ((body.mode === 'rewrite' || body.mode === 'tighten') && !passage) {
    return jsonResponse({ error: 'Geen tekst om te herschrijven' }, 400)
  }
  if (body.mode === 'continue' && !body.currentText?.trim()) {
    return jsonResponse({ error: 'Geen tekst om op verder te schrijven' }, 400)
  }
  if (body.mode === 'draft' && noteIds.length === 0) {
    return jsonResponse({ error: 'Koppel eerst nota\'s aan deze sectie' }, 400)
  }

  // ── Notes context ───────────────────────────────────────────────────────────
  let notesBlock = '_(geen nota\'s gekoppeld)_'
  if (noteIds.length > 0) {
    const { data: notes, error: notesErr } = await supabase
      .from('notes')
      .select('id, content, mini_notes, ai_title, ai_summary')
      .in('id', noteIds)
    if (notesErr) return jsonResponse({ error: notesErr.message }, 500)
    notesBlock = ((notes ?? []) as { content: string; mini_notes: string | null; ai_title: string | null; ai_summary: string | null }[])
      .map((n, i) => {
        const title = n.ai_title ?? `Nota ${i + 1}`
        const extra = n.mini_notes ? `\n> ${n.mini_notes}` : ''
        return `### ${title}\n${n.content}${extra}`
      })
      .join('\n\n')
  }

  // ── Prompt ──────────────────────────────────────────────────────────────────
  const contextLines = [
    chapterTitle ? `**Hoofdstuk:** ${chapterTitle}` : null,
    heading ? `**Sectie:** ${heading}` : null,
    intent ? `**Intentie van de sectie:** ${intent}` : null,
  ].filter(Boolean).join('\n')

  const parts: string[] = [
    `## Context\n\n${contextLines || '_(geen)_'}`,
    `## Nota's van de auteur (${noteIds.length})\n\n${notesBlock}`,
  ]
  if (body.mode === 'continue' && body.currentText?.trim()) {
    parts.push(`## Huidige tekst van de sectie\n\n${body.currentText.trim()}`)
  }
  if ((body.mode === 'rewrite' || body.mode === 'tighten')) {
    parts.push(`## Te bewerken passage\n\n${passage}`)
    if (body.selection?.trim() && body.currentText?.trim() && body.selection.trim() !== body.currentText.trim()) {
      parts.push(`## Omliggende tekst (alleen context, niet herschrijven)\n\n${body.currentText.trim().slice(0, 3000)}`)
    }
  }
  parts.push(`## Jouw taak\n\n${MODE_INSTRUCTIONS[body.mode]}${body.instruction?.trim() ? `\n\nExtra aanwijzing van de auteur: ${body.instruction.trim()}` : ''}`)

  const system = [body.persona?.trim(), BASE_SYSTEM].filter(Boolean).join('\n\n')

  let result
  try {
    result = await callAnthropic({
      apiKey, model, system,
      messages: [{ role: 'user', content: parts.join('\n\n') }],
      maxTokens: 2500,
      operation: 'write-section'
    })
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'AI call failed' }, 502)
  }

  const cost = estimateCost(model, result.inputTokens, result.outputTokens)
  await logUsage(supabase, {
    userId, model, operation: 'write-section',
    inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost
  })

  return jsonResponse({
    text: result.text.trim(),
    usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost }
  })
})
