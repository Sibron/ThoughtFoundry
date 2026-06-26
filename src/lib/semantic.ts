// Semantic linking — the embeddings-powered counterpart of similarity.ts.
//
// These call pgvector RPCs (note_neighbors, semantic_bridges) which cost ZERO
// AI tokens — the embeddings are generated once (Voyage), and every lookup after
// that is pure database math. Callers should fall back to the lexical helpers in
// similarity.ts when hasEmbeddings() is false (no Voyage key / not backfilled).

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
