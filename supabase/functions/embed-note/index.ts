// Phase 2 (optional): generate a vector embedding for a note via Voyage AI.
// Only active when VOYAGE_API_KEY is set and pgvector is installed.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { getUserClient, requireUserId } from '../_shared/supabase.ts'

interface EmbedRequest {
  noteId: string
}

const VOYAGE_MODEL = 'voyage-3-large' // 1024-dim
const VOYAGE_INPUT_PRICE_PER_M = 0.18 // USD per million tokens (approx)

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')   return jsonResponse({ error: 'Method not allowed' }, 405)

  const voyageKey = Deno.env.get('VOYAGE_API_KEY')
  if (!voyageKey) return jsonResponse({ error: 'VOYAGE_API_KEY not configured' }, 501)

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

  const voyageRes = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${voyageKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ input: [text], model: VOYAGE_MODEL, input_type: 'document' })
  })

  if (!voyageRes.ok) {
    return jsonResponse({ error: `Voyage ${voyageRes.status}: ${await voyageRes.text()}` }, 502)
  }

  const voyageData = await voyageRes.json()
  const embedding: number[] = voyageData.data?.[0]?.embedding
  if (!embedding) return jsonResponse({ error: 'Voyage returned no embedding' }, 502)

  const tokens: number = voyageData.usage?.total_tokens ?? 0
  const costUsd = (tokens * VOYAGE_INPUT_PRICE_PER_M) / 1_000_000

  // Persist embedding (RLS guarantees ownership)
  const { error: updateErr } = await supabase
    .from('notes')
    .update({ embedding: embedding as unknown as string })
    .eq('id', body.noteId)

  if (updateErr) return jsonResponse({ error: updateErr.message }, 500)

  await supabase.from('ai_usage').insert({
    user_id: userId,
    model: VOYAGE_MODEL,
    operation: 'embed-note',
    input_tokens: tokens,
    output_tokens: 0,
    cost_usd: costUsd
  })

  return jsonResponse({ ok: true, dimensions: embedding.length, costUsd })
})
