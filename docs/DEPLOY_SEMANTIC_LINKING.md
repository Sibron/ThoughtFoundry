# Deploy: semantische deep-linking (dashboard-route, geen CLI)

Volgorde: **migraties → functions → backfill**. Geen externe embedding-dienst en
geen API-key nodig — embeddings draaien lokaal in de Supabase Edge Runtime
(`gte-small`, 384-dim). Alles is additief; zonder embeddings valt de app netjes
terug op de bestaande lexicale methode.

---

## Stap 1 — Migraties draaien (SQL Editor)

Dashboard → project **ThoughtFoundry** → **SQL Editor** → **New query** → plak
onderstaande twee blokken (mogen samen in één run) → **Run**. Idempotent.

### 1a — embedding-activatie (incl. dimensie 384)

```sql
-- gte-small geeft 384-dim; de basis-schema maakte embedding als vector(1024).
-- Er zijn nog geen embeddings, dus droppen + opnieuw aanmaken is verliesvrij.
drop index if exists public.notes_embedding_idx;

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'notes' and column_name = 'embedding') then
    alter table public.notes drop column embedding;
  end if;
end $$;

alter table public.notes add column embedding vector(384);

create index if not exists notes_embedding_idx
  on public.notes using ivfflat (embedding vector_cosine_ops) with (lists = 100);

create or replace function public.match_notes(
  query_embedding vector(384),
  match_count int default 5,
  exclude_id uuid default null
)
returns table (id uuid, content text, similarity float)
language sql stable as $$
  select n.id, n.content, 1 - (n.embedding <=> query_embedding) as similarity
  from public.notes n
  where n.user_id = auth.uid()
    and n.embedding is not null
    and (exclude_id is null or n.id <> exclude_id)
  order by n.embedding <=> query_embedding
  limit match_count
$$;

alter table public.notes add column if not exists embedded_at timestamptz;

create or replace function public.stamp_embedded_at()
returns trigger language plpgsql as $$
begin
  if new.embedding is not null and new.embedding is distinct from old.embedding then
    new.embedded_at = now();
  end if;
  return new;
end $$;

drop trigger if exists notes_stamp_embedded_at on public.notes;
create trigger notes_stamp_embedded_at
  before update on public.notes
  for each row execute procedure public.stamp_embedded_at();

create or replace function public.notes_needing_embedding(batch_size int default 50)
returns table (id uuid, content text, mini_notes text)
language sql stable as $$
  select n.id, n.content, n.mini_notes
  from public.notes n
  where n.user_id = auth.uid()
    and (n.embedding is null or n.embedded_at is null or n.embedded_at < n.updated_at)
  order by n.created_at asc
  limit batch_size
$$;

create or replace function public.count_notes_needing_embedding()
returns int language sql stable as $$
  select count(*)::int
  from public.notes n
  where n.user_id = auth.uid()
    and (n.embedding is null or n.embedded_at is null or n.embedded_at < n.updated_at)
$$;
```

> Mocht het struikelen op `is distinct from` (zeer oude pgvector zonder `=`-operator):
> vervang de `if`-regel in `stamp_embedded_at` door `if new.embedding is not null then`.

### 1b — semantische link-RPC's

```sql
create or replace function public.note_neighbors(
  source uuid,
  match_count int default 8
)
returns table (id uuid, ai_title text, content text, similarity float)
language sql stable as $$
  with src as (
    select embedding
    from public.notes
    where id = source and user_id = auth.uid() and embedding is not null
  )
  select n.id, n.ai_title, n.content,
         1 - (n.embedding <=> (select embedding from src)) as similarity
  from public.notes n
  where n.user_id = auth.uid()
    and n.embedding is not null
    and n.id <> source
    and exists (select 1 from src)
    and not exists (
      select 1 from public.note_links l
      where (l.source_id = source and l.target_id = n.id)
         or (l.source_id = n.id and l.target_id = source)
    )
  order by n.embedding <=> (select embedding from src)
  limit match_count
$$;

create or replace function public.semantic_bridges(
  band_lo float default 0.55,
  band_hi float default 0.82,
  max_pairs int default 20
)
returns table (a_id uuid, b_id uuid, similarity float)
language sql stable as $$
  select a.id as a_id, b.id as b_id,
         1 - (a.embedding <=> b.embedding) as similarity
  from public.notes a
  join public.notes b
    on a.user_id = auth.uid()
   and b.user_id = auth.uid()
   and a.id < b.id
   and a.embedding is not null
   and b.embedding is not null
   and (1 - (a.embedding <=> b.embedding)) between band_lo and band_hi
  where not exists (
      select 1 from public.note_links l
      where (l.source_id = a.id and l.target_id = b.id)
         or (l.source_id = b.id and l.target_id = a.id))
    and not exists (
      select 1 from public.note_themes ta
      join public.note_themes tb on ta.theme_id = tb.theme_id
      where ta.note_id = a.id and tb.note_id = b.id)
  order by (1 - (a.embedding <=> b.embedding)) desc
  limit max_pairs
$$;
```

> **Band ijken voor gte-small:** de defaults `0.55–0.82` waren voor een ander model.
> gte-small geeft vaak hogere baseline-similariteit; als de voorgestelde bruggen te
> "obvious" zijn, verhoog de band (bv. `0.70–0.92`). Te ver-gezocht? Verlaag hem.
> Je kunt dit los testen: `select * from public.semantic_bridges(0.70, 0.92, 10);`

---

## Stap 2 — Edge functions deployen (dashboard-editor)

**Edge Functions** → **Create a function** (of bestaande openen) → naam exact zoals
hieronder → plak de volledige `index.ts` → **Deploy**. Helpers zijn ingebakken, dus
de `_shared`-map is niet nodig.

- `embed-note` → **bestaand, vervangen** (nu gte-small)
- `embed-notes-batch` → **nieuw**
- `enrich-links` → **nieuw**
- `process-note` → **bestaand, vervangen**

> `embed-note` en `embed-notes-batch` gebruiken `Supabase.ai` (ingebouwd in de edge
> runtime). Geen import, geen key. Werkt op de gehoste Supabase-runtime.

### 2a — `embed-note` → index.ts (vervangt de bestaande)

```ts
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
// deno-lint-ignore no-explicit-any
declare const Supabase: any

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
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

const EMBED_MODEL = 'gte-small'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')   return jsonResponse({ error: 'Method not allowed' }, 405)
  let body: { noteId: string }
  try { body = await req.json() } catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }
  if (!body.noteId) return jsonResponse({ error: 'noteId required' }, 400)
  const supabase = getUserClient(req)
  let userId: string
  try { userId = await requireUserId(supabase) } catch { return jsonResponse({ error: 'Unauthorized' }, 401) }
  const { data: note, error: noteErr } = await supabase.from('notes').select('id, content, mini_notes').eq('id', body.noteId).single()
  if (noteErr || !note) return jsonResponse({ error: 'Note not found' }, 404)
  const text = note.mini_notes ? `${note.content}\n\n${note.mini_notes}` : note.content
  const session = new Supabase.ai.Session(EMBED_MODEL)
  let embedding: number[]
  try { embedding = await session.run(text, { mean_pool: true, normalize: true }) as number[] }
  catch (err) { return jsonResponse({ error: `Embedding failed: ${err instanceof Error ? err.message : String(err)}` }, 502) }
  if (!Array.isArray(embedding) || embedding.length === 0) return jsonResponse({ error: 'No embedding produced' }, 502)
  const { error: updateErr } = await supabase.from('notes').update({ embedding: embedding as unknown as string }).eq('id', body.noteId)
  if (updateErr) return jsonResponse({ error: updateErr.message }, 500)
  await supabase.from('ai_usage').insert({ user_id: userId, model: EMBED_MODEL, operation: 'embed-note', input_tokens: 0, output_tokens: 0, cost_usd: 0 })
  return jsonResponse({ ok: true, dimensions: embedding.length, costUsd: 0 })
})
```

### 2b — `embed-notes-batch` → index.ts (nieuw)

```ts
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
// deno-lint-ignore no-explicit-any
declare const Supabase: any

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
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

const EMBED_MODEL = 'gte-small'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')   return jsonResponse({ error: 'Method not allowed' }, 405)
  let body: { batchSize?: number }
  try { body = await req.json() } catch { body = {} }
  const batchSize = Math.min(Math.max(body.batchSize ?? 50, 1), 100)
  const supabase = getUserClient(req)
  let userId: string
  try { userId = await requireUserId(supabase) } catch { return jsonResponse({ error: 'Unauthorized' }, 401) }
  const { data: rows, error: rpcErr } = await supabase.rpc('notes_needing_embedding', { batch_size: batchSize })
  if (rpcErr) return jsonResponse({ error: rpcErr.message }, 500)
  const notes = (rows ?? []) as { id: string; content: string; mini_notes: string | null }[]
  if (notes.length === 0) return jsonResponse({ done: true, embedded: 0, remaining: 0, costUsd: 0 })
  const session = new Supabase.ai.Session(EMBED_MODEL)
  let embedded = 0
  for (const n of notes) {
    const text = n.mini_notes ? `${n.content}\n\n${n.mini_notes}` : n.content
    let emb: number[]
    try { emb = await session.run(text, { mean_pool: true, normalize: true }) as number[] } catch { continue }
    if (!Array.isArray(emb) || emb.length === 0) continue
    const { error: updErr } = await supabase.from('notes').update({ embedding: emb as unknown as string }).eq('id', n.id)
    if (!updErr) embedded++
  }
  if (embedded > 0) {
    await supabase.from('ai_usage').insert({ user_id: userId, model: EMBED_MODEL, operation: 'embed-notes-batch', input_tokens: 0, output_tokens: 0, cost_usd: 0 })
  }
  const { data: remainingCount } = await supabase.rpc('count_notes_needing_embedding')
  const remaining = typeof remainingCount === 'number' ? remainingCount : 0
  return jsonResponse({ done: remaining === 0, embedded, remaining, costUsd: 0 })
})
```

### 2c — `enrich-links` → index.ts (nieuw)

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
  'claude-opus-4-7':   { input: 5.0,  output: 25.0 }
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

const VALID_TYPES = new Set(['builds_on', 'contradicts', 'example_of', 'contrasts', 'applies_to', 'related'])
const MAX_PAIRS = 40
function pairKey(a: string, b: string): string { return a < b ? `${a}|${b}` : `${b}|${a}` }

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
  let body: { pairs: { aId: string; bId: string }[]; persona?: string; model?: AnthropicModel }
  try { body = await req.json() } catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }
  const pairs = (body.pairs ?? []).slice(0, MAX_PAIRS)
  if (pairs.length === 0) return jsonResponse({ error: 'pairs required' }, 400)
  const model = body.model ?? 'claude-haiku-4-5'
  const supabase = getUserClient(req)
  let userId: string
  try { userId = await requireUserId(supabase) } catch { return jsonResponse({ error: 'Unauthorized' }, 401) }
  const ids = [...new Set(pairs.flatMap(p => [p.aId, p.bId]))]
  const { data: notesData, error: notesErr } = await supabase.from('notes').select('id, ai_title, ai_summary, content').in('id', ids)
  if (notesErr) return jsonResponse({ error: notesErr.message }, 500)
  const noteMap = new Map<string, { title: string; text: string }>()
  for (const n of (notesData ?? []) as { id: string; ai_title: string | null; ai_summary: string | null; content: string }[]) {
    noteMap.set(n.id, { title: n.ai_title ?? '(geen titel)', text: (n.ai_summary ?? n.content).slice(0, 200).replace(/\s+/g, ' ') })
  }
  const validPairs = pairs.filter(p => noteMap.has(p.aId) && noteMap.has(p.bId))
  if (validPairs.length === 0) return jsonResponse({ error: 'No valid pairs' }, 400)
  const pairBlock = validPairs.map((p, i) => {
    const a = noteMap.get(p.aId)!; const b = noteMap.get(p.bId)!
    return `Paar ${i + 1}:\n  A [${p.aId}] ${a.title}: ${a.text}\n  B [${p.bId}] ${b.title}: ${b.text}`
  }).join('\n\n')
  const userPrompt = `## Kandidaat-paren (${validPairs.length})\n\n${pairBlock}\n\nGeef je beoordeling als JSON.`
  const system = [body.persona?.trim(), SYSTEM_PROMPT].filter(Boolean).join('\n\n')
  let result
  try { result = await callAnthropic({ apiKey, model, system, messages: [{ role: 'user', content: userPrompt }], maxTokens: 1024 }) }
  catch (err) { return jsonResponse({ error: err instanceof Error ? err.message : 'AI call failed' }, 502) }
  let parsed: { links: { a_id: string; b_id: string; keep: boolean; type: string; reason: string }[] }
  try { parsed = parseJsonFromResponse(result.text) } catch { return jsonResponse({ error: 'AI returned invalid JSON', raw: result.text }, 502) }
  const sentKeys = new Set(validPairs.map(p => pairKey(p.aId, p.bId)))
  const seen = new Set<string>()
  const links = (parsed.links ?? [])
    .filter(l => l && typeof l.a_id === 'string' && typeof l.b_id === 'string')
    .map(l => ({ a_id: l.a_id, b_id: l.b_id, keep: l.keep !== false, type: VALID_TYPES.has(l.type) ? l.type : 'related', reason: typeof l.reason === 'string' ? l.reason.slice(0, 200) : '' }))
    .filter(l => { const k = pairKey(l.a_id, l.b_id); if (!sentKeys.has(k) || seen.has(k)) return false; seen.add(k); return true })
  const cost = estimateCost(model, result.inputTokens, result.outputTokens)
  await logUsage(supabase, { userId, model, operation: 'enrich-links', inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost })
  return jsonResponse({ links, usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost } })
})
```

### 2d — `process-note` → index.ts (vervangt de bestaande)

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
  'claude-opus-4-7':   { input: 5.0,  output: 25.0 }
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
interface ThemeRow { id: string; name: string; description: string | null; is_sensitive: boolean }
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
- "probleemstelling"          — het centrale probleem of de onderzoeksvraag
- "theoretische_onderbouwing" — theorie, concepten, wetenschappelijke basis
- "ondersteunende_concepten"  — aanvullende ideeën die de theorie steunen
- "methodieken"               — praktische methoden, tools, handvaten
- "reflectievragen"           — vragen voor verdieping of zelfreflectie

Kies de best passende section-slug. Als de nota duidelijk bij geen enkele past, geef dan een lege string terug.

Wees terughoudend met new_themes (max 1). Wees terughoudend met related_note_ids (alleen sterk overeenkomend).`

function buildUserPrompt(note: NoteRow, themes: ThemeRow[], contextNotes: { id: string; content: string; ai_title: string | null }[]): string {
  const hasSensitiveThemes = themes.some(t => t.is_sensitive)
  const themeList = themes.length === 0
    ? "(geen bestaande thema's)"
    : themes.map(t => `- [${t.id}] ${t.name}${t.description ? ' — ' + t.description : ''}${t.is_sensitive ? ' [GEVOELIG]' : ''}`).join('\n')
  const contextList = contextNotes.length === 0
    ? "(geen andere nota's)"
    : contextNotes.map(n => `- [${n.id}] ${(n.ai_title ?? n.content).slice(0, 140).replace(/\s+/g, ' ')}`).join('\n')
  const sensitivityNote = hasSensitiveThemes
    ? '\n\nGevoelig thema aanwezig: als je een [GEVOELIG] thema koppelt, structureer dan je samenvatting en sluit af. Stel geen open vragen.'
    : ''
  return `## Te verwerken nota\n\n${note.content}${note.mini_notes ? '\n\nExtra notitie: ' + note.mini_notes : ''}\n\n## Bestaande thema's\n\n${themeList}\n\n## Andere recente nota's (voor related_note_ids)\n\n${contextList}${sensitivityNote}\n\nGeef je analyse als JSON.`
}

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

  const [{ data: noteData, error: noteErr }, { data: themesData }] = await Promise.all([
    supabase.from('notes').select('id, content, mini_notes').eq('id', body.noteId).single(),
    supabase.from('themes').select('id, name, description, is_sensitive')
  ])
  if (noteErr || !noteData) return jsonResponse({ error: 'Note not found' }, 404)
  const note = noteData as NoteRow
  const themes = (themesData ?? []) as ThemeRow[]

  // Prefer semantic neighbours (embeddings); fall back to recent notes.
  let contextNotes: { id: string; content: string; ai_title: string | null }[] = []
  const { data: neighborData } = await supabase.rpc('note_neighbors', { source: body.noteId, match_count: 12 })
  if (neighborData && (neighborData as unknown[]).length > 0) {
    contextNotes = (neighborData as { id: string; ai_title: string | null; content: string }[]).map(n => ({ id: n.id, content: n.content, ai_title: n.ai_title }))
  } else {
    const { data: recentData } = await supabase.from('notes').select('id, content, ai_title').neq('id', body.noteId).order('created_at', { ascending: false }).limit(80)
    contextNotes = (recentData ?? []) as { id: string; content: string; ai_title: string | null }[]
  }

  const userPrompt = buildUserPrompt(note, themes, contextNotes)
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

---

## Stap 3 — Backfill draaien

In de app: **Instellingen** → "Semantische verbindingen activeren" → **Embeddings
genereren**. De knop loopt batch-voor-batch tot alles geëmbed is (hervatbaar,
gratis). AI moet aanstaan (toggle bovenaan Instellingen) zodat de sectie zichtbaar is.

---

## Verificatie (SQL Editor)

```sql
-- Hoeveel nota's hebben al een embedding?
select count(*) filter (where embedding is not null) as embedded,
       count(*) as total
from public.notes;

-- Buren van een willekeurige geëmbedde nota (verwacht: niet leeg)
select * from public.note_neighbors(
  (select id from public.notes where embedding is not null limit 1), 5);

-- Niet-voor-de-hand-liggende bruggen (band evt. ijken, zie 1b)
select * from public.semantic_bridges(0.55, 0.82, 10);

-- Embedding-activiteit deze maand (kosten $0 — lokaal model)
select operation, count(*), round(sum(cost_usd)::numeric, 4) as usd
from public.ai_usage where operation in ('embed-note','embed-notes-batch','enrich-links')
group by operation;
```

Kernbewijs "niet voor de hand liggend": zoek twee nota's met hetzelfde idee in
ánder woordgebruik (geen gedeelde woorden/tags, geen gedeeld thema). Tekstueel
zoeken mist ze; `semantic_bridges` zou ze moeten tonen.
