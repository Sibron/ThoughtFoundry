import { supabase } from './supabase'

export type SourceType = 'book' | 'article' | 'paper' | 'podcast' | 'video' | 'course' | 'other'

export interface Source {
  id: string
  user_id: string
  title: string
  author: string | null
  type: SourceType
  year: string | null
  url: string | null
  summary: string | null
  tags: string[]
  created_at: string
  updated_at: string
}

export interface SourceInsert {
  title: string
  author?: string
  type?: SourceType
  year?: string
  url?: string
  summary?: string
  tags?: string[]
}

export const SOURCE_TYPES: Record<SourceType, { label: string }> = {
  book:    { label: 'Boek' },
  article: { label: 'Artikel' },
  paper:   { label: 'Paper' },
  podcast: { label: 'Podcast' },
  video:   { label: 'Video' },
  course:  { label: 'Opleiding' },
  other:   { label: 'Anders' },
}

export const SOURCE_TYPE_ORDER: SourceType[] = [
  'book', 'article', 'paper', 'podcast', 'video', 'course', 'other'
]

export async function fetchSources(): Promise<Source[]> {
  const { data, error } = await supabase
    .from('sources')
    .select('*')
    .order('title', { ascending: true })
  if (error) throw error
  return (data ?? []) as Source[]
}

export async function fetchSource(id: string): Promise<Source | null> {
  const { data, error } = await supabase.from('sources').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return (data ?? null) as Source | null
}

export async function createSource(input: SourceInsert): Promise<Source> {
  const { data: userData } = await supabase.auth.getUser()
  const userId = userData.user?.id
  if (!userId) throw new Error('Niet aangemeld')

  const { data, error } = await supabase
    .from('sources')
    .insert({
      user_id: userId,
      title: input.title,
      author: input.author ?? null,
      type: input.type ?? 'book',
      year: input.year ?? null,
      url: input.url ?? null,
      summary: input.summary ?? null,
      tags: input.tags ?? []
    })
    .select()
    .single()
  if (error) throw error
  return data as Source
}

export async function updateSource(id: string, input: Partial<SourceInsert>): Promise<Source> {
  const { data, error } = await supabase
    .from('sources')
    .update(input)
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data as Source
}

export async function deleteSource(id: string): Promise<void> {
  const { error } = await supabase.from('sources').delete().eq('id', id)
  if (error) throw error
}
