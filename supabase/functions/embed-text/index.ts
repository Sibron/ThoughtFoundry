// Embed arbitrary text with the built-in gte-small model (384-dim) WITHOUT
// persisting anything. Powers query-by-meaning: semantic search, "vind
// verwante gedachten" while writing, and note-picker suggestions — the client
// feeds the returned vector to the match_notes RPC. Free (no API key, no
// tokens), so it writes no ai_usage row: search-as-you-think would spam the
// cost log with $0 entries.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { getUserClient, requireUserId } from '../_shared/supabase.ts'

// Supabase.ai is provided by the edge runtime and isn't part of Deno's types.
// deno-lint-ignore no-explicit-any
declare const Supabase: any

interface EmbedTextRequest {
  text: string
}

const EMBED_MODEL = 'gte-small' // 384-dim, runs in-runtime

// Load the model ONCE at module scope (reused across invocations). Creating it
// per-request reloads the model into the request's budget and can trip the
// CPU/memory limit (HTTP 546).
const session = new Supabase.ai.Session(EMBED_MODEL)

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')   return jsonResponse({ error: 'Method not allowed' }, 405)

  let body: EmbedTextRequest
  try { body = await req.json() } catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }
  const text = body.text?.trim()
  if (!text) return jsonResponse({ error: 'text required' }, 400)

  const supabase = getUserClient(req)
  try { await requireUserId(supabase) }
  catch { return jsonResponse({ error: 'Unauthorized' }, 401) }

  let embedding: number[]
  try {
    // gte-small has a 512-token context; clip long input rather than erroring.
    embedding = await session.run(text.slice(0, 4000), { mean_pool: true, normalize: true }) as number[]
  } catch (err) {
    return jsonResponse({ error: `Embedding failed: ${err instanceof Error ? err.message : String(err)}` }, 502)
  }
  if (!Array.isArray(embedding) || embedding.length === 0) {
    return jsonResponse({ error: 'No embedding produced' }, 502)
  }

  return jsonResponse({ embedding, dimensions: embedding.length })
})
