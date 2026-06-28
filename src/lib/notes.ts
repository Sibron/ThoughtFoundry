import { supabase, fetchAllRows } from './supabase'

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

/**
 * Display title for a note: the AI-generated title when present, otherwise a
 * leading slice of the raw content. Centralises the `ai_title ?? content.slice`
 * fallback repeated across the note-list views.
 */
export function getNoteTitle(note: { ai_title: string | null; content: string }, max = 80): string {
  return note.ai_title ?? note.content.slice(0, max)
}

const OFFLINE_QUEUE_KEY = 'offline_queue'

// Every note column EXCEPT `embedding`. That column is a vector(1024) used only
// by server-side semantic search — no client view reads it — yet `select('*')`
// drags it along, where it accounts for ~60% of the notes payload (≈10 KB/row
// over the wire). Listing columns explicitly keeps every note fetch lean and the
// local cache small.
const NOTE_COLUMNS =
  'id, user_id, content, mini_notes, status, note_type, core_idea, use_for, ' +
  'source_id, tags, source_url, source_title, source_author, ai_summary, ' +
  'ai_title, processed_at, section, created_at, updated_at'

export async function fetchNotes(
  page = 0,
  pageSize = 50,
  status?: NoteStatus,
  search?: string,
  noteType?: NoteType
): Promise<Note[]> {
  let q = supabase.from('notes').select(NOTE_COLUMNS)
    .order('created_at', { ascending: false }).order('id', { ascending: true })
  if (status) q = q.eq('status', status)
  if (noteType) q = q.eq('note_type', noteType)
  if (search && search.trim()) {
    const safe = search.trim().replace(/[%,()]/g, ' ')
    // Match on ANY query word (not just the whole string) so multi-word and
    // differently-phrased queries still surface candidates. Ranking by actual
    // relevance happens client-side via rankByQuery.
    const words = Array.from(new Set(safe.split(/\s+/).filter(w => w.length >= 2)))
    const terms = (words.length ? words : [safe]).flatMap(w =>
      [`content.ilike.%${w}%`, `ai_title.ilike.%${w}%`, `ai_summary.ilike.%${w}%`]
    )
    q = q.or(terms.join(','))
  }
  const { data, error } = await q.range(page * pageSize, (page + 1) * pageSize - 1)
  if (error) throw error
  // `data` is typed loosely because the column list is a runtime string, not a
  // literal supabase-js can parse — route the cast through `unknown`.
  return (data ?? []) as unknown as Note[]
}

/**
 * Every note (optionally of one status), paged past the 1000-row default. Views
 * that group the full set by theme or source — the graph, the chapter workbench,
 * the sources overview — need this: a fixed cap (e.g. the most recent 500)
 * silently hides older notes, so a theme/source filter could match notes that
 * were never loaded and render nothing or an undercount.
 */
export async function fetchAllNotes(status?: NoteStatus): Promise<Note[]> {
  return fetchAllRows<Note>((from, to) => {
    // `id` tiebreaker keeps offset paging deterministic when many notes share a
    // created_at (e.g. a bulk import) — otherwise pages can skip/duplicate rows
    // and the cached snapshot churns between identical fetches.
    let q = supabase.from('notes').select(NOTE_COLUMNS)
      .order('created_at', { ascending: false }).order('id', { ascending: true })
    if (status) q = q.eq('status', status)
    return q.range(from, to)
  })
}

export async function fetchNoteById(id: string): Promise<Note | null> {
  const { data, error } = await supabase.from('notes').select(NOTE_COLUMNS).eq('id', id).maybeSingle()
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

/**
 * IDs of notes that are "connected" — they appear in at least one link (either
 * direction) or are tagged with at least one theme. The complement of this set
 * (over non-archived notes) is the orphan pile worth surfacing for connection.
 */
export async function fetchConnectedNoteIds(): Promise<Set<string>> {
  // Paged: both tables routinely exceed the 1000-row default, and a truncated
  // read would mislabel genuinely-connected notes as orphans.
  const [links, themeRows] = await Promise.all([
    fetchAllRows<{ source_id: string; target_id: string }>((from, to) =>
      supabase.from('note_links').select('source_id, target_id').order('id', { ascending: true }).range(from, to)
    ),
    fetchAllRows<{ note_id: string }>((from, to) =>
      supabase.from('note_themes').select('note_id')
        .order('note_id', { ascending: true }).order('theme_id', { ascending: true }).range(from, to)
    )
  ])
  const set = new Set<string>()
  for (const l of links) {
    set.add(l.source_id); set.add(l.target_id)
  }
  for (const t of themeRows) set.add(t.note_id)
  return set
}

/**
 * IDs of processed notes that were never run through the real AI pipeline —
 * the Notion import set `processed_at = created_at` (and a heuristic title/
 * summary), whereas native processing stamps `processed_at` at the moment of
 * processing. Re-processing a note updates `processed_at`, so this set shrinks
 * as the batch progresses and the run is naturally resumable.
 */
export async function fetchNoteIdsNeedingReprocess(): Promise<string[]> {
  const { data, error } = await supabase
    .from('notes')
    .select('id, processed_at, created_at')
    .eq('status', 'verwerkt')
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? [])
    .filter((n: { processed_at: string | null; created_at: string }) => n.processed_at === n.created_at)
    .map((n: { id: string }) => n.id)
}

export async function fetchNotesByIds(ids: string[]): Promise<Note[]> {
  if (ids.length === 0) return []
  const { data, error } = await supabase.from('notes').select(NOTE_COLUMNS).in('id', ids)
  if (error) throw error
  return (data ?? []) as unknown as Note[]
}

export async function fetchNotesSections(): Promise<{ id: string; section: string | null }[]> {
  // Paged so the themes overview's section bars reflect every note, not the
  // first 1000 the default cap would return.
  return fetchAllRows<{ id: string; section: string | null }>((from, to) =>
    supabase.from('notes').select('id, section').order('id', { ascending: true }).range(from, to)
  )
}

export async function fetchNotesByTheme(themeId: string): Promise<{ id: string; ai_title: string | null; section: string | null }[]> {
  const { data: nt, error: err1 } = await supabase
    .from('note_themes')
    .select('note_id')
    .eq('theme_id', themeId)
  if (err1) throw err1
  const ids = (nt ?? []).map((r: { note_id: string }) => r.note_id)
  if (ids.length === 0) return []
  const { data, error: err2 } = await supabase
    .from('notes')
    .select('id, ai_title, section')
    .in('id', ids)
  if (err2) throw err2
  return (data ?? []) as { id: string; ai_title: string | null; section: string | null }[]
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
