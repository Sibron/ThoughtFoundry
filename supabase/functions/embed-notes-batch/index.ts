// Embeds the next batch of notes that still need an embedding, using the Supabase
// Edge Runtime built-in model (gte-small, 384-dim). No external provider, no API
// key, no per-token cost. Drives a resumable client backfill loop.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { getUserClient, requireUserId } from '../_shared/supabase.ts'

// Supabase.ai is provided by the edge runtime and isn't part of Deno's types.
// deno-lint-ignore no-explicit-any
declare const Supabase: any

const EMBED_MODEL = 'gte-small' // 384-dim, runs in-runtime

// Create the model session ONCE at module scope: the model loads on worker boot
// and is reused across invocations. Creating it per-request reloads the model
// into the request's resource budget and trips the CPU/memory limit (HTTP 546).
const session = new Supabase.ai.Session(EMBED_MODEL)

// gte-small inference is CPU-heavy. Keep each invocation tiny so we stay well
// under the edge-function CPU/wall-clock limit (especially on the free plan).
// The client loops until `done`, so total throughput is unaffected.
const MAX_PER_CALL = 5

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')   return jsonResponse({ error: 'Method not allowed' }, 405)

  let body: { batchSize?: number }
  try { body = await req.json() } catch { body = {} }
  const batchSize = Math.min(Math.max(body.batchSize ?? MAX_PER_CALL, 1), MAX_PER_CALL)

  const supabase = getUserClient(req)

  let userId: string
  try { userId = await requireUserId(supabase) }
  catch { return jsonResponse({ error: 'Unauthorized' }, 401) }

  // Pull the next small batch of notes needing (re)embedding (RLS-scoped).
  const { data: rows, error: rpcErr } = await supabase
    .rpc('notes_needing_embedding', { batch_size: batchSize })
  if (rpcErr) return jsonResponse({ error: rpcErr.message }, 500)

  const notes = (rows ?? []) as { id: string; content: string; mini_notes: string | null }[]
  if (notes.length === 0) {
    return jsonResponse({ done: true, embedded: 0, remaining: 0, costUsd: 0 })
  }

  let embedded = 0
  for (const n of notes) {
    const text = n.mini_notes ? `${n.content}\n\n${n.mini_notes}` : n.content
    let emb: number[]
    try {
      emb = await session.run(text, { mean_pool: true, normalize: true }) as number[]
    } catch {
      continue
    }
    if (!Array.isArray(emb) || emb.length === 0) continue
    // The stamp_embedded_at trigger sets embedded_at = now() on this write.
    const { error: updErr } = await supabase
      .from('notes')
      .update({ embedding: emb as unknown as string })
      .eq('id', n.id)
    if (!updErr) embedded++
  }

  // Free + local, but log a zero-cost row per non-empty batch for traceability.
  if (embedded > 0) {
    await supabase.from('ai_usage').insert({
      user_id: userId,
      model: EMBED_MODEL,
      operation: 'embed-notes-batch',
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0
    })
  }

  const { data: remainingCount } = await supabase.rpc('count_notes_needing_embedding')
  const remaining = typeof remainingCount === 'number' ? remainingCount : 0

  return jsonResponse({ done: remaining === 0, embedded, remaining, costUsd: 0 })
})
