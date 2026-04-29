import { supabase } from './supabase'

export interface Theme {
  id: string
  user_id: string
  name: string
  description: string | null
  color: string
  created_at: string
}

export async function fetchThemes(): Promise<Theme[]> {
  const { data, error } = await supabase
    .from('themes')
    .select('*')
    .order('name', { ascending: true })
  if (error) throw error
  return (data ?? []) as Theme[]
}

export async function createTheme(input: { name: string; description?: string; color?: string }): Promise<Theme> {
  const { data: userData } = await supabase.auth.getUser()
  const userId = userData.user?.id
  if (!userId) throw new Error('Niet aangemeld')

  const { data, error } = await supabase
    .from('themes')
    .insert({
      user_id: userId,
      name: input.name,
      description: input.description ?? null,
      color: input.color ?? '#3AC48D'
    })
    .select()
    .single()
  if (error) throw error
  return data as Theme
}

export async function updateTheme(id: string, input: Partial<Pick<Theme, 'name' | 'description' | 'color'>>): Promise<Theme> {
  const { data, error } = await supabase
    .from('themes')
    .update(input)
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data as Theme
}

export async function deleteTheme(id: string): Promise<void> {
  const { error } = await supabase.from('themes').delete().eq('id', id)
  if (error) throw error
}

export async function mergeThemes(sourceId: string, targetId: string): Promise<void> {
  if (sourceId === targetId) return
  const { error } = await supabase.rpc('merge_themes', { p_source: sourceId, p_target: targetId })
  if (error) throw error
}

// ── note_themes ─────────────────────────────────────────────────────────────

export async function fetchThemesForNote(noteId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('note_themes')
    .select('theme_id')
    .eq('note_id', noteId)
  if (error) throw error
  return (data ?? []).map(r => r.theme_id as string)
}

export async function fetchAllNoteThemes(): Promise<{ note_id: string; theme_id: string }[]> {
  const { data, error } = await supabase.from('note_themes').select('note_id, theme_id')
  if (error) throw error
  return (data ?? []) as { note_id: string; theme_id: string }[]
}

export async function setThemesForNote(noteId: string, themeIds: string[]): Promise<void> {
  const { data: userData } = await supabase.auth.getUser()
  const userId = userData.user?.id
  if (!userId) throw new Error('Niet aangemeld')

  // Replace strategy: delete + insert. Cheap because it's per-note.
  const { error: delErr } = await supabase.from('note_themes').delete().eq('note_id', noteId)
  if (delErr) throw delErr

  if (themeIds.length === 0) return

  const rows = themeIds.map(theme_id => ({ note_id: noteId, theme_id, user_id: userId }))
  const { error: insErr } = await supabase.from('note_themes').insert(rows)
  if (insErr) throw insErr
}
