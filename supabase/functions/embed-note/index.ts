// Generate a vector embedding for a single note using the Supabase Edge Runtime
// built-in model (gte-small, 384-dim). No external provider, no API key, no cost.
// Called fire-and-forget after a note is processed/accepted so it becomes
// findable by note_neighbors / semantic_bridges.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { getUserClient, requireUserId } from '../_shared/supabase.ts'

// Supabase.ai is provided by the edge runtime and isn't part of Deno's types.
// deno-lint-ignore no-explicit-any
declare const Supabase: any

interface EmbedRequest {
  noteId: string
}

const EMBED_MODEL = 'gte-small' // 384-dim, runs in-runtime

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')   return jsonResponse({ error: 'Method not allowed' }, 405)

  let body: EmbedRequest
  try { body = await req.json() } catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }
  if (!body.noteId) return jsonResponse({ error: 'noteId required' }, 400)

  const supabase = getUserClient(req)

  let userId: string
  try { userId = await requireUserId(supabase) }
  catch { return jsonResponse({ error: 'Unauthorized' }, 401) }

  const { data: note, error: noteErr } = await supabase
    .from('notes')
    .select('id, content, mini_notes')
    .eq('id', body.noteId)
    .single()

  if (noteErr || !note) return jsonResponse({ error: 'Note not found' }, 404)

  const text = note.mini_notes ? `${note.content}\n\n${note.mini_notes}` : note.content

  const session = new Supabase.ai.Session(EMBED_MODEL)
  let embedding: number[]
  try {
    embedding = await session.run(text, { mean_pool: true, normalize: true }) as number[]
  } catch (err) {
    return jsonResponse({ error: `Embedding failed: ${err instanceof Error ? err.message : String(err)}` }, 502)
  }
  if (!Array.isArray(embedding) || embedding.length === 0) {
    return jsonResponse({ error: 'No embedding produced' }, 502)
  }

  // Persist embedding (RLS guarantees ownership; trigger stamps embedded_at).
  const { error: updateErr } = await supabase
    .from('notes')
    .update({ embedding: embedding as unknown as string })
    .eq('id', body.noteId)

  if (updateErr) return jsonResponse({ error: updateErr.message }, 500)

  await supabase.from('ai_usage').insert({
    user_id: userId,
    model: EMBED_MODEL,
    operation: 'embed-note',
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0
  })

  return jsonResponse({ ok: true, dimensions: embedding.length, costUsd: 0 })
})
