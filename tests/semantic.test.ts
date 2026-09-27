// The similarity thresholds in lib/semantic.ts are judgement calls (#36), but
// how they relate to each other is not. Retuning any one of them must keep
// these true, or a class of pairs silently stops being suggested.
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BRIDGE_BANDS, BRIDGE_MAX_SIMILARITY, BRIDGE_MIN_SIMILARITY,
  MATCH_MIN_SIMILARITY, NEAR_DUPLICATE_SIMILARITY, STRONG_SIMILARITY,
} from '../src/lib/semantic'

describe('similarity thresholds', () => {
  it('are ordered: match floor < bridge floor < strong < near-duplicate', () => {
    expect(MATCH_MIN_SIMILARITY).toBeLessThan(BRIDGE_MIN_SIMILARITY)
    expect(BRIDGE_MIN_SIMILARITY).toBeLessThan(STRONG_SIMILARITY)
    expect(STRONG_SIMILARITY).toBeLessThan(NEAR_DUPLICATE_SIMILARITY)
    expect(NEAR_DUPLICATE_SIMILARITY).toBeLessThanOrEqual(1)
  })

  it('keep the default band inside the reviewable range', () => {
    expect(BRIDGE_MAX_SIMILARITY).toBeGreaterThan(STRONG_SIMILARITY)
    expect(BRIDGE_MAX_SIMILARITY).toBeLessThanOrEqual(NEAR_DUPLICATE_SIMILARITY)
  })
})

describe('review bands', () => {
  const bands = Object.values(BRIDGE_BANDS).sort((a, b) => a.lo - b.lo)

  it('tile BRIDGE_MIN..NEAR_DUPLICATE with no gap, so no pair is unreachable', () => {
    expect(bands[0].lo).toBe(BRIDGE_MIN_SIMILARITY)
    expect(bands[bands.length - 1].hi).toBe(NEAR_DUPLICATE_SIMILARITY)
    for (let i = 1; i < bands.length; i++) expect(bands[i].lo).toBe(bands[i - 1].hi)
    for (const b of bands) expect(b.lo).toBeLessThan(b.hi)
  })

  it('split at STRONG_SIMILARITY, which is also the "sterk verwant" label line', () => {
    expect(BRIDGE_BANDS.verrassend.hi).toBe(STRONG_SIMILARITY)
    expect(BRIDGE_BANDS.dichtbij.lo).toBe(STRONG_SIMILARITY)
  })
})

describe('semantic_bridges SQL defaults', () => {
  // BRIDGE_MIN/MAX mirror the RPC's band_lo/band_hi defaults, so a caller that
  // passes no band gets the same pairs from the app as from psql. Read the
  // newest definition, as a deploy would leave it.
  const dir = new URL('../supabase/migrations/', import.meta.url)

  it('match the client constants in the newest migration that defines the function', () => {
    const latest = readdirSync(dir).filter(f => f.endsWith('.sql')).sort().reverse()
      .map(f => readFileSync(new URL(f, dir), 'utf8'))
      .find(sql => /create or replace function public\.semantic_bridges\(/.test(sql))
    expect(latest).toBeDefined()
    const lo = Number(/band_lo\s+float\s+default\s+([\d.]+)/.exec(latest!)?.[1])
    const hi = Number(/band_hi\s+float\s+default\s+([\d.]+)/.exec(latest!)?.[1])
    expect(lo).toBe(BRIDGE_MIN_SIMILARITY)
    expect(hi).toBe(BRIDGE_MAX_SIMILARITY)
  })
})
