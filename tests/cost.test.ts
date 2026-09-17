import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.fn()
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }))
vi.mock('../src/lib/user-settings', () => ({ saveUserSetting: vi.fn().mockResolvedValue(undefined) }))

const { formatUsd, getCostStatus, getMonthlyCap, setMonthlyCap } = await import('../src/lib/cost')

describe('monthly cap', () => {
  beforeEach(() => { localStorage.clear(); rpc.mockReset() })

  it('defaults to $5 when unset', () => {
    expect(getMonthlyCap()).toBe(5)
  })

  it('falls back to the default for junk, zero and negative stored values', () => {
    for (const bad of ['', 'abc', '0', '-3', 'NaN']) {
      localStorage.setItem('ai_monthly_cap_usd', bad)
      expect(getMonthlyCap()).toBe(5)
    }
  })

  it('round-trips a set value', () => {
    setMonthlyCap(12.5)
    expect(getMonthlyCap()).toBe(12.5)
  })
})

describe('getCostStatus thresholds', () => {
  beforeEach(() => { localStorage.clear(); rpc.mockReset() })

  const withSpend = (n: number) => rpc.mockResolvedValue({ data: n, error: null })

  it('does not warn below 80% of the cap', async () => {
    withSpend(3.9)
    const s = await getCostStatus()
    expect(s.warn).toBe(false)
    expect(s.block).toBe(false)
  })

  it('warns at exactly 80% but does not block', async () => {
    withSpend(4)
    const s = await getCostStatus()
    expect(s.warn).toBe(true)
    expect(s.block).toBe(false)
  })

  it('blocks at exactly 100%', async () => {
    withSpend(5)
    const s = await getCostStatus()
    expect(s.warn).toBe(true)
    expect(s.block).toBe(true)
  })

  it('treats a failed spend lookup as zero rather than blocking the user out', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'down' } })
    const s = await getCostStatus()
    expect(s.spendUsd).toBe(0)
    expect(s.block).toBe(false)
  })
})

describe('formatUsd', () => {
  it('shows three decimals under a dollar and two above', () => {
    expect(formatUsd(0.0123)).toBe('$0.012')
    expect(formatUsd(12.3)).toBe('$12.30')
    expect(formatUsd(1)).toBe('$1.00')
  })
})
