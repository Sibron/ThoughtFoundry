import { supabase } from './supabase'

export interface NoteLink {
  id: string
  user_id: string
  source_id: string
  target_id: string
  reason: string | null
  created_at: string
}

export async function fetchLinks(): Promise<NoteLink[]> {
  const { data, error } = await supabase.from('note_links').select('*')
  if (error) throw error
  return (data ?? []) as NoteLink[]
}

export async function fetchLinksForNote(noteId: string): Promise<NoteLink[]> {
  const { data, error } = await supabase
    .from('note_links')
    .select('*')
    .or(`source_id.eq.${noteId},target_id.eq.${noteId}`)
  if (error) throw error
  return (data ?? []) as NoteLink[]
}

export async function createLink(input: { sourceId: string; targetId: string; reason?: string }): Promise<NoteLink> {
  if (input.sourceId === input.targetId) throw new Error('Een nota kan niet aan zichzelf gelinkt worden.')

  const { data: userData } = await supabase.auth.getUser()
  const userId = userData.user?.id
  if (!userId) throw new Error('Niet aangemeld')

  const { data, error } = await supabase
    .from('note_links')
    .insert({
      user_id: userId,
      source_id: input.sourceId,
      target_id: input.targetId,
      reason: input.reason ?? null
    })
    .select()
    .single()
  if (error) throw error
  return data as NoteLink
}

export async function deleteLink(id: string): Promise<void> {
  const { error } = await supabase.from('note_links').delete().eq('id', id)
  if (error) throw error
}
