// The offline capture queue in lib/notes.ts: IndexedDB now, Supabase later.
// This is the app's offline-first promise, so the property that matters is
// that a note is never dropped -- it leaves the queue only once the insert
// has succeeded.
//
// `fake-indexeddb` supplies IndexedDB, which the node environment lacks. It is
// imported here rather than in tests/setup.ts so the other suites keep running
// without it.
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fake } from './helpers/fake-supabase'

vi.mock('../src/lib/supabase', async (orig) => ({
  ...(await orig<typeof import('../src/lib/supabase')>()),
  supabase: (await import('./helpers/fake-supabase')).fake.client,
}))

const { queueOfflineNote, offlineQueueSize, flushOfflineQueue } = await import('../src/lib/notes')

let online = true

beforeEach(() => {
  fake.reset()
  online = true
  // A fresh factory per test. openDB() never closes its connections, so
  // deleteDatabase() would block forever; replacing the factory sidesteps it.
  vi.stubGlobal('indexedDB', new IDBFactory())
  // Node 20 has no `navigator`, and Node 22's has no `onLine`.
  vi.stubGlobal('navigator', { get onLine() { return online } })
})

afterEach(() => vi.unstubAllGlobals())

const contents = () => fake.table('notes').map(n => n['content'])

describe('offline queue', () => {
  it('holds notes while offline and flushes them in order on reconnect', async () => {
    online = false
    await queueOfflineNote({ content: 'een' })
    await queueOfflineNote({ content: 'twee' })

    expect(await flushOfflineQueue()).toBe(0)
    expect(await offlineQueueSize()).toBe(2)
    expect(fake.table('notes')).toEqual([])

    online = true
    expect(await flushOfflineQueue()).toBe(2)
    expect(await offlineQueueSize()).toBe(0)
    expect(contents()).toEqual(['een', 'twee'])
    expect(fake.table('notes')[0]).toMatchObject({ status: 'inbox', user_id: 'user-a' })
  })

  it('keeps a note whose insert fails, and removes only the ones that landed', async () => {
    for (const content of ['een', 'kapot', 'drie']) await queueOfflineNote({ content })
    fake.failWrite = (_t, _op, rows) =>
      rows.some(r => r['content'] === 'kapot') ? { code: '08006', message: 'connection lost' } : null

    expect(await flushOfflineQueue()).toBe(2)
    expect(await offlineQueueSize()).toBe(1)
    expect(contents()).toEqual(['een', 'drie'])

    fake.failWrite = null
    expect(await flushOfflineQueue()).toBe(1)
    expect(await offlineQueueSize()).toBe(0)
    expect(contents()).toEqual(['een', 'drie', 'kapot'])
  })

  it('keeps everything when the session has expired', async () => {
    await queueOfflineNote({ content: 'een' })
    fake.userId = null

    expect(await flushOfflineQueue()).toBe(0)
    expect(await offlineQueueSize()).toBe(1)
  })

  it('reports an empty queue rather than throwing when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined)
    expect(await offlineQueueSize()).toBe(0)
  })
})
