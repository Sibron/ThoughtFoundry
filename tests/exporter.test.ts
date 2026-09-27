import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fake, type Row } from './helpers/fake-supabase'

vi.mock('../src/lib/supabase', async (orig) => ({
  ...(await orig<typeof import('../src/lib/supabase')>()),
  supabase: (await import('./helpers/fake-supabase')).fake.client,
}))

const { buildExport, importFromJson } = await import('../src/lib/exporter')
type ExportPayload = import('../src/lib/exporter').ExportPayload

const ME = 'user-a'

// Every table the importer restores. ai_usage and user_settings are exported
// but deliberately never imported -- see the comment at the end of
// importFromJson.
const IMPORTED = [
  'themes', 'sources', 'book_projects', 'notes', 'note_themes', 'note_links',
  'note_book_projects', 'chapters', 'chapter_sections', 'chapter_section_revisions',
]

/** A small account that touches every table and every FK the importer orders by. */
function seedAccount(): void {
  fake.seed('sources', [
    { id: 's1', user_id: ME, title: 'Boek A', author: 'X', type: 'book' },
    { id: 's2', user_id: ME, title: 'Artikel B', author: null, type: 'article' },
  ])
  fake.seed('themes', [
    { id: 't1', user_id: ME, name: 'Autisme', parent_id: null, color: '#3AC48D' },
    { id: 't2', user_id: ME, name: 'Relaties', parent_id: 't1', color: '#3AC48D' },
  ])
  fake.seed('notes', [
    { id: 'n1', user_id: ME, content: 'eerste', status: 'verwerkt', source_id: 's1', embedding: [0.1, 0.2] },
    { id: 'n2', user_id: ME, content: 'tweede', status: 'inbox', source_id: null, embedding: null },
    { id: 'n3', user_id: ME, content: 'derde', status: 'archief', source_id: 's2', embedding: null },
  ])
  fake.seed('note_themes', [
    { note_id: 'n1', theme_id: 't1', user_id: ME },
    { note_id: 'n2', theme_id: 't2', user_id: ME },
    { note_id: 'n3', theme_id: 't1', user_id: ME },
  ])
  fake.seed('note_links', [{ id: 'l1', user_id: ME, source_id: 'n1', target_id: 'n2', type: 'builds_on', reason: 'r' }])
  fake.seed('book_projects', [{ id: 'p1', user_id: ME, title: 'Boek', core_question: 'Waarom?' }])
  fake.seed('note_book_projects', [{ note_id: 'n1', project_id: 'p1', user_id: ME }])
  fake.seed('chapters', [{ id: 'c1', user_id: ME, title: 'H1', theme_id: 't1', project_id: 'p1' }])
  fake.seed('chapter_sections', [{ id: 'cs1', user_id: ME, chapter_id: 'c1', body: 'tekst' }])
  fake.seed('chapter_section_revisions', [{ id: 'r1', user_id: ME, section_id: 'cs1', body: 'oud' }])
  fake.seed('user_settings', [{ user_id: ME, ai_enabled: true }])
  fake.seed('ai_usage', [{ id: 'u1', user_id: ME, cost_usd: 0.01 }])
}

const sorted = (rows: Row[] = []) => [...rows].map(r => JSON.stringify(r, Object.keys(r).sort())).sort()

function payload(p: Partial<ExportPayload>): ExportPayload {
  return {
    exported_at: '2026-09-27T00:00:00Z', schema_version: 3,
    notes: [], themes: [], note_themes: [], note_links: [], chapters: [], ai_usage: [],
    ...p,
  }
}

beforeEach(() => fake.reset())

describe('export → import round-trip', () => {
  it('restores every imported table exactly into an empty account', async () => {
    seedAccount()
    const exported = await buildExport()
    const original = fake.snapshot()

    fake.reset()
    const res = await importFromJson(structuredClone(exported))

    expect(res.errors).toEqual([])
    for (const t of IMPORTED) expect(sorted(fake.table(t)), t).toEqual(sorted(original[t]))
    expect(res.skipped).toBe(0)
  })

  it('never writes ai_usage or user_settings', async () => {
    seedAccount()
    const exported = await buildExport()
    expect(exported.ai_usage).toHaveLength(1)
    expect(exported.user_settings).toHaveLength(1)

    fake.reset()
    await importFromJson(exported)
    expect(fake.table('ai_usage')).toEqual([])
    expect(fake.table('user_settings')).toEqual([])
    expect(fake.writes('ai_usage') + fake.writes('user_settings')).toBe(0)
  })

  it('is a no-op the second time', async () => {
    seedAccount()
    const exported = await buildExport()
    fake.reset()
    await importFromJson(structuredClone(exported))
    const once = fake.snapshot()

    const again = await importFromJson(structuredClone(exported))
    expect(again.errors).toEqual([])
    expect(fake.snapshot()).toEqual(once)
  })
})

describe('older payload shapes', () => {
  it('imports a v1 note with retired note_type/tags stripped and its dangling source nulled', async () => {
    const res = await importFromJson(payload({
      schema_version: 1,
      notes: [{ id: 'n1', content: 'oud', status: 'inbox', note_type: 'fleeting', tags: ['a'], source_id: 'gone' }],
    }))

    const [note] = fake.table('notes')
    expect(note).toMatchObject({ id: 'n1', user_id: ME, source_id: null })
    expect(note).not.toHaveProperty('note_type')
    expect(note).not.toHaveProperty('tags')
    expect(res.errors).toEqual(['notitie n1: bronkoppeling verwijderd (bron ontbreekt in export)'])
  })

  it('skips v2 books with an error instead of failing', async () => {
    const res = await importFromJson(payload({
      schema_version: 2,
      notes: [{ id: 'n1', content: 'x' }],
      books: [{ id: 'b1', title: 'Oud boek' }],
    }))
    expect(fake.table('notes')).toHaveLength(1)
    expect(res.errors).toEqual(['1 boek(en) overgeslagen (boeken zijn opgegaan in projecten)'])
  })

  it('counts a note without id or content as skipped', async () => {
    const res = await importFromJson(payload({ notes: [{ id: 'n1', content: '' }, { content: 'geen id' }] }))
    expect(res.skipped).toBe(2)
    expect(fake.table('notes')).toEqual([])
  })
})

describe('merging into an existing account', () => {
  it('remaps a theme whose name already exists instead of duplicating it', async () => {
    fake.seed('themes', [{ id: 'mine', user_id: ME, name: 'Autisme' }])
    const res = await importFromJson(payload({
      themes: [{ id: 't1', name: 'Autisme' }],
      notes: [{ id: 'n1', content: 'x' }],
      note_themes: [{ note_id: 'n1', theme_id: 't1' }],
      chapters: [{ id: 'c1', title: 'H', theme_id: 't1' }],
    }))

    expect(res.errors).toEqual([])
    expect(fake.table('themes').map(t => t['id'])).toEqual(['mine'])
    expect(fake.table('note_themes')).toEqual([{ note_id: 'n1', theme_id: 'mine', user_id: ME }])
    expect(fake.table('chapters')[0]['theme_id']).toBe('mine')
  })

  it('merges a source on title and points the note at the existing one', async () => {
    fake.seed('sources', [{ id: 's-mine', user_id: ME, title: 'Boek A' }])
    const res = await importFromJson(payload({
      sources: [{ id: 's1', title: 'Boek A' }],
      notes: [{ id: 'n1', content: 'x', source_id: 's1' }],
    }))

    expect(res.errors).toEqual([])
    expect(fake.table('sources').map(s => s['id'])).toEqual(['s-mine'])
    expect(fake.table('notes')[0]['source_id']).toBe('s-mine')
  })

  it('keeps a source_id the payload lacks but the account already has', async () => {
    fake.seed('sources', [{ id: 's-mine', user_id: ME, title: 'Al aanwezig' }])
    const res = await importFromJson(payload({
      sources: [],
      notes: [{ id: 'n1', content: 'x', source_id: 's-mine' }, { id: 'n2', content: 'y', source_id: 'gone' }],
    }))

    expect(fake.table('notes').map(n => n['source_id'])).toEqual(['s-mine', null])
    expect(res.errors).toEqual(['notitie n2: bronkoppeling verwijderd (bron ontbreekt in export)'])
  })
})

describe('buildExport', () => {
  it('pages past the 1000-row cap on every table', async () => {
    fake.seed('note_themes', Array.from({ length: 2345 }, (_, i) => ({ note_id: `n${i}`, theme_id: 't', user_id: ME })))
    const exported = await buildExport()
    expect(exported.note_themes).toHaveLength(2345)
  })

  it('exports only the signed-in account', async () => {
    fake.seed('notes', [{ id: 'n1', user_id: ME, content: 'mijn' }, { id: 'n2', user_id: 'user-b', content: 'niet' }])
    const exported = await buildExport()
    expect(exported.notes).toEqual([{ id: 'n1', user_id: ME, content: 'mijn' }])
  })
})
