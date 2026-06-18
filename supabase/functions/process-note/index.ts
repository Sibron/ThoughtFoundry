// Phase 2: process a single note.
// Returns AI-suggested title, summary, tags, theme matches, and similar notes.
// The user accepts/edits each field client-side; the function does NOT mutate the note.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { callAnthropic, estimateCost, parseJsonFromResponse } from '../_shared/anthropic.ts'
import { getUserClient, requireUserId, logUsage } from '../_shared/supabase.ts'

interface ProcessRequest {
  noteId: string
  persona?: string
  model?: 'claude-haiku-4-5' | 'claude-sonnet-4-6'
}

interface NoteRow {
  id: string
  content: string
  mini_notes: string | null
}

interface ThemeRow {
  id: string
  name: string
  description: string | null
  is_sensitive: boolean
}

interface Suggestion {
  title: string
  summary: string
  tags: string[]
  matched_theme_ids: string[]
  new_themes: { name: string; description: string }[]
  related_note_ids: string[]
  section: string
}

const VALID_SECTIONS = new Set([
  'probleemstelling',
  'theoretische_onderbouwing',
  'ondersteunende_concepten',
  'methodieken',
  'reflectievragen',
])

const SYSTEM_PROMPT = `Je bent een kennis-assistent voor een persoonlijk denksysteem (ThoughtFoundry).
De gebruiker capteert atomische ideeën over o.a. autisme/neurodiversiteit, relaties, coaching, management en persoonlijke ontwikkeling.

Jouw taak: één ruwe nota analyseren en gestructureerde suggesties teruggeven.

Schrijf alle teksten in het Nederlands.

Antwoord ALLEEN met geldige JSON, in dit exacte formaat:
{
  "title": "korte kop, max 80 chars",
  "summary": "1-2 zinnen kerngedachte",
  "tags": ["max 5 tags, lowercase, single-word of-met-streepje"],
  "matched_theme_ids": ["uuid", ...],   // alleen ids uit de gegeven thema-lijst
  "new_themes": [{"name": "...", "description": "..."}],  // alleen indien echt geen match
  "related_note_ids": ["uuid", ...],    // max 3, alleen als sterk verwant
  "section": "probleemstelling"         // één van de vijf slugs, of leeg string als onduidelijk
}

De vijf geldige waarden voor "section":
- "probleemstelling"          — het centrale probleem of de onderzoeksvraag
- "theoretische_onderbouwing" — theorie, concepten, wetenschappelijke basis
- "ondersteunende_concepten"  — aanvullende ideeën die de theorie steunen
- "methodieken"               — praktische methoden, tools, handvaten
- "reflectievragen"           — vragen voor verdieping of zelfreflectie

Kies de best passende section-slug. Als de nota duidelijk bij geen enkele past, geef dan een lege string terug.

Wees terughoudend met new_themes (max 1). Wees terughoudend met related_note_ids (alleen sterk overeenkomend).`

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')   return jsonResponse({ error: 'Method not allowed' }, 405)

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return jsonResponse({ error: 'ANTHROPIC_API_KEY not configured' }, 500)

  let body: ProcessRequest
  try { body = await req.json() } catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }
  if (!body.noteId) return jsonResponse({ error: 'noteId required' }, 400)

  const model = body.model ?? 'claude-haiku-4-5'
  const supabase = getUserClient(req)

  let userId: string
  try { userId = await requireUserId(supabase) }
  catch { return jsonResponse({ error: 'Unauthorized' }, 401) }

  // Load the note + the user's themes + recent context notes (for similarity).
  const [{ data: noteData, error: noteErr }, { data: themesData }, { data: contextData }] = await Promise.all([
    supabase.from('notes').select('id, content, mini_notes').eq('id', body.noteId).single(),
    supabase.from('themes').select('id, name, description, is_sensitive'),
    supabase.from('notes').select('id, content, ai_title')
      .neq('id', body.noteId)
      .order('created_at', { ascending: false })
      .limit(80)
  ])

  if (noteErr || !noteData) return jsonResponse({ error: 'Note not found' }, 404)
  const note = noteData as NoteRow
  const themes = (themesData ?? []) as ThemeRow[]
  const contextNotes = (contextData ?? []) as { id: string; content: string; ai_title: string | null }[]

  const userPrompt = buildUserPrompt(note, themes, contextNotes)

  const system = [body.persona?.trim(), SYSTEM_PROMPT].filter(Boolean).join('\n\n')

  let result
  try {
    result = await callAnthropic({
      apiKey,
      model,
      system,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 1024
    })
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'AI call failed' }, 502)
  }

  let suggestion: Suggestion
  try {
    suggestion = parseJsonFromResponse<Suggestion>(result.text)
  } catch {
    return jsonResponse({ error: 'AI returned invalid JSON', raw: result.text }, 502)
  }

  // Strip hallucinated theme/note ids that don't belong to this user.
  const validThemeIds = new Set(themes.map(t => t.id))
  const validNoteIds = new Set(contextNotes.map(n => n.id))
  suggestion.matched_theme_ids = (suggestion.matched_theme_ids ?? []).filter(id => validThemeIds.has(id))
  suggestion.related_note_ids = (suggestion.related_note_ids ?? []).filter(id => validNoteIds.has(id)).slice(0, 3)
  suggestion.new_themes = (suggestion.new_themes ?? []).slice(0, 1)
  suggestion.tags = (suggestion.tags ?? []).slice(0, 5)
  // Validate section: must be one of the five slugs or empty string
  if (!VALID_SECTIONS.has(suggestion.section ?? '')) suggestion.section = ''

  const cost = estimateCost(model, result.inputTokens, result.outputTokens)
  await logUsage(supabase, {
    userId,
    model,
    operation: 'process-note',
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: cost
  })

  return jsonResponse({
    suggestion,
    usage: {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: cost
    }
  })
})

function buildUserPrompt(
  note: NoteRow,
  themes: ThemeRow[],
  contextNotes: { id: string; content: string; ai_title: string | null }[]
): string {
  const hasSensitiveThemes = themes.some(t => t.is_sensitive)

  const themeList = themes.length === 0
    ? '(geen bestaande thema\'s)'
    : themes.map(t => `- [${t.id}] ${t.name}${t.description ? ' — ' + t.description : ''}${t.is_sensitive ? ' [GEVOELIG]' : ''}`).join('\n')

  const contextList = contextNotes.length === 0
    ? '(geen andere nota\'s)'
    : contextNotes.map(n => {
        const snippet = (n.ai_title ?? n.content).slice(0, 140).replace(/\s+/g, ' ')
        return `- [${n.id}] ${snippet}`
      }).join('\n')

  const sensitivityNote = hasSensitiveThemes
    ? '\n\nGevoelig thema aanwezig: als je een [GEVOELIG] thema koppelt, structureer dan je samenvatting en sluit af. Stel geen open vragen.'
    : ''

  return `## Te verwerken nota

${note.content}${note.mini_notes ? '\n\nExtra notitie: ' + note.mini_notes : ''}

## Bestaande thema's

${themeList}

## Andere recente nota's (voor related_note_ids)

${contextList}${sensitivityNote}

Geef je analyse als JSON.`
}
