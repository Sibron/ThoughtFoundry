import { supabase, fetchAllRows } from './supabase'

export interface Theme {
  id: string
  user_id: string
  name: string
  description: string | null
  color: string
  parent_id: string | null
  created_at: string
  is_sensitive: boolean
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

export async function fetchNoteIdsByThemes(themeIds: string[], excludeNoteId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('note_themes')
    .select('note_id')
    .in('theme_id', themeIds)
    .neq('note_id', excludeNoteId)
    .limit(10)
  if (error) throw error
  return (data ?? []).map((r: { note_id: string }) => r.note_id)
}

export async function updateTheme(id: string, input: Partial<Pick<Theme, 'name' | 'description' | 'color' | 'is_sensitive'>>): Promise<Theme> {
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

// ── note_themes ─────────────────────────────────────────────────────────────

export async function fetchThemesForNote(noteId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('note_themes')
    .select('theme_id')
    .eq('note_id', noteId)
  if (error) throw error
  return (data ?? []).map((r: { theme_id: string }) => r.theme_id)
}

export async function fetchAllNoteThemes(): Promise<{ note_id: string; theme_id: string }[]> {
  // Paged: a user can easily have >1000 note↔theme links (the default cap),
  // and truncating them undercounts themes and hides notes from the graph.
  return fetchAllRows<{ note_id: string; theme_id: string }>((from, to) =>
    supabase.from('note_themes').select('note_id, theme_id')
      .order('note_id', { ascending: true }).order('theme_id', { ascending: true }).range(from, to)
  )
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

/**
 * Additive counterpart to `setThemesForNote`: adds links without removing any
 * existing ones. Used by batch re-processing so AI-matched themes are added on
 * top of the curated import links instead of replacing them.
 */
export async function addThemesForNote(noteId: string, themeIds: string[]): Promise<void> {
  if (themeIds.length === 0) return
  const { data: userData } = await supabase.auth.getUser()
  const userId = userData.user?.id
  if (!userId) throw new Error('Niet aangemeld')

  const rows = themeIds.map(theme_id => ({ note_id: noteId, theme_id, user_id: userId }))
  const { error } = await supabase
    .from('note_themes')
    .upsert(rows, { onConflict: 'note_id,theme_id', ignoreDuplicates: true })
  if (error) throw error
}
