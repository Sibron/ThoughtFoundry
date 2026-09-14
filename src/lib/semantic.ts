// Semantic linking — the embeddings-powered counterpart of similarity.ts.
//
// These call pgvector RPCs (note_neighbors, semantic_bridges) which cost ZERO
// AI tokens — embeddings are generated once by the Supabase Edge runtime's
// built-in gte-small model (384 dims, free, no API key), and every lookup after
// that is pure database math. Callers should fall back to the lexical helpers
// in similarity.ts when hasEmbeddings() is false (backfill not run yet).

import { supabase } from './supabase'

// ── Similarity thresholds ───────────────────────────────────────────────────
// gte-small cosine similarity, calibrated by eye on real notes. These were
// loose numbers scattered across six files (0.45 in three, 0.72 in three, the
// band endpoints in two more), which made "retune the band" — issue #36 — a
// hunt rather than an edit. One place now.

/** Below this a "find me notes like X" hit is too thin to show. */
export const MATCH_MIN_SIMILARITY = 0.45

/** At or above this a pair reads as plainly related rather than surprising. */
export const STRONG_SIMILARITY = 0.72

/** Near-duplicates start here; a bridge above it tells the user nothing new. */
export const NEAR_DUPLICATE_SIMILARITY = 0.85

/** Below this the relation is too thin to judge. */
export const BRIDGE_MIN_SIMILARITY = 0.55

/**
 * Upper end of the default bridge band. Deliberately 0.82 and NOT
 * NEAR_DUPLICATE_SIMILARITY: it mirrors the `band_hi` default baked into the
 * semantic_bridges SQL, so a caller that passes no band gets the same result
 * from the client as from psql. Retuning either means retuning both — see #36.
 */
export const BRIDGE_MAX_SIMILARITY = 0.82

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
 * theme — related, not near-duplicate.
 */
export async function fetchSemanticBridges(
  opts: { bandLo?: number; bandHi?: number; max?: number } = {}
): Promise<BridgePair[]> {
  const { data, error } = await supabase.rpc('semantic_bridges', {
    band_lo: opts.bandLo ?? BRIDGE_MIN_SIMILARITY,
    band_hi: opts.bandHi ?? BRIDGE_MAX_SIMILARITY,
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

// ── Suggestion dismissals ───────────────────────────────────────────────────
// Rejected pairs are persisted (normalized a < b, like semantic_bridges) so a
// dismissal on one device sticks on every device.

function normalizePair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

/** "a|b" keys of every pair the user rejected. */
export async function fetchDismissedPairKeys(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('connection_dismissals')
    .select('a_id, b_id')
  if (error) throw error
  return new Set((data ?? []).map((r: { a_id: string; b_id: string }) => `${r.a_id}|${r.b_id}`))
}

export async function dismissPair(a: string, b: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser()
  const userId = userData.user?.id
  if (!userId) throw new Error('Niet aangemeld')
  const [aId, bId] = normalizePair(a, b)
  const { error } = await supabase
    .from('connection_dismissals')
    .upsert({ user_id: userId, a_id: aId, b_id: bId }, { onConflict: 'user_id,a_id,b_id' })
  if (error) throw error
}
