// Semantic linking — the embeddings-powered counterpart of similarity.ts.
//
// These call pgvector RPCs (note_neighbors, semantic_bridges) which cost ZERO
// AI tokens — embeddings are generated once by the Supabase Edge runtime's
// built-in gte-small model (384 dims, free, no API key), and every lookup after
// that is pure database math. Callers should fall back to the lexical helpers
// in similarity.ts when hasEmbeddings() is false (backfill not run yet).

import { supabase } from './supabase'

export interface Neighbor {
  id: string
  ai_title: string | null
  content: string
  similarity: number
}

export interface BridgePair {
  a_id: string
  b_id: string
  similarity: number
}

/** Are there any embedded notes at all? Decides semantic vs lexical path. */
export async function hasEmbeddings(): Promise<boolean> {
  const { count, error } = await supabase
    .from('notes')
    .select('id', { count: 'exact', head: true })
    .not('embedding', 'is', null)
  if (error) return false
  return (count ?? 0) > 0
}

/** Top-k semantic neighbours of a note, excluding already-linked notes. */
export async function fetchNeighbors(noteId: string, count = 8): Promise<Neighbor[]> {
  const { data, error } = await supabase.rpc('note_neighbors', { source: noteId, match_count: count })
  if (error) throw error
  return (data ?? []) as Neighbor[]
}

/**
 * Non-obvious bridges: semantically close pairs that aren't linked and share no
 * theme. Band defaults mirror the SQL (0.55–0.82) — related, not near-duplicate.
 */
export async function fetchSemanticBridges(
  opts: { bandLo?: number; bandHi?: number; max?: number } = {}
): Promise<BridgePair[]> {
  const { data, error } = await supabase.rpc('semantic_bridges', {
    band_lo: opts.bandLo ?? 0.55,
    band_hi: opts.bandHi ?? 0.82,
    max_pairs: opts.max ?? 20
  })
  if (error) throw error
  return (data ?? []) as BridgePair[]
}

export interface MatchedNote {
  id: string
  content: string
  similarity: number
}

/**
 * Embed arbitrary text with the free in-runtime model (edge fn `embed-text`,
 * nothing persisted, zero cost). Feed the result to matchNotes for
 * query-by-meaning.
 */
export async function embedText(text: string): Promise<number[]> {
  const { data, error } = await supabase.functions.invoke('embed-text', { body: { text } })
  if (error) throw new Error(error.message ?? 'embed-text mislukt')
  const payload = data as { embedding?: number[]; error?: string } | null
  if (payload?.error) throw new Error(payload.error)
  if (!Array.isArray(payload?.embedding)) throw new Error('Geen embedding ontvangen')
  return payload.embedding
}

/** Cosine KNN over the user's embedded notes for an arbitrary query vector. */
export async function matchNotes(
  embedding: number[],
  count = 10,
  excludeId?: string
): Promise<MatchedNote[]> {
  const { data, error } = await supabase.rpc('match_notes', {
    query_embedding: embedding,
    match_count: count,
    exclude_id: excludeId ?? null
  })
  if (error) throw error
  return (data ?? []) as MatchedNote[]
}
