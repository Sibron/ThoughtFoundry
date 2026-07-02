import { supabase } from './supabase'
import { getPersona } from './persona'
import { updateNote, fetchNoteById } from './notes'
import { addThemesForNote } from './themes'
import { createLink, type LinkType } from './links'

export interface NoteSuggestion {
  title: string
  summary: string
  tags: string[]
  matched_theme_ids: string[]
  new_themes: { name: string; description: string }[]
  related_note_ids: string[]
  section: string
}

export interface ChapterPlan {
  title: string
  summary: string
  sections: { heading: string; intent: string; note_ids: string[] }[]
}

export interface AIUsage {
  inputTokens: number
  outputTokens: number
  costUsd: number
}

/**
 * Thrown when the server-side budget guard (functions/_shared/budget.ts)
 * blocks a call with HTTP 402. Callers show a confirm and may retry the same
 * call with `overrideCap: true` in the body.
 */
export class AiBudgetError extends Error {
  spend: number
  cap: number
  constructor(spend: number, cap: number) {
    super(`Maandbudget bereikt ($${spend.toFixed(2)} van $${cap.toFixed(2)})`)
    this.name = 'AiBudgetError'
    this.spend = spend
    this.cap = cap
  }
}

async function invoke<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const persona = getPersona()
  const fullBody = persona ? { ...body, persona } : body
  const { data, error } = await supabase.functions.invoke(name, { body: fullBody })
  if (error) {
    // Non-2xx: the SDK stashes the raw Response on error.context. Pull the
    // payload out so a 402 budget block surfaces as a typed AiBudgetError.
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx.json === 'function') {
      const payload = await ctx.json().catch(() => null) as
        { error?: string; spend?: number; cap?: number } | null
      if (payload?.error === 'ai_budget_exceeded') {
        throw new AiBudgetError(payload.spend ?? 0, payload.cap ?? 0)
      }
      if (payload?.error) throw new Error(payload.error)
    }
    throw new Error(error.message ?? 'Edge function error')
  }
  if (data && typeof data === 'object' && 'error' in data) {
    throw new Error(String((data as { error: string }).error))
  }
  return data as T
}

export async function processNote(
  noteId: string,
  model?: 'claude-haiku-4-5' | 'claude-sonnet-4-6',
  overrideCap?: boolean
): Promise<{ suggestion: NoteSuggestion; usage: AIUsage }> {
  const body: Record<string, unknown> = { noteId }
  if (model) body['model'] = model
  if (overrideCap) body['overrideCap'] = true
  return invoke('process-note', body)
}

export async function embedNote(noteId: string): Promise<{ ok: true; dimensions: number; costUsd: number }> {
  return invoke('embed-note', { noteId })
}

/**
 * Embed the next batch of notes that still need a gte-small embedding. Drives
 * the resumable backfill loop in Settings — each call re-queries the cursor, so
 * the run resumes after a refresh. Returns `done` when nothing is left.
 */
export async function embedNotesBatch(
  batchSize = 50
): Promise<{ done: boolean; embedded: number; remaining: number; costUsd: number }> {
  return invoke('embed-notes-batch', { batchSize })
}

/**
 * Re-run one note through the real process-note AI and apply the result in place
 * (auto-accept), so notes that were bulk-imported with a heuristic title/summary
 * become genuinely AI-processed — equivalent to a natively processed note.
 *
 * Non-destructive by design: overwrites only the AI-derived text fields
 * (title/summary/section) and stamps processed_at; merges tags with the existing
 * ones; adds AI-matched themes and related-note links additively (never removes
 * curated import links); and leaves content / note_type / core_idea / use_for /
 * source_* untouched. New theme suggestions are intentionally skipped in batch.
 */
export async function reprocessNote(noteId: string): Promise<AIUsage> {
  const [{ suggestion, usage }, current] = await Promise.all([
    processNote(noteId, 'claude-haiku-4-5'),
    fetchNoteById(noteId),
  ])

  const mergedTags = [...new Set([...(current?.tags ?? []), ...(suggestion.tags ?? [])])].slice(0, 5)

  await updateNote(noteId, {
    ai_title: suggestion.title || null,
    ai_summary: suggestion.summary || null,
    section: suggestion.section || null,
    tags: mergedTags,
    processed_at: new Date().toISOString(),
  })

  // matched_theme_ids are already validated against the user's existing themes
  // by the edge function — add them on top of the curated links.
  if (suggestion.matched_theme_ids?.length) {
    await addThemesForNote(noteId, suggestion.matched_theme_ids)
  }

  for (const targetId of suggestion.related_note_ids ?? []) {
    try {
      await createLink({ sourceId: noteId, targetId, type: 'related', reason: 'AI-herverwerking' })
    } catch {
      // self-link guard or duplicate — safe to ignore
    }
  }

  // Keep the semantic substrate current: embed the freshly processed note so it
  // becomes findable by note_neighbors / semantic_bridges. Best-effort — an
  // embedding failure must never break reprocessing.
  void embedNote(noteId).catch(() => {})

  return usage
}

export interface EnrichedLink {
  a_id: string
  b_id: string
  keep: boolean
  type: LinkType
  reason: string
}

/**
 * Type + justify a batch of pre-filtered candidate pairs in ONE Haiku call.
 * The model only sees the handful of pairs you pass (never the whole corpus),
 * so this stays cheap. Nothing is persisted — the caller reviews and links.
 */
export async function enrichLinks(
  pairs: { aId: string; bId: string }[],
  opts: { model?: 'claude-haiku-4-5' | 'claude-sonnet-4-6'; overrideCap?: boolean } = {}
): Promise<{ links: EnrichedLink[]; usage: AIUsage }> {
  return invoke('enrich-links', { pairs, ...opts })
}

export async function generateChapter(input: {
  noteIds: string[]
  themeId?: string
  angle?: string
  model?: 'claude-sonnet-4-6' | 'claude-haiku-4-5' | 'claude-opus-4-7'
  overrideCap?: boolean
}): Promise<{ plan: ChapterPlan; usage: AIUsage }> {
  const body: Record<string, unknown> = { noteIds: input.noteIds }
  if (input.themeId)     body['themeId']     = input.themeId
  if (input.angle)       body['angle']       = input.angle
  if (input.model)       body['model']       = input.model
  if (input.overrideCap) body['overrideCap'] = true
  return invoke('generate-chapter', body)
}

export interface SparkResult {
  synthesis: string | null
  matchCount: number
  retrieval?: 'semantisch' | 'lexicaal'
  message?: string
  usage?: AIUsage
}

export async function runSpark(input: {
  query: string
  outputType: 'reflectie' | 'coaching' | 'beslissing' | 'blogdraft' | 'gesprekskader'
  model?: 'claude-haiku-4-5' | 'claude-sonnet-4-6'
  overrideCap?: boolean
}): Promise<SparkResult> {
  return invoke('spark', input as unknown as Record<string, unknown>)
}

export interface DenkpartnerQuestion {
  question: string
  context: string
}

export interface DenkpartnerResult {
  questions: DenkpartnerQuestion[]
  noteCount?: number
  message?: string
  usage?: AIUsage
}

export async function runDenkpartner(input: {
  scope: 'all' | 'tag' | 'theme'
  tag?: string
  themeId?: string
  model?: 'claude-haiku-4-5' | 'claude-sonnet-4-6'
  overrideCap?: boolean
}): Promise<DenkpartnerResult> {
  return invoke('denkpartner', input as unknown as Record<string, unknown>)
}

export interface Cluster {
  name: string
  implicit_theme: string
  missing_note: string
  note_ids: string[]
}

export interface ClustersResult {
  clusters: Cluster[]
  noteCount?: number
  message?: string
  usage?: AIUsage
}

export async function detectClusters(
  opts: { model?: 'claude-haiku-4-5' | 'claude-sonnet-4-6'; overrideCap?: boolean } = {}
): Promise<ClustersResult> {
  return invoke('detect-clusters', { ...opts })
}

/**
 * Gap-analyse for a book project: white spots, missing counter-arguments,
 * unelaborated questions, corpus risk. Goes through the same invoke wrapper
 * as every other AI feature (persona injection + budget error mapping).
 */
export async function runGapAnalysis(input: {
  projectId: string
  model?: 'claude-haiku-4-5' | 'claude-sonnet-4-6'
  overrideCap?: boolean
}): Promise<{ analysis: string; usage: AIUsage }> {
  return invoke('gap-analysis', input as unknown as Record<string, unknown>)
}
