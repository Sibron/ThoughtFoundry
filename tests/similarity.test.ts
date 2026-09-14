import { describe, expect, it } from 'vitest'
import {
  DUPLICATE_RATIO, findSurprisingPair, noteTokens, overlapRatio,
  pairKey, rankByQuery, rankBySimilarity, tokenize, type SimNote,
} from '../src/lib/similarity'

const n = (id: string, content: string, ai_title: string | null = null): SimNote =>
  ({ id, content, ai_title, ai_summary: null })

describe('tokenize', () => {
  it('lowercases, splits on punctuation and drops short words', () => {
    expect([...tokenize('Leiderschap, autisme & een kat!')].sort())
      .toEqual(['autisme', 'leiderschap'])
  })

  it('drops Dutch stopwords that survive the length filter', () => {
    expect(tokenize('deze omdat terwijl waardoor').size).toBe(0)
  })

  it('keeps accented characters', () => {
    expect(tokenize('café').has('café')).toBe(true)
  })
})

describe('noteTokens', () => {
  it('reads title, summary, core idea and a capped body', () => {
    const tokens = noteTokens({
      id: 'a', ai_title: 'Titelwoord', ai_summary: 'Samenvatting',
      core_idea: 'Kernidee', content: 'Bodytekst',
    })
    expect(tokens.has('titelwoord')).toBe(true)
    expect(tokens.has('samenvatting')).toBe(true)
    expect(tokens.has('kernidee')).toBe(true)
    expect(tokens.has('bodytekst')).toBe(true)
  })

  it('ignores body text past the 600-character cap', () => {
    expect(noteTokens(n('a', 'x'.repeat(600) + ' voorbijdecap')).has('voorbijdecap')).toBe(false)
  })
})

describe('overlapRatio', () => {
  it('is 1 for identical token sets and 0 for disjoint ones', () => {
    expect(overlapRatio(n('a', 'autisme leiderschap'), n('b', 'autisme leiderschap'))).toBe(1)
    expect(overlapRatio(n('a', 'autisme'), n('b', 'zeilboot'))).toBe(0)
  })

  it('is 0 when either side has no usable tokens', () => {
    expect(overlapRatio(n('a', ''), n('b', 'autisme'))).toBe(0)
  })

  it('is length-independent, unlike a raw shared-token count', () => {
    const draft = n('d', 'autisme leiderschap')
    const twin = n('t', 'autisme leiderschap')
    const sprawling = n('s', 'autisme leiderschap ' + 'onderwerp'.repeat(1) + ' zeilboot kachel raamwerk beslissing')
    // The sprawling note shares the same two words but says much more, so it is
    // a weaker duplicate candidate — the property the capture hint relies on.
    expect(overlapRatio(draft, twin)).toBeGreaterThan(overlapRatio(draft, sprawling))
    expect(overlapRatio(draft, twin)).toBeGreaterThan(DUPLICATE_RATIO)
  })
})

describe('rankBySimilarity', () => {
  it('orders by shared-token count and drops zero-overlap candidates', () => {
    const target = n('t', 'autisme leiderschap coaching')
    const ranked = rankBySimilarity(target, [
      n('a', 'zeilboot kachel'),
      n('b', 'autisme leiderschap coaching'),
      n('c', 'autisme zeilboot'),
    ])
    expect(ranked.map(r => r.note.id)).toEqual(['b', 'c'])
  })

  it('returns nothing when the target has no usable tokens', () => {
    expect(rankBySimilarity(n('t', 'de en of'), [n('a', 'autisme')])).toEqual([])
  })

  it('respects the limit', () => {
    const pool = ['a', 'b', 'c'].map(id => n(id, 'autisme leiderschap'))
    expect(rankBySimilarity(n('t', 'autisme leiderschap'), pool, 2)).toHaveLength(2)
  })
})

describe('rankByQuery', () => {
  it('weighs a title hit above a body hit', () => {
    const ranked = rankByQuery('autisme', [
      n('body', 'iets over autisme in de tekst'),
      n('title', 'niet relevant', 'autisme'),
    ])
    expect(ranked[0].note.id).toBe('title')
  })

  it('keeps every note so callers can fall back to server ordering', () => {
    expect(rankByQuery('autisme', [n('a', 'zeilboot'), n('b', 'kachel')])).toHaveLength(2)
  })

  it('rewards an exact phrase match', () => {
    const [top] = rankByQuery('autisme en leiderschap', [
      n('loose', 'leiderschap ... autisme'),
      n('phrase', 'een stuk over autisme en leiderschap hier'),
    ])
    expect(top.note.id).toBe('phrase')
  })
})

describe('findSurprisingPair', () => {
  const a = n('a', 'autisme leiderschap coaching patronen')
  const b = n('b', 'autisme leiderschap coaching patronen')

  it('finds an unlinked, theme-disjoint pair with enough overlap', () => {
    const pair = findSurprisingPair([a, b], new Set(), new Map())
    expect(pair && [pair.a.id, pair.b.id].sort()).toEqual(['a', 'b'])
  })

  it('skips a pair that is already linked', () => {
    expect(findSurprisingPair([a, b], new Set([pairKey('a', 'b')]), new Map())).toBeNull()
  })

  it('skips a pair that already shares a theme', () => {
    const themes = new Map([['a', new Set(['t1'])], ['b', new Set(['t1'])]])
    expect(findSurprisingPair([a, b], new Set(), themes)).toBeNull()
  })

  it('skips a pair below the overlap floor', () => {
    expect(findSurprisingPair([n('a', 'zeilboot'), n('b', 'kachel')], new Set(), new Map())).toBeNull()
  })
})

describe('pairKey', () => {
  it('is order-independent', () => {
    expect(pairKey('b', 'a')).toBe(pairKey('a', 'b'))
  })
})
