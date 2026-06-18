import { supabase } from './supabase'

export type NoteStatus = 'inbox' | 'verwerkt' | 'archief'
export type NoteType = 'fleeting' | 'question' | 'literature' | 'permanent' | 'reflection' | 'framework'

export interface Note {
  id: string
  user_id: string
  content: string
  mini_notes: string | null
  status: NoteStatus
  note_type: NoteType
  core_idea: string | null
  use_for: string | null
  source_id: string | null
  tags: string[]
  source_url: string | null
  source_title: string | null
  source_author: string | null
  ai_summary: string | null
  ai_title: string | null
  processed_at: string | null
  section: string | null
  created_at: string
  updated_at: string
}

export interface NoteInsert {
  content: string
  mini_notes?: string
  note_type?: NoteType
  core_idea?: string
  use_for?: string
  source_id?: string
  tags?: string[]
  source_url?: string
  source_title?: string
  source_author?: string
}

export interface NoteUpdate {
  content?: string
  mini_notes?: string | null
  note_type?: NoteType
  core_idea?: string | null
  use_for?: string | null
  source_id?: string | null
  source_url?: string | null
  source_title?: string | null
  source_author?: string | null
  status?: NoteStatus
  tags?: string[]
  ai_summary?: string | null
  ai_title?: string | null
  processed_at?: string | null
  section?: string | null
}

const OFFLINE_QUEUE_KEY = 'offline_queue'

export async function fetchNotes(
  page = 0,
  pageSize = 50,
  status?: NoteStatus,
  search?: string
): Promise<Note[]> {
  let q = supabase.from('notes').select('*').order('created_at', { ascending: false })
  if (status) q = q.eq('status', status)
  if (search && search.trim()) {
    const safe = search.trim().replace(/[%,]/g, ' ')
    q = q.or(`content.ilike.%${safe}%,ai_title.ilike.%${safe}%,ai_summary.ilike.%${safe}%`)
  }
  const { data, error } = await q.range(page * pageSize, (page + 1) * pageSize - 1)
  if (error) throw error
  return (data ?? []) as Note[]
}

export async function fetchNoteById(id: string): Promise<Note | null> {
  const { data, error } = await supabase.from('notes').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return (data ?? null) as Note | null
}

export async function countByStatus(status: NoteStatus): Promise<number> {
  const { count, error } = await supabase
    .from('notes')
    .select('id', { count: 'exact', head: true })
    .eq('status', status)
  if (error) throw error
  return count ?? 0
}

export async function insertNote(note: NoteInsert): Promise<Note> {
  const { data: userData } = await supabase.auth.getUser()
  const userId = userData.user?.id
  if (!userId) throw new Error('Niet aangemeld')

  const { data, error } = await supabase
    .from('notes')
    .insert({ ...note, status: 'inbox', user_id: userId })
    .select()
    .single()
  if (error) throw error
  return data as Note
}

export async function updateNote(id: string, note: NoteUpdate): Promise<Note> {
  const { data, error } = await supabase
    .from('notes')
    .update(note)
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data as Note
}

export async function deleteNote(id: string): Promise<void> {
  const { error } = await supabase.from('notes').delete().eq('id', id)
  if (error) throw error
}

export async function bulkUpdateStatus(ids: string[], status: NoteStatus): Promise<void> {
  if (ids.length === 0) return
  const { error } = await supabase.from('notes').update({ status }).in('id', ids)
  if (error) throw error
}

export async function fetchNotesByIds(ids: string[]): Promise<Note[]> {
  if (ids.length === 0) return []
  const { data, error } = await supabase.from('notes').select('*').in('id', ids)
  if (error) throw error
  return (data ?? []) as Note[]
}

export async function fetchNotesSections(): Promise<{ id: string; section: string | null }[]> {
  const { data, error } = await supabase.from('notes').select('id, section')
  if (error) throw error
  return (data ?? []) as { id: string; section: string | null }[]
}

export async function bulkDelete(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const { error } = await supabase.from('notes').delete().in('id', ids)
  if (error) throw error
}

export async function fetchRandomNote(status?: NoteStatus): Promise<Note | null> {
  const notes = await fetchNotes(0, 100, status)
  if (!notes.length) return null
  return notes[Math.floor(Math.random() * notes.length)]
}

/**
 * Surface a note from a previous period — "op deze dag". Prefers notes created
 * on the same calendar day/month in the past; otherwise any note older than a
 * week. Returns null when there's nothing old enough to feel like a rediscovery.
 */
export async function fetchOnThisDay(): Promise<Note | null> {
  const notes = await fetchNotes(0, 300)
  if (!notes.length) return null
  const now = new Date()
  const cutoff = Date.now() - 7 * 86400000
  const older = notes.filter(n => new Date(n.created_at).getTime() < cutoff)
  if (!older.length) return null
  const sameDay = older.filter(n => {
    const d = new Date(n.created_at)
    return d.getDate() === now.getDate() && d.getMonth() === now.getMonth()
  })
  const pool = sameDay.length ? sameDay : older
  return pool[Math.floor(Math.random() * pool.length)]
}

// ── Offline queue (IndexedDB) ───────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('thoughtfoundry', 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(OFFLINE_QUEUE_KEY, { autoIncrement: true })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function queueOfflineNote(note: NoteInsert): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_QUEUE_KEY, 'readwrite')
    tx.objectStore(OFFLINE_QUEUE_KEY).add(note)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function offlineQueueSize(): Promise<number> {
  try {
    const db = await openDB()
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(OFFLINE_QUEUE_KEY, 'readonly')
      const req = tx.objectStore(OFFLINE_QUEUE_KEY).count()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } catch {
    return 0
  }
}

export async function flushOfflineQueue(): Promise<number> {
  if (!navigator.onLine) return 0
  const db = await openDB()
  const store = OFFLINE_QUEUE_KEY

  const items: { key: IDBValidKey; note: NoteInsert }[] = await new Promise((resolve, reject) => {
    const result: { key: IDBValidKey; note: NoteInsert }[] = []
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        result.push({ key: cursor.key, note: cursor.value as NoteInsert })
        cursor.continue()
      } else {
        resolve(result)
      }
    }
    req.onerror = () => reject(req.error)
  })

  let flushed = 0
  for (const { key, note } of items) {
    try {
      await insertNote(note)
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite')
        tx.objectStore(store).delete(key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      flushed++
    } catch {
      // Keep in queue if still failing
    }
  }
  return flushed
}
