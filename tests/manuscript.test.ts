import { describe, expect, it } from 'vitest'
import { renderBookMarkdown, renderChapterMarkdown, slugify, type ManuscriptChapter } from '../src/lib/manuscript'
import type { Note } from '../src/lib/notes'

function note(over: Partial<Note> & { id: string; content: string }): Note {
  return {
    user_id: 'u', mini_notes: null, status: 'verwerkt', core_idea: null, use_for: null,
    source_id: null, source_url: null, source_title: null, source_author: null,
    ai_summary: null, ai_title: null, processed_at: null, section: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    ...over,
  } as Note
}

const chapter = (title: string, noteIds: string[]): ManuscriptChapter => ({
  title, summary: '', sections: [{ heading: 'Sectie', intent: '', note_ids: noteIds }],
})

describe('renderChapterMarkdown', () => {
  it('appends the generated-by footer by default', () => {
    const md = renderChapterMarkdown(chapter('Een', ['a']), [note({ id: 'a', content: 'tekst' })])
    expect(md).toContain('*Gegenereerd via ThoughtFoundry')
  })

  it('omits the footer when asked, so a caller need not cut it off', () => {
    const md = renderChapterMarkdown(chapter('Een', ['a']), [note({ id: 'a', content: 'tekst' })], { footer: false })
    expect(md).not.toContain('Gegenereerd via ThoughtFoundry')
    expect(md).toContain('tekst')
  })

  it('prefers a written section over its attached notes', () => {
    const ch: ManuscriptChapter = {
      title: 'Een', summary: '',
      sections: [{ heading: 'S', intent: 'bedoeling', note_ids: ['a'], content_md: 'geschreven proza' }],
    }
    const md = renderChapterMarkdown(ch, [note({ id: 'a', content: 'ruwe notitie' })])
    expect(md).toContain('geschreven proza')
    expect(md).not.toContain('ruwe notitie')
    expect(md).not.toContain('bedoeling')
  })
})

describe('renderBookMarkdown', () => {
  // Regression: the book used to be assembled by rendering each chapter with
  // its footer and then cutting at the first "\n---\n". A note containing a
  // markdown horizontal rule produces that exact sequence, which truncated the
  // chapter — and every chapter after it — out of the export.
  it('keeps content that follows a markdown horizontal rule inside a note', () => {
    const notes = [note({ id: 'a', content: 'voor de streep\n\n---\n\nna de streep' })]
    const md = renderBookMarkdown('Boek', '', [chapter('Hoofdstuk een', ['a'])], notes)
    expect(md).toContain('voor de streep')
    expect(md).toContain('na de streep')
  })

  it('does not drop later chapters when an earlier note contains a rule', () => {
    const notes = [
      note({ id: 'a', content: 'eerste\n---\nnog steeds eerste' }),
      note({ id: 'b', content: 'tweede hoofdstuk inhoud' }),
    ]
    const md = renderBookMarkdown('Boek', '', [chapter('Een', ['a']), chapter('Twee', ['b'])], notes)
    expect(md).toContain('nog steeds eerste')
    expect(md).toContain('tweede hoofdstuk inhoud')
    expect(md).toContain('Hoofdstuk 2: Twee')
  })

  it('emits exactly one generated-by footer for the whole book', () => {
    const notes = [note({ id: 'a', content: 'x' }), note({ id: 'b', content: 'y' })]
    const md = renderBookMarkdown('Boek', '', [chapter('Een', ['a']), chapter('Twee', ['b'])], notes)
    expect(md.match(/Gegenereerd via ThoughtFoundry/g)).toHaveLength(1)
  })

  it('lists a table of contents only for multi-chapter books', () => {
    const notes = [note({ id: 'a', content: 'x' })]
    expect(renderBookMarkdown('B', '', [chapter('Een', ['a'])], notes)).not.toContain('## Inhoud')
    expect(renderBookMarkdown('B', '', [chapter('Een', ['a']), chapter('Twee', [])], notes)).toContain('## Inhoud')
  })
})

describe('slugify', () => {
  it('strips diacritics and punctuation into a filename-safe slug', () => {
    expect(slugify('Één café: het verhaal!')).toBe('een-cafe-het-verhaal')
  })
  it('caps length and trims stray dashes', () => {
    expect(slugify('-'.repeat(5) + 'a')).toBe('a')
    expect(slugify('x'.repeat(100)).length).toBeLessThanOrEqual(60)
  })
})
