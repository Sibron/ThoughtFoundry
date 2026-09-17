import { describe, expect, it, vi } from 'vitest'
import { fetchAllRows, isUuid } from '../src/lib/supabase'

// fetchAllRows is the guard against PostgREST's silent 1000-row ceiling. The
// full-account export depends on it, so its paging contract is worth pinning.
describe('fetchAllRows', () => {
  const pageOf = (n: number) => Array.from({ length: n }, (_, i) => ({ i }))

  it('returns a single short page without asking for another', async () => {
    const page = vi.fn().mockResolvedValue({ data: pageOf(3), error: null })
    expect(await fetchAllRows(page)).toHaveLength(3)
    expect(page).toHaveBeenCalledTimes(1)
    expect(page).toHaveBeenCalledWith(0, 999)
  })

  it('keeps paging while pages come back full', async () => {
    const page = vi.fn()
      .mockResolvedValueOnce({ data: pageOf(1000), error: null })
      .mockResolvedValueOnce({ data: pageOf(1000), error: null })
      .mockResolvedValueOnce({ data: pageOf(7), error: null })
    expect(await fetchAllRows(page)).toHaveLength(2007)
    expect(page).toHaveBeenCalledTimes(3)
    expect(page).toHaveBeenNthCalledWith(2, 1000, 1999)
    expect(page).toHaveBeenNthCalledWith(3, 2000, 2999)
  })

  it('stops on an exactly-full final page after one empty follow-up', async () => {
    const page = vi.fn()
      .mockResolvedValueOnce({ data: pageOf(1000), error: null })
      .mockResolvedValueOnce({ data: [], error: null })
    expect(await fetchAllRows(page)).toHaveLength(1000)
    expect(page).toHaveBeenCalledTimes(2)
  })

  it('treats a null data payload as the end, not as rows', async () => {
    const page = vi.fn().mockResolvedValue({ data: null, error: null })
    expect(await fetchAllRows(page)).toEqual([])
  })

  it('throws rather than returning a partial result', async () => {
    const page = vi.fn()
      .mockResolvedValueOnce({ data: pageOf(1000), error: null })
      .mockResolvedValueOnce({ data: null, error: new Error('boom') })
    await expect(fetchAllRows(page)).rejects.toThrow('boom')
  })
})

describe('isUuid', () => {
  it('accepts a canonical uuid in either case', () => {
    expect(isUuid('ff878237-e0e5-476f-9b9b-f0a0dead46f0')).toBe(true)
    expect(isUuid('FF878237-E0E5-476F-9B9B-F0A0DEAD46F0')).toBe(true)
  })

  it('rejects empty, malformed and PostgREST-filter-shaped values', () => {
    expect(isUuid(null)).toBe(false)
    expect(isUuid(undefined)).toBe(false)
    expect(isUuid('')).toBe(false)
    expect(isUuid('not-a-uuid')).toBe(false)
    // The shape that made the guard worth having: an id smuggling filter syntax.
    expect(isUuid('ff878237-e0e5-476f-9b9b-f0a0dead46f0,status.eq.archief')).toBe(false)
  })
})
