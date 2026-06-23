// Lexical similarity — a no-embeddings stand-in for semantic search.
//
// The app's pgvector/Voyage stack is dormant (no embeddings are ever generated),
// so "semantic" behaviour here is approximated with word- and tag-overlap. This
// is intentionally cheap: it runs client-side over a capped pool of notes, which
// is plenty fast at single-user scale (hundreds–low thousands of notes).
//
// Scoring favours shared tags and title words over body words, mirroring how a
// human skims for relatedness.

import type { Note } from './notes'

/** Fields we actually read for scoring — keeps callers free to pass partials. */
export type SimNote = Pick<Note, 'id' | 'content' | 'ai_title' | 'ai_summary' | 'tags'>
  & Partial<Pick<Note, 'core_idea'>>

// Longer Dutch function words that survive the length filter but carry no signal.
const STOPWORDS = new Set([
  'deze', 'dit', 'dat', 'zijn', 'wordt', 'worden', 'hebben', 'heeft', 'omdat',
  'terwijl', 'echter', 'daarom', 'waarbij', 'waardoor', 'waarom', 'welke',
  'maar', 'want', 'dus', 'toch', 'ook', 'nog', 'wel', 'niet', 'meer', 'naar',
  'over', 'door', 'voor', 'tussen', 'tegen', 'zonder', 'binnen', 'buiten',
  'wordt', 'kunnen', 'moeten', 'zullen', 'zouden', 'worden', 'wordt', 'iets',
  'iemand', 'altijd', 'nooit', 'soms', 'vaak', 'heel', 'erg', 'zeer', 'jouw',
  'mijn', 'haar', 'hun', 'onze', 'jullie', 'zelf', 'elke', 'alle', 'wordt'
])

/** Lowercase → strip punctuation → drop short/stopword tokens → unique set. */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of text.toLowerCase().replace(/[^a-z0-9À-ɏ\s]/g, ' ').split(/\s+/)) {
    if (w.length > 3 && !STOPWORDS.has(w)) out.add(w)
  }
  return out
}

/** Tokens that describe a note: title + summary + core idea + tags + capped body. */
export function noteTokens(n: SimNote): Set<string> {
  const parts = [
    n.ai_title ?? '',
    n.ai_summary ?? '',
    n.core_idea ?? '',
    (n.tags ?? []).join(' '),
    n.content.slice(0, 600)
  ]
  return tokenize(parts.join(' '))
}

function tagSet(n: SimNote): Set<string> {
  return new Set((n.tags ?? []).map(t => t.toLowerCase().trim()).filter(Boolean))
}

function sharedCount(a: Set<string>, b: Set<string>): number {
  let c = 0
  for (const x of a) if (b.has(x)) c++
  return c
}

export interface Scored<T> { note: T; score: number }

/**
 * Rank candidates by similarity to a target note. A shared tag is worth more
 * than a shared word (TAG_WEIGHT), since tags are deliberate. Notes with no
 * overlap are dropped.
 */
export function rankBySimilarity<T extends SimNote>(
  target: SimNote,
  candidates: T[],
  limit = 5
): Scored<T>[] {
  const TAG_WEIGHT = 3
  const tTokens = noteTokens(target)
  const tTags = tagSet(target)
  if (tTokens.size === 0 && tTags.size === 0) return []

  return candidates
    .map(note => {
      const wordOverlap = sharedCount(tTokens, noteTokens(note))
      const tagOverlap = sharedCount(tTags, tagSet(note))
      return { note, score: wordOverlap + tagOverlap * TAG_WEIGHT }
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/**
 * Rank notes by relevance to a free-text query. Hits in the title or tags weigh
 * more than body hits, and an exact substring of the whole query is a strong
 * signal. Returns every note, scored — so callers can keep server ordering for
 * ties without losing recall.
 */
export function rankByQuery<T extends SimNote>(query: string, notes: T[]): Scored<T>[] {
  const qTokens = [...tokenize(query)]
  const phrase = query.trim().toLowerCase()
  return notes
    .map(note => {
      const title = (note.ai_title ?? '').toLowerCase()
      const summary = (note.ai_summary ?? '').toLowerCase()
      const tags = (note.tags ?? []).join(' ').toLowerCase()
      const body = note.content.toLowerCase()
      let score = 0
      for (const t of qTokens) {
        if (title.includes(t)) score += 4
        if (tags.includes(t)) score += 3
        if (summary.includes(t)) score += 2
        if (body.includes(t)) score += 1
      }
      if (phrase.length > 2) {
        if (title.includes(phrase)) score += 6
        else if (body.includes(phrase) || summary.includes(phrase)) score += 3
      }
      return { note, score }
    })
    .sort((a, b) => b.score - a.score)
}

export interface SurprisingPair {
  a: SimNote
  b: SimNote
  score: number
}

/**
 * Find two notes that look related (high word/tag overlap) yet are NOT linked
 * and share NO theme — the kind of cross-theme bridge that sparks a new idea.
 * `linkedPairs` holds undirected "id1|id2" keys (smaller id first); `themeMap`
 * maps note id → set of theme ids. Pure client-side, O(n²) over a small sample.
 */
export function findSurprisingPair(
  notes: SimNote[],
  linkedPairs: Set<string>,
  themeMap: Map<string, Set<string>>,
  minScore = 4
): SurprisingPair | null {
  // Cap the working set so the O(n²) scan stays snappy.
  const pool = notes.slice(0, 80)
  const tokens = new Map<string, Set<string>>()
  const tags = new Map<string, Set<string>>()
  for (const n of pool) { tokens.set(n.id, noteTokens(n)); tags.set(n.id, tagSet(n)) }

  const candidates: SurprisingPair[] = []
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i], b = pool[j]
      if (linkedPairs.has(pairKey(a.id, b.id))) continue
      if (shareTheme(themeMap.get(a.id), themeMap.get(b.id))) continue
      const score =
        sharedCount(tokens.get(a.id)!, tokens.get(b.id)!) +
        sharedCount(tags.get(a.id)!, tags.get(b.id)!) * 3
      if (score >= minScore) candidates.push({ a, b, score })
    }
  }
  if (candidates.length === 0) return null
  // Surface among the strongest, but with a little randomness so repeated taps
  // don't always show the same pair.
  candidates.sort((x, y) => y.score - x.score)
  const top = candidates.slice(0, 8)
  return top[Math.floor(Math.random() * top.length)]
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

function shareTheme(a?: Set<string>, b?: Set<string>): boolean {
  if (!a || !b) return false
  for (const x of a) if (b.has(x)) return true
  return false
}
