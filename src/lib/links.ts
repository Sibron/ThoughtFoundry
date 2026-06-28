import { supabase, fetchAllRows } from './supabase'

export type LinkType = 'builds_on' | 'contradicts' | 'example_of' | 'contrasts' | 'applies_to' | 'related'

export const LINK_TYPE_LABELS: Record<LinkType, string> = {
  builds_on:   'Bouwt voort op',
  contradicts: 'Weerspreekt',
  example_of:  'Voorbeeld van',
  contrasts:   'Contrasteert met',
  applies_to:  'Past toe op',
  related:     'Verwant aan',
}

export interface NoteLink {
  id: string
  user_id: string
  source_id: string
  target_id: string
  type: LinkType
  reason: string | null
  created_at: string
}

export async function fetchLinks(): Promise<NoteLink[]> {
  // Paged so the graph never silently drops links past the 1000-row default.
  return fetchAllRows<NoteLink>((from, to) =>
    supabase.from('note_links').select('*').order('id', { ascending: true }).range(from, to)
  )
}

export async function fetchLinksForNote(noteId: string): Promise<NoteLink[]> {
  const { data, error } = await supabase
    .from('note_links')
    .select('*')
    .or(`source_id.eq.${noteId},target_id.eq.${noteId}`)
  if (error) throw error
  return (data ?? []) as NoteLink[]
}

export async function createLink(input: {
  sourceId: string
  targetId: string
  type?: LinkType
  reason?: string
}): Promise<NoteLink> {
  if (input.sourceId === input.targetId) throw new Error('Een nota kan niet aan zichzelf gelinkt worden.')

  const { data: userData } = await supabase.auth.getUser()
  const userId = userData.user?.id
  if (!userId) throw new Error('Niet aangemeld')

  // A link is conceptually undirected for the purpose of "are these two notes
  // connected?". The unique index only covers (source_id, target_id), so guard
  // against the reverse direction here to avoid a visible duplicate. If a link
  // already exists either way, return it instead of creating a second row.
  const { data: existing } = await supabase
    .from('note_links')
    .select('*')
    .or(
      `and(source_id.eq.${input.sourceId},target_id.eq.${input.targetId}),` +
      `and(source_id.eq.${input.targetId},target_id.eq.${input.sourceId})`
    )
    .limit(1)
    .maybeSingle()
  if (existing) return existing as NoteLink

  const { data, error } = await supabase
    .from('note_links')
    .insert({
      user_id: userId,
      source_id: input.sourceId,
      target_id: input.targetId,
      type: input.type ?? 'related',
      reason: input.reason ?? null
    })
    .select()
    .single()
  if (error) throw error
  return data as NoteLink
}

export async function updateLink(
  id: string,
  input: { type?: LinkType; reason?: string | null }
): Promise<NoteLink> {
  const { data, error } = await supabase
    .from('note_links')
    .update(input)
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data as NoteLink
}

export async function deleteLink(id: string): Promise<void> {
  const { error } = await supabase.from('note_links').delete().eq('id', id)
  if (error) throw error
}
