import { describe, expect, it } from 'vitest'
import { SECTIONS, sectionLabel } from '../src/lib/sections'
import { getNoteTitle } from '../src/lib/notes'

describe('sections', () => {
  it('labels every known slug', () => {
    for (const s of SECTIONS) expect(sectionLabel(s.slug)).toBe(s.label)
  })

  it('returns an empty string for no section', () => {
    expect(sectionLabel(null)).toBe('')
  })

  it('echoes an unknown slug rather than hiding it', () => {
    expect(sectionLabel('verzonnen_slug')).toBe('verzonnen_slug')
  })

  // process-note validates the model's `section` against exactly these five.
  it('stays in sync with the five slugs the edge function allows', () => {
    expect(SECTIONS.map(s => s.slug)).toEqual([
      'probleemstelling', 'theoretische_onderbouwing',
      'ondersteunende_concepten', 'methodieken', 'reflectievragen',
    ])
  })
})

describe('getNoteTitle', () => {
  it('prefers the AI title', () => {
    expect(getNoteTitle({ ai_title: 'Kop', content: 'lange body' })).toBe('Kop')
  })

  it('falls back to a slice of the content', () => {
    expect(getNoteTitle({ ai_title: null, content: 'x'.repeat(200) })).toHaveLength(80)
    expect(getNoteTitle({ ai_title: null, content: 'x'.repeat(200) }, 20)).toHaveLength(20)
  })

  it('does not truncate an AI title to the fallback length', () => {
    const long = 'K'.repeat(200)
    expect(getNoteTitle({ ai_title: long, content: '' })).toBe(long)
  })
})
