import { supabase } from './supabase'

export interface Note {
  id: string
  user_id: string
  content: string
  mini_notes: string | null
  status: 'inbox' | 'verwerkt' | 'archief'
  types: string[]
  tags: string[]
  source_url: string | null
  source_title: string | null
  source_author: string | null
  ai_summary: string | null
  created_at: string
  updated_at: string
}

export interface NoteInsert {
  content: string
  mini_notes?: string
  source_url?: string
  source_title?: string
  source_author?: string
}

export interface NoteUpdate {
  content?: string
  mini_notes?: string
  source_url?: string
  source_title?: string
  source_author?: string
  status?: 'inbox' | 'verwerkt' | 'archief'
}

const OFFLINE_QUEUE_KEY = 'offline_queue'

export async function fetchNotes(page = 0, pageSize = 50): Promise<Note[]> {
  const { data, error } = await supabase
    .from('notes')
    .select('*')
    .order('created_at', { ascending: false })
    .range(page * pageSize, (page + 1) * pageSize - 1)
  if (error) throw error
  return (data ?? []) as Note[]
}

export async function insertNote(note: NoteInsert): Promise<Note> {
  const { data, error } = await supabase
    .from('notes')
    .insert({ ...note, status: 'inbox' })
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
