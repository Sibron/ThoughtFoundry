import { supabase } from './supabase'
import { getPersona } from './persona'

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

async function invoke<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const persona = getPersona()
  const fullBody = persona ? { ...body, persona } : body
  const { data, error } = await supabase.functions.invoke(name, { body: fullBody })
  if (error) throw new Error(error.message ?? 'Edge function error')
  if (data && typeof data === 'object' && 'error' in data) {
    throw new Error(String((data as { error: string }).error))
  }
  return data as T
}

export async function processNote(
  noteId: string,
  model?: 'claude-haiku-4-5' | 'claude-sonnet-4-6'
): Promise<{ suggestion: NoteSuggestion; usage: AIUsage }> {
  const body: Record<string, unknown> = { noteId }
  if (model) body['model'] = model
  return invoke('process-note', body)
}

export async function embedNote(noteId: string): Promise<{ ok: true; dimensions: number; costUsd: number }> {
  return invoke('embed-note', { noteId })
}

export async function generateChapter(input: {
  noteIds: string[]
  themeId?: string
  angle?: string
  model?: 'claude-sonnet-4-6' | 'claude-haiku-4-5' | 'claude-opus-4-7'
}): Promise<{ plan: ChapterPlan; usage: AIUsage }> {
  const body: Record<string, unknown> = { noteIds: input.noteIds }
  if (input.themeId) body['themeId'] = input.themeId
  if (input.angle)   body['angle']   = input.angle
  if (input.model)   body['model']   = input.model
  return invoke('generate-chapter', body)
}

export interface SparkResult {
  synthesis: string | null
  matchCount: number
  message?: string
  usage?: AIUsage
}

export async function runSpark(input: {
  query: string
  outputType: 'reflectie' | 'coaching' | 'beslissing' | 'blogdraft' | 'gesprekskader'
  model?: 'claude-haiku-4-5' | 'claude-sonnet-4-6'
}): Promise<SparkResult> {
  return invoke('spark', input as Record<string, unknown>)
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
}): Promise<DenkpartnerResult> {
  return invoke('denkpartner', input as Record<string, unknown>)
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

export async function detectClusters(): Promise<ClustersResult> {
  return invoke('detect-clusters', {})
}
