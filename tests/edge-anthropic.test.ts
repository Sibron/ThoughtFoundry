import { describe, expect, it } from 'vitest'
import {
  estimateCost, MAX_PERSONA_CHARS, parseJsonFromResponse, resolveModel, sanitizePersona,
} from '../supabase/functions/_shared/anthropic.ts'

// supabase/functions/ is outside tsconfig's `include`, so `npm run build` never
// typechecks it. These tests are the only automated cover the edge layer has.

describe('resolveModel', () => {
  it('keeps a model the app actually prices', () => {
    expect(resolveModel('claude-sonnet-4-6', 'claude-haiku-4-5')).toBe('claude-sonnet-4-6')
  })

  it('falls back for an unpriced model, which is what defeats the budget cap', () => {
    expect(resolveModel('claude-3-5-sonnet-20241022', 'claude-haiku-4-5')).toBe('claude-haiku-4-5')
  })

  it('falls back for missing and non-string values', () => {
    for (const bad of [undefined, null, 42, {}, [], '']) {
      expect(resolveModel(bad, 'claude-haiku-4-5')).toBe('claude-haiku-4-5')
    }
  })

  it('does not accept inherited Object.prototype keys as models', () => {
    expect(resolveModel('toString', 'claude-haiku-4-5')).toBe('claude-haiku-4-5')
    expect(resolveModel('constructor', 'claude-haiku-4-5')).toBe('claude-haiku-4-5')
  })
})

describe('estimateCost', () => {
  it('prices a known model per million tokens', () => {
    // haiku: $1/M in, $5/M out
    expect(estimateCost('claude-haiku-4-5', 1_000_000, 1_000_000)).toBeCloseTo(6)
  })

  it('charges more for the better model', () => {
    expect(estimateCost('claude-sonnet-4-6', 1000, 1000))
      .toBeGreaterThan(estimateCost('claude-haiku-4-5', 1000, 1000))
  })

  it('never returns NaN — a NaN cost_usd row silently disables the cap', () => {
    // @ts-expect-error deliberately passing a model the table does not price
    const cost = estimateCost('made-up-model', 1000, 1000)
    expect(Number.isFinite(cost)).toBe(true)
  })

  it('is zero for a zero-token call', () => {
    expect(estimateCost('claude-haiku-4-5', 0, 0)).toBe(0)
  })
})

describe('sanitizePersona', () => {
  it('trims and passes through ordinary text', () => {
    expect(sanitizePersona('  ik ben coach  ')).toBe('ik ben coach')
  })

  it('caps runaway input so it cannot inflate every prompt', () => {
    expect(sanitizePersona('x'.repeat(MAX_PERSONA_CHARS * 3))).toHaveLength(MAX_PERSONA_CHARS)
  })

  it('returns an empty string for missing or non-string values', () => {
    for (const bad of [undefined, null, 42, {}]) expect(sanitizePersona(bad)).toBe('')
  })
})

describe('parseJsonFromResponse', () => {
  it('parses bare JSON', () => {
    expect(parseJsonFromResponse<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
  })

  it('strips a ```json fence', () => {
    expect(parseJsonFromResponse('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('strips a bare ``` fence', () => {
    expect(parseJsonFromResponse('```\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('throws on prose the model returned instead of JSON', () => {
    expect(() => parseJsonFromResponse('Sorry, ik kan dat niet.')).toThrow()
  })
})
