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
  title: string
  summary: string | null
  outline: ChapterSection[]
  note_ids: string[]
  created_at: string
  updated_at: string
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
      title: input.title,
      summary: input.summary ?? null,
      outline: input.outline as unknown as object,
      note_ids: input.noteIds
    })
    .select()
    .single()
  if (error) throw error
  return normalize(data as unknown as Chapter)
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
