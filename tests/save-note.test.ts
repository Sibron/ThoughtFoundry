// saveNote is the client half of the save_note RPC (#55). Its atomicity is
// Postgres's -- one function call is one transaction, checked against a local
// Postgres replay of the migrations -- so what is pinned here is the contract
// the editor relies on: one request carrying everything, nothing else written
// on the side, and a failure surfaced rather than swallowed.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: { fn: string; args: Record<string, unknown>; select?: string }[] = []
let response: { data: unknown; error: { message: string } | null } = { data: null, error: null }
const from = vi.fn()

vi.mock('../src/lib/supabase', async (orig) => ({
  ...(await orig<typeof import('../src/lib/supabase')>()),
  supabase: {
    from: (...a: unknown[]) => from(...a),
    rpc: (fn: string, args: Record<string, unknown>) => {
      const call: (typeof calls)[number] = { fn, args }
      calls.push(call)
      const chain = {
        select: (cols: string) => { call.select = cols; return chain },
        single: () => Promise.resolve(response),
      }
      return chain
    },
  },
}))

const { saveNote } = await import('../src/lib/notes')

beforeEach(() => {
  calls.length = 0
  from.mockReset()
  response = { data: { id: 'n1', content: 'nieuw' }, error: null }
})

describe('saveNote', () => {
  it('sends the note, its themes and its projects in one RPC call', async () => {
    const saved = await saveNote('n1', { content: 'nieuw', status: 'verwerkt' }, { themeIds: ['t1'], projectIds: [] })

    expect(calls).toHaveLength(1)
    expect(calls[0].fn).toBe('save_note')
    expect(calls[0].args).toEqual({
      p_id: 'n1',
      p_updates: { content: 'nieuw', status: 'verwerkt' },
      p_theme_ids: ['t1'],
      p_project_ids: [],
    })
    expect(saved).toEqual({ id: 'n1', content: 'nieuw' })
    // Never a second, separate write that could land on its own.
    expect(from).not.toHaveBeenCalled()
  })

  it('leaves links alone when no set is given', async () => {
    await saveNote('n1', { content: 'x' })
    expect(calls[0].args).toEqual({ p_id: 'n1', p_updates: { content: 'x' } })
  })

  it('an empty set is sent as empty, which clears -- not as "leave alone"', async () => {
    await saveNote('n1', { content: 'x' }, { themeIds: [] })
    expect(calls[0].args).toHaveProperty('p_theme_ids', [])
    expect(calls[0].args).not.toHaveProperty('p_project_ids')
  })

  it('reads back the note without its embedding', async () => {
    await saveNote('n1', { content: 'x' })
    expect(calls[0].select).toContain('content')
    expect(calls[0].select).not.toContain('embedding')
  })

  it('throws when the transaction fails', async () => {
    response = { data: null, error: { message: 'simulated failure' } }
    await expect(saveNote('n1', { content: 'x' }, { themeIds: ['t1'] })).rejects.toMatchObject({ message: 'simulated failure' })
  })
})
