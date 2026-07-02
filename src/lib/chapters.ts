import { supabase } from './supabase'

export interface ChapterSection {
  heading: string
  intent: string
  note_ids: string[]
}

export interface Chapter {
  id: string
  user_id: string
  theme_id: string | null
  project_id: string | null
  title: string
  summary: string | null
  outline: ChapterSection[]
  note_ids: string[]
  created_at: string
  updated_at: string
}

/** A real section row (schrijfstudio) — stable id, prose in content_md. */
export interface SectionRow {
  id: string
  chapter_id: string
  position: number
  heading: string
  intent: string | null
  note_ids: string[]
  content_md: string | null
  created_at: string
  updated_at: string
}

export interface SectionRevision {
  id: string
  section_id: string
  content_md: string
  label: string | null
  created_at: string
}

export async function fetchChapters(themeId?: string): Promise<Chapter[]> {
  let q = supabase.from('chapters').select('*').order('created_at', { ascending: false })
  if (themeId) q = q.eq('theme_id', themeId)
  const { data, error } = await q
  if (error) throw error
  return ((data ?? []) as unknown as Chapter[]).map(normalize)
}

export async function fetchChapter(id: string): Promise<Chapter | null> {
  const { data, error } = await supabase.from('chapters').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data ? normalize(data as unknown as Chapter) : null
}

export async function saveChapter(input: {
  themeId?: string | null
  projectId?: string | null
  title: string
  summary?: string
  outline: ChapterSection[]
  noteIds: string[]
}): Promise<Chapter> {
  const { data: userData } = await supabase.auth.getUser()
  const userId = userData.user?.id
  if (!userId) throw new Error('Niet aangemeld')

  const { data, error } = await supabase
    .from('chapters')
    .insert({
      user_id: userId,
      theme_id: input.themeId ?? null,
      project_id: input.projectId ?? null,
      title: input.title,
      summary: input.summary ?? null,
      // outline JSONB stays written for one release as the export fallback of
      // clients that haven't run the writing-studio migration yet.
      outline: input.outline as unknown as object,
      note_ids: input.noteIds
    })
    .select()
    .single()
  if (error) throw error
  const chapter = normalize(data as unknown as Chapter)

  // The studio works on real section rows; create them alongside the JSONB.
  const rows = input.outline.map((s, i) => ({
    chapter_id: chapter.id,
    user_id: userId,
    position: i,
    heading: s.heading,
    intent: s.intent || null,
    note_ids: s.note_ids
  }))
  if (rows.length > 0) {
    const { error: secErr } = await supabase.from('chapter_sections').insert(rows)
    if (secErr) throw secErr
  }
  return chapter
}

export async function deleteChapter(id: string): Promise<void> {
  const { error } = await supabase.from('chapters').delete().eq('id', id)
  if (error) throw error
}

function normalize(c: Chapter): Chapter {
  return {
    ...c,
    outline: Array.isArray(c.outline) ? c.outline : []
  }
}

// ── Sections (schrijfstudio) ────────────────────────────────────────────────

export async function fetchSections(chapterId: string): Promise<SectionRow[]> {
  const { data, error } = await supabase
    .from('chapter_sections')
    .select('*')
    .eq('chapter_id', chapterId)
    .order('position', { ascending: true })
  if (error) throw error
  return (data ?? []) as SectionRow[]
}

export async function createSection(
  chapterId: string,
  input: { position: number; heading: string; intent?: string; noteIds?: string[] }
): Promise<SectionRow> {
  const { data: userData } = await supabase.auth.getUser()
  const userId = userData.user?.id
  if (!userId) throw new Error('Niet aangemeld')

  const { data, error } = await supabase
    .from('chapter_sections')
    .insert({
      chapter_id: chapterId,
      user_id: userId,
      position: input.position,
      heading: input.heading,
      intent: input.intent ?? null,
      note_ids: input.noteIds ?? []
    })
    .select()
    .single()
  if (error) throw error
  return data as SectionRow
}

export async function updateSection(
  id: string,
  patch: Partial<Pick<SectionRow, 'position' | 'heading' | 'intent' | 'note_ids' | 'content_md'>>
): Promise<void> {
  const { error } = await supabase.from('chapter_sections').update(patch).eq('id', id)
  if (error) throw error
}

export async function deleteSection(id: string): Promise<void> {
  const { error } = await supabase.from('chapter_sections').delete().eq('id', id)
  if (error) throw error
}

/** Persist a new ordering after a move (position = array index). */
export async function saveSectionOrder(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i++) {
    const { error } = await supabase.from('chapter_sections').update({ position: i }).eq('id', ids[i])
    if (error) throw error
  }
}

// ── Revisions (snapshot-based undo, e.g. before every AI rewrite) ──────────

export async function saveRevision(sectionId: string, contentMd: string, label?: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser()
  const userId = userData.user?.id
  if (!userId) throw new Error('Niet aangemeld')
  const { error } = await supabase.from('chapter_section_revisions').insert({
    section_id: sectionId,
    user_id: userId,
    content_md: contentMd,
    label: label ?? null
  })
  if (error) throw error
}

export async function fetchRevisions(sectionId: string, limit = 15): Promise<SectionRevision[]> {
  const { data, error } = await supabase
    .from('chapter_section_revisions')
    .select('*')
    .eq('section_id', sectionId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []) as SectionRevision[]
}

// ── Aggregates for badges ("3/5 secties geschreven") ────────────────────────

export interface ChapterSectionStats {
  total: number
  written: number
  words: number
}

export async function fetchSectionStats(): Promise<Map<string, ChapterSectionStats>> {
  const { data, error } = await supabase
    .from('chapter_sections')
    .select('chapter_id, content_md')
  if (error) throw error
  const map = new Map<string, ChapterSectionStats>()
  for (const row of (data ?? []) as { chapter_id: string; content_md: string | null }[]) {
    const s = map.get(row.chapter_id) ?? { total: 0, written: 0, words: 0 }
    s.total++
    if (row.content_md?.trim()) {
      s.written++
      s.words += row.content_md.trim().split(/\s+/).filter(Boolean).length
    }
    map.set(row.chapter_id, s)
  }
  return map
}
