import { supabase } from './supabase'

/**
 * On-device snapshot cache for the rarely-changing data the heavy views load
 * (notes, themes, links). It backs a stale-while-revalidate pattern: a page
 * renders instantly from the last snapshot, then a background refetch updates
 * the cache and only re-renders if the data actually changed.
 *
 * Storage is a tiny IndexedDB database, separate from the offline write-queue DB
 * so the two never fight over schema versions. Snapshots are keyed per user so
 * one account never sees another's cache, and cleared on logout.
 */

const DB_NAME = 'thoughtfoundry-cache'
const STORE = 'snapshots'

interface SnapshotRecord {
  key: string
  user_id: string
  json: string
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.user?.id ?? null
}

function readRecord(key: string): Promise<SnapshotRecord | null> {
  return openDB().then(db => new Promise<SnapshotRecord | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve((req.result as SnapshotRecord | undefined) ?? null)
    req.onerror = () => reject(req.error)
  }))
}

function writeRecord(rec: SnapshotRecord): Promise<void> {
  return openDB().then(db => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(rec)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  }))
}

/** Drop every cached snapshot — call on logout so the next user starts clean. */
export async function clearCache(): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    /* best-effort */
  }
}

/**
 * Stale-while-revalidate read.
 *
 * - If a snapshot for `key` exists (and belongs to the current user), return it
 *   immediately and refetch in the background; `onFresh` fires only when the new
 *   data differs from the cached copy, so an unchanged refresh never disturbs the
 *   view (the common case — these datasets rarely change).
 * - With no usable snapshot, fall back to a normal awaited fetch and seed the
 *   cache for next time.
 *
 * A full refetch replaces the whole snapshot, so deletions are handled for free —
 * no tombstones or id reconciliation needed.
 */
export async function swr<T>(
  key: string,
  fetcher: () => Promise<T>,
  onFresh: (data: T) => void
): Promise<T> {
  const userId = await currentUserId().catch(() => null)
  if (!userId) return fetcher()

  let cached: { data: T; json: string } | null = null
  try {
    const rec = await readRecord(key)
    if (rec && rec.user_id === userId) cached = { data: JSON.parse(rec.json) as T, json: rec.json }
  } catch {
    cached = null
  }

  if (cached) {
    void (async () => {
      try {
        const fresh = await fetcher()
        const json = JSON.stringify(fresh)
        if (json !== cached!.json) {
          await writeRecord({ key, user_id: userId, json })
          onFresh(fresh)
        }
      } catch {
        /* offline or transient — keep showing the cached snapshot */
      }
    })()
    return cached.data
  }

  const fresh = await fetcher()
  try {
    await writeRecord({ key, user_id: userId, json: JSON.stringify(fresh) })
  } catch {
    /* quota or serialization issue — degrade to no-cache, not a failure */
  }
  return fresh
}

/**
 * Refresh a snapshot in the background without needing it on screen — used at
 * startup to warm the cache so the first visit to a heavy page is already
 * instant. No-op effect beyond updating storage.
 */
export async function warm<T>(key: string, fetcher: () => Promise<T>): Promise<void> {
  const userId = await currentUserId().catch(() => null)
  if (!userId) return
  try {
    const fresh = await fetcher()
    await writeRecord({ key, user_id: userId, json: JSON.stringify(fresh) })
  } catch {
    /* best-effort warm; pages still work without it */
  }
}
