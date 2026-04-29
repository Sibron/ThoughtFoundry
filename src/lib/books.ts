import { supabase } from './supabase'

export interface Book {
  id: string
  user_id: string
  title: string
  intro: string | null
  chapter_ids: string[]
  created_at: string
  updated_at: string
}

export async function fetchBooks(): Promise<Book[]> {
  const { data, error } = await supabase
    .from('books')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as Book[]
}

export async function fetchBook(id: string): Promise<Book | null> {
  const { data, error } = await supabase.from('books').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return (data ?? null) as Book | null
}

export async function createBook(input: { title: string; intro?: string }): Promise<Book> {
  const { data: userData } = await supabase.auth.getUser()
  const userId = userData.user?.id
  if (!userId) throw new Error('Niet aangemeld')

  const { data, error } = await supabase
    .from('books')
    .insert({
      user_id: userId,
      title: input.title,
      intro: input.intro ?? null,
      chapter_ids: []
    })
    .select()
    .single()
  if (error) throw error
  return data as Book
}

export async function updateBook(
  id: string,
  input: Partial<Pick<Book, 'title' | 'intro' | 'chapter_ids'>>
): Promise<Book> {
  const { data, error } = await supabase
    .from('books')
    .update(input)
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data as Book
}

export async function deleteBook(id: string): Promise<void> {
  const { error } = await supabase.from('books').delete().eq('id', id)
  if (error) throw error
}
