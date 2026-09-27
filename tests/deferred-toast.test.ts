// showDeferredCommitToast (lib/crud-list.ts) holds a delete back for six
// seconds so it can be undone. #54: a tab closed inside that window never sent
// the delete. These tests pin the contract, including the flush on hide.
//
// No DOM environment (see CLAUDE.md "Testing"): the helper touches one toast
// element, one button and two event targets, so those are stubbed below.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = () => void

class FakeButton {
  listeners: Listener[] = []
  addEventListener(_type: string, fn: Listener): void { this.listeners.push(fn) }
  click(): void { this.listeners.forEach(fn => fn()) }
}

class FakeToast {
  #html = ''
  textContent = ''
  button: FakeButton | null = null
  readonly classes = new Set<string>()
  readonly classList = {
    add: (c: string) => { this.classes.add(c) },
    remove: (c: string) => { this.classes.delete(c) },
    contains: (c: string) => this.classes.has(c),
  }
  set innerHTML(html: string) {
    this.#html = html
    this.textContent = html.replace(/<[^>]+>/g, '')
    this.button = html.includes('toast-undo') ? new FakeButton() : null
  }
  get innerHTML(): string { return this.#html }
  hasAttribute(): boolean { return true }
  setAttribute(): void {}
  querySelector(): FakeButton | null { return this.button }
}

const events = new Map<string, Listener[]>()
const on = (type: string, fn: Listener) => events.set(type, [...(events.get(type) ?? []), fn])
const fire = (type: string) => (events.get(type) ?? []).forEach(fn => fn())

let toast: FakeToast | null = new FakeToast()
const doc = {
  visibilityState: 'visible' as 'visible' | 'hidden',
  getElementById: (id: string) => (id === 'toast' ? toast : null),
  addEventListener: on,
}
vi.stubGlobal('document', doc)
vi.stubGlobal('window', { addEventListener: on })

const { showDeferredCommitToast } = await import('../src/lib/crud-list')

afterAll(() => vi.unstubAllGlobals())

let commit: ReturnType<typeof vi.fn>
let restore: ReturnType<typeof vi.fn>

beforeEach(async () => {
  vi.useFakeTimers()
  // Close any window a previous test left open, so it cannot leak into this one.
  fire('pagehide')
  await vi.runAllTimersAsync()
  toast = new FakeToast()
  doc.visibilityState = 'visible'
  commit = vi.fn().mockResolvedValue(undefined)
  restore = vi.fn()
})

const settle = () => vi.advanceTimersByTimeAsync(0)

describe('undo window', () => {
  it('commits exactly once, when the six seconds are up', async () => {
    showDeferredCommitToast('Notitie verwijderd', commit, restore)
    await vi.advanceTimersByTimeAsync(5999)
    expect(commit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(restore).not.toHaveBeenCalled()
  })

  it('never commits after undo -- nothing reaches the database', async () => {
    showDeferredCommitToast('Notitie verwijderd', commit, restore)
    toast!.button!.click()
    fire('pagehide')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(commit).not.toHaveBeenCalled()
  })

  it('commits the older action at once when a newer toast replaces it', async () => {
    const second = vi.fn().mockResolvedValue(undefined)
    showDeferredCommitToast('een', commit, restore)
    showDeferredCommitToast('twee', second, vi.fn())
    expect(commit).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(6000)
    expect(second).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('commits immediately when there is no toast to show', async () => {
    toast = null
    showDeferredCommitToast('x', commit, restore)
    expect(commit).toHaveBeenCalledTimes(1)
  })
})

describe('the page going away (#54)', () => {
  it('commits when the page becomes hidden inside the window, and only once', async () => {
    showDeferredCommitToast('Notitie verwijderd', commit, restore)
    doc.visibilityState = 'hidden'
    fire('visibilitychange')
    // Synchronously -- the page may not get another turn of the event loop.
    expect(commit).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(toast!.classList.contains('show')).toBe(false)
  })

  it('commits on pagehide', () => {
    showDeferredCommitToast('Notitie verwijderd', commit, restore)
    fire('pagehide')
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('does not commit when the page merely becomes visible again', () => {
    showDeferredCommitToast('Notitie verwijderd', commit, restore)
    fire('visibilitychange')
    expect(commit).not.toHaveBeenCalled()
  })
})

describe('a failed commit', () => {
  it('puts the row back and says so, instead of leaving the screen and database out of sync', async () => {
    commit.mockRejectedValue(new Error('offline'))
    showDeferredCommitToast('Notitie verwijderd', commit, restore)
    fire('pagehide')
    await settle()
    expect(restore).toHaveBeenCalledTimes(1)
    expect(toast!.textContent).toBe('Verwijderen mislukt: offline')
  })

  it('still reports the failure when the view to restore is gone', async () => {
    commit.mockRejectedValue(new Error('offline'))
    restore.mockImplementation(() => { throw new Error('no .note-body') })
    showDeferredCommitToast('Notitie verwijderd', commit, restore)
    await vi.advanceTimersByTimeAsync(6000)
    expect(toast!.textContent).toBe('Verwijderen mislukt: offline')
  })
})

describe('keepalive on a hidden page (lib/supabase.ts)', () => {
  it('sends a DELETE with keepalive only while the page is hidden', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchSpy)
    vi.useRealTimers()
    const { supabase } = await import('../src/lib/supabase')

    doc.visibilityState = 'visible'
    await supabase.from('notes').delete().eq('id', 'n1')
    doc.visibilityState = 'hidden'
    await supabase.from('notes').delete().eq('id', 'n1')
    await supabase.from('notes').select('id')

    const inits = fetchSpy.mock.calls.map(c => c[1] as RequestInit)
    expect(inits.map(i => [i.method, i.keepalive ?? false])).toEqual([
      ['DELETE', false],
      ['DELETE', true],
      ['GET', false],
    ])
  })
})
