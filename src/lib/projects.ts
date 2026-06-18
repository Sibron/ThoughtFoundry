import { supabase } from './supabase'

export type ProjectStatus = 'exploring' | 'active' | 'dormant' | 'archived'

export interface BookProject {
  id: string
  user_id: string
  title: string
  core_question: string
  description: string | null
  status: ProjectStatus
  created_at: string
  updated_at: string
}

export interface BookProjectInsert {
  title: string
  core_question: string
  description?: string
  status?: ProjectStatus
}

export const BOOK_STATUSES: Record<ProjectStatus, { label: string; color: string }> = {
  exploring: { label: 'Verkennend',    color: '#B8956A' },
  active:    { label: 'Actief',        color: '#6B8E7F' },
  dormant:   { label: 'Slapend',       color: '#8B7D68' },
  archived:  { label: 'Gearchiveerd',  color: '#54595F' },
}

export async function fetchProjects(): Promise<BookProject[]> {
  const { data, error } = await supabase
    .from('book_projects')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as BookProject[]
}

export async function fetchProject(id: string): Promise<BookProject | null> {
  const { data, error } = await supabase.from('book_projects').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return (data ?? null) as BookProject | null
}

export async function createProject(input: BookProjectInsert): Promise<BookProject> {
  const { data: userData } = await supabase.auth.getUser()
  const userId = userData.user?.id
  if (!userId) throw new Error('Niet aangemeld')

  const { data, error } = await supabase
    .from('book_projects')
    .insert({
      user_id: userId,
      title: input.title,
      core_question: input.core_question,
      description: input.description ?? null,
      status: input.status ?? 'exploring'
    })
    .select()
    .single()
  if (error) throw error
  return data as BookProject
}

export async function updateProject(
  id: string,
  input: Partial<BookProjectInsert>
): Promise<BookProject> {
  const { data, error } = await supabase
    .from('book_projects')
    .update(input)
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data as BookProject
}

export async function deleteProject(id: string): Promise<void> {
  const { error } = await supabase.from('book_projects').delete().eq('id', id)
  if (error) throw error
}

export async function fetchProjectNoteIds(projectId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('note_book_projects')
    .select('note_id')
    .eq('project_id', projectId)
  if (error) throw error
  return (data ?? []).map((r: { note_id: string }) => r.note_id)
}

export async function fetchNoteProjectIds(noteId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('note_book_projects')
    .select('project_id')
    .eq('note_id', noteId)
  if (error) throw error
  return (data ?? []).map((r: { project_id: string }) => r.project_id)
}

export async function setNoteProjects(noteId: string, projectIds: string[]): Promise<void> {
  const { data: userData } = await supabase.auth.getUser()
  const userId = userData.user?.id
  if (!userId) throw new Error('Niet aangemeld')

  await supabase.from('note_book_projects').delete().eq('note_id', noteId)
  if (projectIds.length === 0) return

  const rows = projectIds.map(pid => ({ note_id: noteId, project_id: pid, user_id: userId }))
  const { error } = await supabase.from('note_book_projects').insert(rows)
  if (error) throw error
}
