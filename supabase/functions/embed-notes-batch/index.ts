// Batch sibling of embed-note: embeds the next batch of notes that still need a
// Voyage embedding, in ONE Voyage call (the API accepts an array). Drives a
// resumable client backfill loop. Only active when VOYAGE_API_KEY is set.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { getUserClient, requireUserId } from '../_shared/supabase.ts'

interface BatchRequest {
  batchSize?: number
}

const VOYAGE_MODEL = 'voyage-3-large' // 1024-dim
const VOYAGE_INPUT_PRICE_PER_M = 0.18 // USD per million tokens (approx)

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')   return jsonResponse({ error: 'Method not allowed' }, 405)

  const voyageKey = Deno.env.get('VOYAGE_API_KEY')
  if (!voyageKey) return jsonResponse({ error: 'VOYAGE_API_KEY not configured' }, 501)

  let body: BatchRequest
  try { body = await req.json() } catch { body = {} }
  const batchSize = Math.min(Math.max(body.batchSize ?? 50, 1), 100)

  const supabase = getUserClient(req)

  let userId: string
  try { userId = await requireUserId(supabase) }
  catch { return jsonResponse({ error: 'Unauthorized' }, 401) }

  // Pull the next batch of notes needing (re)embedding (RLS-scoped).
  const { data: rows, error: rpcErr } = await supabase
    .rpc('notes_needing_embedding', { batch_size: batchSize })
  if (rpcErr) return jsonResponse({ error: rpcErr.message }, 500)

  const notes = (rows ?? []) as { id: string; content: string; mini_notes: string | null }[]
  if (notes.length === 0) {
    return jsonResponse({ done: true, embedded: 0, remaining: 0, costUsd: 0 })
  }

  const inputs = notes.map(n => (n.mini_notes ? `${n.content}\n\n${n.mini_notes}` : n.content))

  const voyageRes = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${voyageKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ input: inputs, model: VOYAGE_MODEL, input_type: 'document' })
  })

  if (!voyageRes.ok) {
    return jsonResponse({ error: `Voyage ${voyageRes.status}: ${await voyageRes.text()}` }, 502)
  }

  const voyageData = await voyageRes.json()
  const data = (voyageData.data ?? []) as { embedding: number[]; index: number }[]
  // Voyage returns results in input order, but map by reported index defensively.
  const byIndex = new Map<number, number[]>()
  for (const d of data) byIndex.set(d.index, d.embedding)

  let embedded = 0
  for (let i = 0; i < notes.length; i++) {
    const emb = byIndex.get(i) ?? data[i]?.embedding
    if (!emb) continue
    // The stamp_embedded_at trigger sets embedded_at = now() on this write.
    const { error: updErr } = await supabase
      .from('notes')
      .update({ embedding: emb as unknown as string })
      .eq('id', notes[i].id)
    if (!updErr) embedded++
  }

  const tokens: number = voyageData.usage?.total_tokens ?? 0
  const costUsd = (tokens * VOYAGE_INPUT_PRICE_PER_M) / 1_000_000
  if (tokens > 0) {
    await supabase.from('ai_usage').insert({
      user_id: userId,
      model: VOYAGE_MODEL,
      operation: 'embed-notes-batch',
      input_tokens: tokens,
      output_tokens: 0,
      cost_usd: costUsd
    })
  }

  const { data: remainingCount } = await supabase.rpc('count_notes_needing_embedding')
  const remaining = typeof remainingCount === 'number' ? remainingCount : 0

  return jsonResponse({ done: remaining === 0, embedded, remaining, costUsd })
})
