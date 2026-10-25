import { supabase, fetchAllRows } from './supabase'

export interface ExportPayload {
  exported_at: string
  // v1 omitted sources and the book/studio pipeline; v2 still had books,
  // note_type and tags. The importer accepts all versions (reads fall back to
  // [] and retired fields are stripped).
  schema_version: 1 | 2 | 3
  notes: unknown[]
  themes: unknown[]
  note_themes: unknown[]
  note_links: unknown[]
  chapters: unknown[]
  ai_usage: unknown[]
  books?: unknown[]
  sources?: unknown[]
  book_projects?: unknown[]
  note_book_projects?: unknown[]
  chapter_sections?: unknown[]
  chapter_section_revisions?: unknown[]
  user_settings?: unknown[]
}

// Stable per-table sort key, so the paged reads below are deterministic.
// Offset paging over an unordered result can skip and duplicate rows between
// pages; every one of these tables has a natural primary-key ordering.
const EXPORT_TABLES: { table: string; orderBy: string[] }[] = [
  { table: 'notes',                     orderBy: ['id'] },
  { table: 'themes',                    orderBy: ['id'] },
  { table: 'note_themes',               orderBy: ['note_id', 'theme_id'] },
  { table: 'note_links',                orderBy: ['id'] },
  { table: 'sources',                   orderBy: ['id'] },
  { table: 'book_projects',             orderBy: ['id'] },
  { table: 'note_book_projects',        orderBy: ['note_id', 'project_id'] },
  { table: 'chapters',                  orderBy: ['id'] },
  { table: 'chapter_sections',          orderBy: ['id'] },
  { table: 'chapter_section_revisions', orderBy: ['id'] },
  { table: 'user_settings',             orderBy: ['user_id'] },
  { table: 'ai_usage',                  orderBy: ['id'] },
]

/**
 * Full-account snapshot for the Data-export button.
 *
 * Every table is read through `fetchAllRows`. A bare `.select()` stops at
 * PostgREST's 1000-row default WITHOUT erroring, which is exactly the failure
 * this export must not have: the user downloads a file they believe is a
 * complete backup, and it silently ends at note 1000 (and at link 1000, and at
 * ai_usage row 1000). `ai_usage` and `note_themes` cross that line first.
 */
export async function buildExport(): Promise<ExportPayload> {
  const out: Partial<ExportPayload> = {
    exported_at: new Date().toISOString(),
    schema_version: 3
  }
  for (const { table, orderBy } of EXPORT_TABLES) {
    try {
      ;(out as Record<string, unknown>)[table] = await fetchAllRows<unknown>((from, to) => {
        let q = supabase.from(table).select('*')
        for (const col of orderBy) q = q.order(col, { ascending: true })
        return q.range(from, to)
      })
    } catch (err) {
      throw new Error(`${table}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return out as ExportPayload
}

export interface ImportResult {
  imported: number
  skipped: number
  errors: string[]
  themes: number
  sources: number
  links: number
  projects: number
  chapters: number
}

/** The stages of an import, in the FK order they must run in. */
export type ImportStage =
  | 'themes' | 'sources' | 'projects' | 'notes' | 'note_themes'
  | 'links' | 'note_projects' | 'chapters' | 'sections' | 'revisions'

export interface ImportProgress { stage: ImportStage; done: number; total: number }

type Row = Record<string, unknown>

// Rows per request. 1000 keeps a request well inside PostgREST's limits; notes
// carry their vector(384) embedding (~8 KB of JSON each), so they go in
// smaller batches.
const CHUNK = 1000
const NOTE_CHUNK = 100

/**
 * Restores an export into the signed-in account.
 *
 * Each stage is one batched upsert per chunk rather than one request per row:
 * a 209-note export used to take ~800 sequential round-trips. The stages run
 * in FK order -- themes and sources before notes, projects before the
 * note/project junction and chapters, chapters before sections before
 * revisions -- and within a stage the rows are independent, so batching them
 * changes nothing about what lands.
 *
 * Merging into an existing account is resolved in memory: the account's themes
 * and sources are read once, and an incoming theme whose name (or source whose
 * title) already exists is remapped onto it instead of duplicated.
 *
 * Error granularity: a chunk fails as a unit, so a failed chunk is retried one
 * row at a time. The good rows still land and `errors` names each row that did
 * not -- the same per-row messages the old importer produced, with the extra
 * requests paid only when something is wrong.
 *
 * Counts are rows actually inserted. Upserts ignore duplicates, so a row that
 * already exists (same id) is counted in `skipped`, and re-importing the same
 * file reports nothing imported.
 */
export async function importFromJson(
  payload: ExportPayload,
  onProgress?: (p: ImportProgress) => void
): Promise<ImportResult> {
  const { data: { user } } = await supabase.auth.getUser()
  const userId = user?.id
  if (!userId) throw new Error('Niet aangemeld')

  const result: ImportResult = { imported: 0, skipped: 0, errors: [], themes: 0, sources: 0, links: 0, projects: 0, chapters: 0 }
  // Copies: the caller's payload is never mutated, so a failed import can be
  // retried with the same object.
  const rowsOf = (list: unknown[] | undefined): Row[] => ((list ?? []) as Row[]).map(r => ({ ...r }))

  /**
   * Upserts `rows` into `table` in chunks, falling back to one row at a time
   * for a chunk that fails. Returns how many rows were inserted and which rows
   * failed outright.
   */
  async function write(
    stage: ImportStage,
    table: string,
    rows: Row[],
    onConflict: string,
    describe: (row: Row) => string,
    size = CHUNK
  ): Promise<{ inserted: number; failed: Row[] }> {
    const send = (batch: Row[]) => supabase
      .from(table)
      .upsert(batch, { onConflict, ignoreDuplicates: true, defaultToNull: false })
      // Returns only the rows actually inserted -- an ignored duplicate is
      // not in the response -- which is what makes the counts honest.
      .select(onConflict.split(',')[0])
    let inserted = 0
    const failed: Row[] = []
    onProgress?.({ stage, done: 0, total: rows.length })
    for (let i = 0; i < rows.length; i += size) {
      const chunk = rows.slice(i, i + size)
      const { data, error } = await send(chunk)
      if (!error) {
        inserted += (data ?? []).length
      } else {
        for (const row of chunk) {
          const one = await send([row])
          if (one.error) {
            failed.push(row)
            result.errors.push(`${describe(row)}: ${one.error.message}`)
          } else {
            inserted += (one.data ?? []).length
          }
        }
      }
      onProgress?.({ stage, done: Math.min(i + size, rows.length), total: rows.length })
    }
    return { inserted, failed }
  }

  // ── Themes — merge by name, track id remapping ────────────────────────────
  const existingThemes = await fetchAllRows<{ id: string; name: string }>((from, to) =>
    supabase.from('themes').select('id, name').eq('user_id', userId).order('id', { ascending: true }).range(from, to))
  const themeByName = new Map(existingThemes.map(t => [t.name, t.id]))
  const themeIdRemap = new Map<string, string>()
  const newThemes: Row[] = []
  for (const raw of rowsOf(payload.themes)) {
    const name = String(raw['name'] ?? '').trim()
    const jsonId = String(raw['id'] ?? '')
    if (!name || !jsonId) continue
    const known = themeByName.get(name)
    if (known) { themeIdRemap.set(jsonId, known); continue }
    // A second theme with this name later in the same file merges into this one.
    themeByName.set(name, jsonId)
    themeIdRemap.set(jsonId, jsonId)
    newThemes.push({ ...raw, user_id: userId, id: jsonId })
  }
  // A parent merged onto an existing theme has a different id here. FKs are
  // checked at the end of each statement, so a child listed before its parent
  // in the same chunk is fine.
  for (const t of newThemes) {
    if (t['parent_id']) t['parent_id'] = themeIdRemap.get(String(t['parent_id'])) ?? t['parent_id']
  }
  result.themes = (await write('themes', 'themes', newThemes, 'id',
    t => `theme "${String(t['name'])}"`)).inserted

  // ── Sources — before notes (notes.source_id FK); merge by title ───────────
  const existingSources = await fetchAllRows<{ id: string; title: string }>((from, to) =>
    supabase.from('sources').select('id, title').eq('user_id', userId).order('id', { ascending: true }).range(from, to))
  const existingSourceIds = new Set(existingSources.map(s => s.id))
  const sourceByTitle = new Map<string, string>()
  for (const s of existingSources) if (!sourceByTitle.has(s.title)) sourceByTitle.set(s.title, s.id)
  const sourceIdRemap = new Map<string, string>()
  const newSources: Row[] = []
  for (const raw of rowsOf(payload.sources)) {
    const title = String(raw['title'] ?? '').trim()
    const jsonId = String(raw['id'] ?? '')
    if (!title || !jsonId) continue
    const known = sourceByTitle.get(title)
    if (known) { sourceIdRemap.set(jsonId, known); continue }
    sourceByTitle.set(title, jsonId)
    sourceIdRemap.set(jsonId, jsonId)
    newSources.push({ ...raw, user_id: userId })
  }
  const sources = await write('sources', 'sources', newSources, 'id', s => `source "${String(s['title'])}"`)
  result.sources = sources.inserted
  // A source that failed to land must not be pointed at by a note.
  for (const s of sources.failed) sourceIdRemap.delete(String(s['id']))

  // ── Book projects — before the note/project junction and chapters ─────────
  const projects = rowsOf(payload.book_projects).filter(r => r['id']).map(r => ({ ...r, user_id: userId }))
  result.projects = (await write('projects', 'book_projects', projects, 'id',
    r => `project "${String(r['title'] ?? r['id'])}"`)).inserted

  // ── Notes ─────────────────────────────────────────────────────────────────
  const notes: Row[] = []
  for (const note of rowsOf(payload.notes)) {
    if (!note['id'] || !note['content']) { result.skipped++; continue }

    // Retired columns from v1/v2 exports (model simplification) — strip so the
    // upsert doesn't hit unknown-column errors.
    delete note['note_type']
    delete note['tags']

    // notes.source_id has an enforced FK; a dangling reference (v1 exports
    // never contained sources) must not reject the whole note.
    const sourceId = note['source_id'] ? String(note['source_id']) : null
    if (sourceId) {
      const mapped = sourceIdRemap.get(sourceId) ?? (existingSourceIds.has(sourceId) ? sourceId : null)
      note['source_id'] = mapped
      if (!mapped) result.errors.push(`notitie ${String(note['id'])}: bronkoppeling verwijderd (bron ontbreekt in export)`)
    }
    notes.push({ ...note, user_id: userId })
  }
  const writtenNotes = await write('notes', 'notes', notes, 'id', n => String(n['id']), NOTE_CHUNK)
  result.imported = writtenNotes.inserted
  result.skipped += notes.length - writtenNotes.inserted - writtenNotes.failed.length

  // ── note_themes — remap theme ids where a name collision merged the theme ─
  const noteThemes = rowsOf(payload.note_themes)
    .filter(r => r['note_id'] && r['theme_id'])
    .map(r => ({
      note_id: String(r['note_id']),
      theme_id: themeIdRemap.get(String(r['theme_id'])) ?? String(r['theme_id']),
      user_id: userId,
    }))
  await write('note_themes', 'note_themes', noteThemes, 'note_id,theme_id',
    r => `note_theme ${String(r['note_id'])}→${String(r['theme_id'])}`)

  // ── note_links ────────────────────────────────────────────────────────────
  // The "link" prefix is what settings.ts counts to summarise link failures.
  const links = rowsOf(payload.note_links).filter(r => r['source_id'] && r['target_id']).map(r => ({ ...r, user_id: userId }))
  result.links = (await write('links', 'note_links', links, 'source_id,target_id', () => 'link')).inserted

  // ── note_book_projects (junction) ─────────────────────────────────────────
  const noteProjects = rowsOf(payload.note_book_projects).filter(r => r['note_id'] && r['project_id']).map(r => ({ ...r, user_id: userId }))
  await write('note_projects', 'note_book_projects', noteProjects, 'note_id,project_id', () => 'note_project')

  // ── Chapters → sections → revisions (FK order) ────────────────────────────
  const chapters = rowsOf(payload.chapters).filter(r => r['id']).map(r => {
    const themeId = r['theme_id'] ? String(r['theme_id']) : null
    return { ...r, ...(themeId ? { theme_id: themeIdRemap.get(themeId) ?? themeId } : {}), user_id: userId }
  })
  result.chapters = (await write('chapters', 'chapters', chapters, 'id',
    r => `hoofdstuk "${String(r['title'] ?? r['id'])}"`)).inserted

  // 'books' from v1/v2 exports is skipped: boekenbundels zijn opgegaan in
  // projecten en de tabel bestaat niet meer.
  if ((payload.books ?? []).length > 0) {
    result.errors.push(`${(payload.books ?? []).length} boek(en) overgeslagen (boeken zijn opgegaan in projecten)`)
  }

  const sections = rowsOf(payload.chapter_sections).filter(r => r['id']).map(r => ({ ...r, user_id: userId }))
  await write('sections', 'chapter_sections', sections, 'id', () => 'sectie')

  const revisions = rowsOf(payload.chapter_section_revisions).filter(r => r['id']).map(r => ({ ...r, user_id: userId }))
  await write('revisions', 'chapter_section_revisions', revisions, 'id', () => 'revisie')

  // ai_usage and user_settings are exported for completeness (cost history,
  // preferences) but deliberately not imported: usage history belongs to the
  // account that spent it, and silently overwriting live preferences would
  // surprise the user.

  return result
}

export function downloadJson(payload: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8'
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
