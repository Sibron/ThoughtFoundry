# Manual Supabase update (browser only — no CLI)

This is **optional cleanup** tied to merging the `types` column into `tags`.
Nothing breaks if you skip it: the new frontend ignores `types`, and the
currently-deployed functions keep working because the column still exists.

Do the steps in this order — **functions first, then the SQL** (the live
`generate-chapter` still reads the `types` column, so drop it only after the
function no longer references it).

---

## Step 1 — Redeploy the two edge functions (Supabase dashboard)

For each function below:

1. Open https://supabase.com/dashboard → project **ThoughtFoundry**.
2. Left sidebar → **Edge Functions** → click the function name
   (`process-note`, then `generate-chapter`).
3. Open its editor (**Edit function** / code view).
4. Select all existing code in `index.ts` and replace it with the single-file
   version below.
5. Click **Deploy**.

These versions have the shared helpers inlined, so each is one self-contained
file — you do **not** need the `_shared` folder in the dashboard.

### `process-note` → index.ts

```ts
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

type AnthropicModel = 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-7'
const PRICING: Record<AnthropicModel, { input: number; output: number }> = {
  'claude-haiku-4-5':  { input: 1.0,  output: 5.0  },
  'claude-sonnet-4-6': { input: 3.0,  output: 15.0 },
  'claude-opus-4-7':   { input: 15.0, output: 75.0 }
}
function estimateCost(model: AnthropicModel, i: number, o: number): number {
  const p = PRICING[model]; return (i * p.input + o * p.output) / 1_000_000
}
async function callAnthropic(opts: { apiKey: string; model: AnthropicModel; system: string; messages: { role: 'user' | 'assistant'; content: string }[]; maxTokens?: number }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: opts.model, max_tokens: opts.maxTokens ?? 1024, system: opts.system, messages: opts.messages })
  })
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const text = (data.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('')
  return { text, inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 }
}
function parseJsonFromResponse<T>(text: string): T {
  const trimmed = text.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  return JSON.parse(fence ? fence[1].trim() : trimmed) as T
}
// deno-lint-ignore no-explicit-any
function getUserClient(req: Request): SupabaseClient<any, 'public', any> {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }
  })
}
async function requireUserId(client: SupabaseClient): Promise<string> {
  const { data, error } = await client.auth.getUser()
  if (error || !data.user) throw new Error('Unauthorized')
  return data.user.id
}
async function logUsage(client: SupabaseClient, a: { userId: string; model: string; operation: string; inputTokens: number; outputTokens: number; costUsd: number }) {
  await client.from('ai_usage').insert({ user_id: a.userId, model: a.model, operation: a.operation, input_tokens: a.inputTokens, output_tokens: a.outputTokens, cost_usd: a.costUsd })
}

interface NoteRow { id: string; content: string; mini_notes: string | null }
interface ThemeRow { id: string; name: string; description: string | null }
interface Suggestion { title: string; summary: string; tags: string[]; matched_theme_ids: string[]; new_themes: { name: string; description: string }[]; related_note_ids: string[]; section: string }

const VALID_SECTIONS = new Set(['probleemstelling','theoretische_onderbouwing','ondersteunende_concepten','methodieken','reflectievragen'])

const SYSTEM_PROMPT = `Je bent een kennis-assistent voor een persoonlijk denksysteem (ThoughtFoundry).
De gebruiker capteert atomische ideeën over o.a. autisme/neurodiversiteit, relaties, coaching, management en persoonlijke ontwikkeling.

Jouw taak: één ruwe nota analyseren en gestructureerde suggesties teruggeven.

Schrijf alle teksten in het Nederlands.

Antwoord ALLEEN met geldige JSON, in dit exacte formaat:
{
  "title": "korte kop, max 80 chars",
  "summary": "1-2 zinnen kerngedachte",
  "tags": ["max 5 tags, lowercase, single-word of-met-streepje"],
  "matched_theme_ids": ["uuid", ...],
  "new_themes": [{"name": "...", "description": "..."}],
  "related_note_ids": ["uuid", ...],
  "section": "probleemstelling"
}

De vijf geldige waarden voor "section":
- "probleemstelling"
- "theoretische_onderbouwing"
- "ondersteunende_concepten"
- "methodieken"
- "reflectievragen"

Kies de best passende section-slug, of een lege string. Wees terughoudend met new_themes (max 1) en related_note_ids.`

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')   return jsonResponse({ error: 'Method not allowed' }, 405)
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return jsonResponse({ error: 'ANTHROPIC_API_KEY not configured' }, 500)
  let body: { noteId: string; persona?: string; model?: 'claude-haiku-4-5' | 'claude-sonnet-4-6' }
  try { body = await req.json() } catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }
  if (!body.noteId) return jsonResponse({ error: 'noteId required' }, 400)
  const model = body.model ?? 'claude-haiku-4-5'
  const supabase = getUserClient(req)
  let userId: string
  try { userId = await requireUserId(supabase) } catch { return jsonResponse({ error: 'Unauthorized' }, 401) }
  const [{ data: noteData, error: noteErr }, { data: themesData }, { data: contextData }] = await Promise.all([
    supabase.from('notes').select('id, content, mini_notes').eq('id', body.noteId).single(),
    supabase.from('themes').select('id, name, description'),
    supabase.from('notes').select('id, content, ai_title').neq('id', body.noteId).order('created_at', { ascending: false }).limit(80)
  ])
  if (noteErr || !noteData) return jsonResponse({ error: 'Note not found' }, 404)
  const note = noteData as NoteRow
  const themes = (themesData ?? []) as ThemeRow[]
  const contextNotes = (contextData ?? []) as { id: string; content: string; ai_title: string | null }[]
  const themeList = themes.length === 0 ? "(geen bestaande thema's)" : themes.map(t => `- [${t.id}] ${t.name}${t.description ? ' — ' + t.description : ''}`).join('\n')
  const contextList = contextNotes.length === 0 ? "(geen andere nota's)" : contextNotes.map(n => `- [${n.id}] ${(n.ai_title ?? n.content).slice(0, 140).replace(/\s+/g, ' ')}`).join('\n')
  const userPrompt = `## Te verwerken nota\n\n${note.content}${note.mini_notes ? '\n\nExtra notitie: ' + note.mini_notes : ''}\n\n## Bestaande thema's\n\n${themeList}\n\n## Andere recente nota's (voor related_note_ids)\n\n${contextList}\n\nGeef je analyse als JSON.`
  const system = [body.persona?.trim(), SYSTEM_PROMPT].filter(Boolean).join('\n\n')
  let result
  try { result = await callAnthropic({ apiKey, model, system, messages: [{ role: 'user', content: userPrompt }], maxTokens: 1024 }) }
  catch (err) { return jsonResponse({ error: err instanceof Error ? err.message : 'AI call failed' }, 502) }
  let suggestion: Suggestion
  try { suggestion = parseJsonFromResponse<Suggestion>(result.text) } catch { return jsonResponse({ error: 'AI returned invalid JSON', raw: result.text }, 502) }
  const validThemeIds = new Set(themes.map(t => t.id))
  const validNoteIds = new Set(contextNotes.map(n => n.id))
  suggestion.matched_theme_ids = (suggestion.matched_theme_ids ?? []).filter(id => validThemeIds.has(id))
  suggestion.related_note_ids = (suggestion.related_note_ids ?? []).filter(id => validNoteIds.has(id)).slice(0, 3)
  suggestion.new_themes = (suggestion.new_themes ?? []).slice(0, 1)
  suggestion.tags = (suggestion.tags ?? []).slice(0, 5)
  if (!VALID_SECTIONS.has(suggestion.section ?? '')) suggestion.section = ''
  const cost = estimateCost(model, result.inputTokens, result.outputTokens)
  await logUsage(supabase, { userId, model, operation: 'process-note', inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost })
  return jsonResponse({ suggestion, usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost } })
})
```

### `generate-chapter` → index.ts

```ts
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

type AnthropicModel = 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-7'
const PRICING: Record<AnthropicModel, { input: number; output: number }> = {
  'claude-haiku-4-5':  { input: 1.0,  output: 5.0  },
  'claude-sonnet-4-6': { input: 3.0,  output: 15.0 },
  'claude-opus-4-7':   { input: 15.0, output: 75.0 }
}
function estimateCost(model: AnthropicModel, i: number, o: number): number {
  const p = PRICING[model]; return (i * p.input + o * p.output) / 1_000_000
}
async function callAnthropic(opts: { apiKey: string; model: AnthropicModel; system: string; messages: { role: 'user' | 'assistant'; content: string }[]; maxTokens?: number }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: opts.model, max_tokens: opts.maxTokens ?? 1024, system: opts.system, messages: opts.messages })
  })
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const text = (data.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('')
  return { text, inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 }
}
function parseJsonFromResponse<T>(text: string): T {
  const trimmed = text.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  return JSON.parse(fence ? fence[1].trim() : trimmed) as T
}
// deno-lint-ignore no-explicit-any
function getUserClient(req: Request): SupabaseClient<any, 'public', any> {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }
  })
}
async function requireUserId(client: SupabaseClient): Promise<string> {
  const { data, error } = await client.auth.getUser()
  if (error || !data.user) throw new Error('Unauthorized')
  return data.user.id
}
async function logUsage(client: SupabaseClient, a: { userId: string; model: string; operation: string; inputTokens: number; outputTokens: number; costUsd: number }) {
  await client.from('ai_usage').insert({ user_id: a.userId, model: a.model, operation: a.operation, input_tokens: a.inputTokens, output_tokens: a.outputTokens, cost_usd: a.costUsd })
}

interface NoteRow { id: string; content: string; mini_notes: string | null; ai_title: string | null; ai_summary: string | null; tags: string[] | null }
interface ChapterPlan { title: string; summary: string; sections: { heading: string; intent: string; note_ids: string[] }[] }

const SYSTEM_PROMPT = `Je bent een redacteur die ruwe nota's samenbrengt tot een hoofdstukschets voor een informatief boek.

Schrijf in het Nederlands. Antwoord ALLEEN met JSON:
{
  "title": "korte hoofdstuktitel",
  "summary": "2-3 zinnen kerngedachte van het hoofdstuk",
  "sections": [ { "heading": "sectie-titel", "intent": "wat deze sectie wil zeggen", "note_ids": ["uuid", ...] } ]
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
  let body: { themeId?: string; noteIds: string[]; angle?: string; persona?: string; model?: AnthropicModel }
  try { body = await req.json() } catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }
  if (!Array.isArray(body.noteIds) || body.noteIds.length === 0) return jsonResponse({ error: 'noteIds (non-empty array) required' }, 400)
  const model = body.model ?? 'claude-sonnet-4-6'
  const supabase = getUserClient(req)
  let userId: string
  try { userId = await requireUserId(supabase) } catch { return jsonResponse({ error: 'Unauthorized' }, 401) }
  const { data: notesData, error: notesErr } = await supabase
    .from('notes')
    .select('id, content, mini_notes, ai_title, ai_summary, tags')
    .in('id', body.noteIds)
  if (notesErr) return jsonResponse({ error: notesErr.message }, 500)
  const notes = (notesData ?? []) as NoteRow[]
  if (notes.length === 0) return jsonResponse({ error: 'No notes found' }, 404)
  let themeName: string | null = null
  if (body.themeId) {
    const { data: theme } = await supabase.from('themes').select('name').eq('id', body.themeId).single()
    themeName = theme?.name ?? null
  }
  const noteText = notes.map(n => {
    const head = n.ai_title ? n.ai_title : n.content.slice(0, 60)
    const summary = n.ai_summary ?? n.content
    const tags = (n.tags ?? []).join(', ')
    return `### [${n.id}] ${head}\n${summary}${tags ? `\nTags: ${tags}` : ''}`
  }).join('\n\n')
  const themeLine = themeName ? `Thema: **${themeName}**` : 'Thema: (geen)'
  const angleLine = body.angle ? `Invalshoek van de gebruiker: ${body.angle}` : ''
  const userPrompt = `${themeLine}\n${angleLine}\n\n## Nota's\n\n${noteText}\n\nGeef het hoofdstukplan als JSON.`
  const system = [body.persona?.trim(), SYSTEM_PROMPT].filter(Boolean).join('\n\n')
  let result
  try { result = await callAnthropic({ apiKey, model, system, messages: [{ role: 'user', content: userPrompt }], maxTokens: 2048 }) }
  catch (err) { return jsonResponse({ error: err instanceof Error ? err.message : 'AI call failed' }, 502) }
  let plan: ChapterPlan
  try { plan = parseJsonFromResponse<ChapterPlan>(result.text) } catch { return jsonResponse({ error: 'AI returned invalid JSON', raw: result.text }, 502) }
  const validIds = new Set(notes.map(n => n.id))
  plan.sections = (plan.sections ?? [])
    .map(s => ({ ...s, note_ids: (s.note_ids ?? []).filter(id => validIds.has(id)) }))
    .filter(s => s.note_ids.length > 0)
    .slice(0, 5)
  const cost = estimateCost(model, result.inputTokens, result.outputTokens)
  await logUsage(supabase, { userId, model, operation: 'generate-chapter', inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost })
  return jsonResponse({ plan, usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost } })
})
```

---

## Step 2 — Run the migration (SQL Editor)

Dashboard → **SQL Editor** → **New query** → paste and **Run**:

```sql
update public.notes
set tags = (
  select array(
    select distinct t
    from unnest(coalesce(tags,'{}') || coalesce(types,'{}')) as t
    where t is not null and t <> ''
  )
)
where types is not null and array_length(types,1) is not null;

alter table public.notes drop column if exists types;
```

Done. The `types` column is gone and both functions now work against the
`tags`-only model.
