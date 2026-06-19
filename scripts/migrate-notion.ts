/**
 * migrate-notion.ts
 *
 * Converts a Notion "IDEAS Zettelkasten" export into a ThoughtFoundry
 * ExportPayload JSON file that can be imported via Settings → Import.
 *
 * Usage:
 *   NOTION_EXPORT_DIR=/tmp/db_export npx tsx scripts/migrate-notion.ts
 *
 * Output:
 *   scripts/migration-export.json  (ready to import in ThoughtFoundry Settings)
 */

import { parse } from 'csv-parse/sync'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

// ── Config ────────────────────────────────────────────────────────────────────

const EXPORT_DIR = process.env['NOTION_EXPORT_DIR'] ?? '/tmp/db_export'
const CSV_NAME = 'IDEASZettelkasten de29c270d6224c24ae72c6ad7d1a6154_all.csv'
const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = join(__dirname, 'migration-export.json')

// ── Types ─────────────────────────────────────────────────────────────────────

type NoteType = 'permanent' | 'question' | 'literature' | 'fleeting' | 'reflection' | 'framework'

interface CsvRow {
  Title: string
  AREAS: string
  'Created time': string
  Ideas: string
  Media: string
  Network: string
  'Note Type': string
  'Related to Projects': string
  '📚 Persons': string
}

interface MarkdownInfo {
  rawUuid: string      // 32-char hex
  h1: string
  rawContent: string
}

interface MigrationNote {
  id: string
  content: string
  ai_title: string
  note_type: NoteType
  status: 'verwerkt'
  core_idea: string | null
  source_author: string | null
  source_title: string | null
  source_id: string | null
  tags: string[]
  processed_at: string
  created_at: string
  // Internal — not written to JSON
  _rawUuid: string
  _areas: string[]
  _ideaUuids: string[]
  _primaryPersonName: string | null
}

interface ThemeRecord {
  id: string
  name: string
  color: string
  description: null
  parent_id: null
  is_sensitive: false
}

interface SourceRecord {
  id: string
  title: string
  type: 'other'
  url: string | null
  author: null
  year: null
  summary: null
  tags: []
}

interface NoteThemeRow {
  note_id: string
  theme_id: string
}

interface NoteLinkRow {
  id: string
  source_id: string
  target_id: string
  type: 'related'
  reason: null
}

// ── AREAS normalisation ───────────────────────────────────────────────────────
// The original Notion areas mix Dutch and English ("Leren / Learning"),
// use inconsistent casing ("adhd"), contain spelling slips, and include several
// singletons that are really the same concept. This map makes every theme a
// single coherent Dutch name and merges the obvious duplicates.
// Anything not listed here is kept as-is (already coherent).

const AREA_NORMALIZE: Record<string, string> = {
  // ── Language: drop the English half / translate to Dutch ──
  'Leren / Learning': 'Leren',
  'Personal growth': 'Persoonlijke groei',
  'Gezondheid / Health and Wellness': 'Gezondheid',
  'Content Production': 'Contentcreatie',
  'Video creating': 'Videocreatie',
  'Website creating': 'Websitecreatie',
  'Ondernemen / Entrepreneurship': 'Ondernemen',
  'Beroep/ Work': 'Werk',
  'Toekomst / future': 'Toekomst',
  'Huis / House / Home': 'Huis',
  'Tuin / Garden': 'Tuin',
  'Schrijven / Writing': 'Schrijven',
  'Afslanken / Weight control': 'Afslanken',
  'Bijberoep / Sidejob': 'Bijberoep',
  'Apps/ Tool': 'Apps & tools',
  'Studeren / Education': 'Studeren',
  'Koken / Cooking': 'Koken',
  'Slaap / Sleep': 'Slaap',
  'Genetica / DNA': 'Genetica',
  'Voeding / Food': 'Voeding',
  'Vrouw / Female': 'Vrouw',
  'Karakter / Personality': 'Karakter',
  'Uitspraken / Quotes': 'Citaten',
  'Public Speaking': 'Spreken in het openbaar',
  'Exponential growth': 'Exponentiële groei',
  'Task Management': 'Productiviteit',
  'Project Management': 'Projectmanagement',
  'Project Managment': 'Projectmanagement',
  'Job Crafting': 'Job crafting',
  'Introvert / Extravert': 'Introvert/extravert',
  'Nature/Nurture': 'Nature/nurture',

  // ── Casing / spelling fixes ──
  'adhd': 'ADHD',
  'Electriciteit': 'Elektriciteit',
  'Sexualiteit': 'Seksualiteit',
  'Groepdynamiek': 'Groepsdynamiek',

  // ── Merge redundant singletons into one concept ──
  'Zetelkasten': 'Kennismanagement',
  'Zettelkasten': 'Kennismanagement',
  'Second Brain': 'Kennismanagement',
  'Knowledge Management': 'Kennismanagement',
  'Band / Connectie / Relaties': 'Relaties',
  'Relatie': 'Relaties',
  'Metafoor/Uitspraak': 'Citaten',
  'Heritabiliteit': 'Nature/nurture',
  'Business': 'Ondernemen',
}

// ── Color palette — assigned alphabetically across themes ─────────────────────

const COLORS = [
  '#3AC48D', // green (default)
  '#6C8EF7', // indigo
  '#F4A261', // orange
  '#E76F51', // coral
  '#2A9D8F', // teal
  '#E9C46A', // yellow
  '#8B5CF6', // violet
  '#A8DADC', // sky
  '#EF4444', // red
  '#457B9D', // blue
]

// ── Markdown metadata key prefixes to strip from body ─────────────────────────

const META_PREFIXES = [
  'Created time:',
  'AREAS:',
  'Note Type:',
  'Ideas:',
  'Media:',
  'Network:',
  '📚 Persons:',
  'Related to Projects:',
]

// ── CSV parser ────────────────────────────────────────────────────────────────

function parseCSV(filePath: string): CsvRow[] {
  const buf = readFileSync(filePath)
  // Strip UTF-8 BOM (EF BB BF) if present
  const content =
    buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
      ? buf.slice(3).toString('utf-8')
      : buf.toString('utf-8')

  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    trim: false,
  }) as CsvRow[]
}

// ── Markdown indexing ─────────────────────────────────────────────────────────

function indexMarkdownFiles(dir: string): Map<string, MarkdownInfo> {
  const map = new Map<string, MarkdownInfo>()
  const UUID_RE = /([0-9a-f]{32})\.md$/i

  for (const filename of readdirSync(dir)) {
    const m = filename.match(UUID_RE)
    if (!m) continue

    const rawUuid = m[1].toLowerCase()
    const rawContent = readFileSync(join(dir, filename), 'utf-8')
    const firstLine = rawContent.split('\n')[0] ?? ''
    const h1 = firstLine.replace(/^#+\s*/, '').trim()

    map.set(rawUuid, { rawUuid, h1, rawContent })
  }

  return map
}

function buildTitleIndex(mdIndex: Map<string, MarkdownInfo>): Map<string, string> {
  const map = new Map<string, string>()
  for (const [uuid, info] of mdIndex) {
    map.set(info.h1, uuid)
  }
  return map
}

// ── Field parsers ─────────────────────────────────────────────────────────────

/** Parses "Name (https://...)" comma-separated list. Returns [{name, url}] */
function parseNameUrlList(str: string): { name: string; url: string }[] {
  if (!str.trim()) return []
  const results: { name: string; url: string }[] = []
  const re = /([^,(]+?)\s*\((https?:\/\/[^)]+)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(str)) !== null) {
    const name = m[1].trim()
    if (name) results.push({ name, url: m[2].trim() })
  }
  return results
}

function parseAreas(str: string): string[] {
  const out = parseNameUrlList(str)
    .map(({ name }) => {
      const clean = name.trim()
      return AREA_NORMALIZE[clean] ?? clean
    })
    .filter(Boolean)
  // Dedupe within a single note (merges can collapse two areas into one)
  return [...new Set(out)]
}

function parsePersons(str: string): { name: string; url: string }[] {
  return parseNameUrlList(str)
}

/** Extract 32-char hex UUIDs from Ideas field (works for .csv and .md refs) */
function parseIdeaUuids(str: string): string[] {
  if (!str.trim()) return []
  const re = /([0-9a-f]{32})\.(csv|md)/gi
  return [...str.matchAll(re)].map(m => m[1].toLowerCase())
}

function parseMediaTitle(str: string): string | null {
  if (!str.trim()) return null
  // Strip the trailing Notion URL reference "(https://...)" and trim
  const title = str.replace(/\s*\(https?:\/\/[^)]+\)\s*$/, '').trim()
  return title || null
}

function parseCreatedAt(str: string): string {
  const d = new Date(str.trim())
  if (isNaN(d.getTime())) {
    console.warn(`  ⚠  Could not parse date: "${str}" — using now()`)
    return new Date().toISOString()
  }
  return d.toISOString()
}

/**
 * Decides the note type from the actual content rather than trusting Notion's
 * label (which marked nearly everything "Permanent Note"). The principle:
 *   - A permanent note is a developed idea written out in prose.
 *   - A note that is sourced from a book/article/tool is a literature note.
 *   - A bare one-line capture with no body is a fleeting note — it still needs
 *     to be worked out, however good the one-liner is.
 *   - A note phrased as a question is a question note.
 */
function mapNoteType(
  notionType: string,
  title: string,
  hasMedia: boolean,
  hasBody: boolean,
): NoteType {
  const t = title.trim()

  // Questions first — they're a distinct kind regardless of body
  if (notionType.trim() === 'Question' || t.endsWith('?')) return 'question'

  // Backed by an external source → literature note
  const isResourceRef = /^(course|tool|book|boek|podcast|video|cursus)\s*:/i.test(t) || /https?:\/\//i.test(t)
  if (hasMedia || isResourceRef) return 'literature'

  // Developed prose → genuine permanent note
  if (hasBody) return 'permanent'

  // Bare title, no source, no body → undeveloped capture
  return 'fleeting'
}

// ── Markdown body extractor ───────────────────────────────────────────────────

function stripMarkdownBody(rawContent: string): string {
  const lines = rawContent.split('\n')
  const bodyLines: string[] = []
  let pastMeta = false

  for (let i = 0; i < lines.length; i++) {
    // Always skip H1 (first line)
    if (i === 0) continue

    const stripped = lines[i].trim()

    if (!pastMeta) {
      const isMeta =
        !stripped || META_PREFIXES.some(k => stripped.startsWith(k))
      if (!isMeta) pastMeta = true
    }

    if (pastMeta) {
      bodyLines.push(lines[i])
    }
  }

  return bodyLines.join('\n').trim()
}

function isEmptyBody(body: string): boolean {
  // Body is "empty" if it only contains headings, lone hyphens, or Notion template noise
  const lines = body.split('\n')
  const meaningful = lines.filter(l => {
    const s = l.trim()
    return s && !s.startsWith('#') && s !== '-' && s !== '*' && s !== '---'
  })
  return meaningful.length === 0
}

function extractCoreIdea(body: string, fallback: string): string | null {
  if (!body || isEmptyBody(body)) return fallback.trim().slice(0, 280) || null

  const firstReal = body.split('\n').find(l => {
    const s = l.trim()
    return s && !s.startsWith('#') && s !== '-' && s !== '*'
  })
  if (!firstReal) return fallback.trim().slice(0, 280) || null

  const sentence = firstReal.trim().match(/^[^.!?]*[.!?]/)
  const idea = sentence ? sentence[0].trim() : firstReal.trim()
  return idea.slice(0, 280) || null
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const csvPath = join(EXPORT_DIR, CSV_NAME)

  if (!existsSync(csvPath)) {
    console.error(`CSV not found: ${csvPath}`)
    console.error(`Set NOTION_EXPORT_DIR to the extracted Notion export folder.`)
    process.exit(1)
  }

  console.log('📂 Reading Notion export from:', EXPORT_DIR)

  // ── 1. Load data ────────────────────────────────────────────────────────────

  const rows = parseCSV(csvPath)
  const mdIndex = indexMarkdownFiles(EXPORT_DIR)
  const titleToUuid = buildTitleIndex(mdIndex)

  console.log(`   CSV rows: ${rows.length}`)
  console.log(`   Markdown files: ${mdIndex.size}`)

  // ── 2. Build themes map ─────────────────────────────────────────────────────

  const themeByName = new Map<string, ThemeRecord>()

  for (const row of rows) {
    for (const name of parseAreas(row.AREAS)) {
      if (!themeByName.has(name)) {
        themeByName.set(name, {
          id: randomUUID(),
          name,
          color: '',
          description: null,
          parent_id: null,
          is_sensitive: false,
        })
      }
    }
  }

  // Assign colors alphabetically for deterministic output
  const sortedNames = [...themeByName.keys()].sort()
  sortedNames.forEach((name, i) => {
    themeByName.get(name)!.color = COLORS[i % COLORS.length]
  })

  console.log(`\n🎨 Themes collected: ${themeByName.size}`)

  // ── 3. Build sources map (persons) ─────────────────────────────────────────

  const sourceByName = new Map<string, SourceRecord>()

  for (const row of rows) {
    for (const { name, url } of parsePersons(row['📚 Persons'])) {
      if (!sourceByName.has(name)) {
        sourceByName.set(name, {
          id: randomUUID(),
          title: name,
          type: 'other',
          url,
          author: null,
          year: null,
          summary: null,
          tags: [],
        })
      }
    }
  }

  console.log(`👤 Sources (persons) collected: ${sourceByName.size}`)

  // ── 4. Build notes ──────────────────────────────────────────────────────────

  // Pre-assign UUIDs so we can resolve cross-links in a second pass
  const notionUuidToDbId = new Map<string, string>()
  const notes: MigrationNote[] = []
  let noMatchCount = 0

  for (const row of rows) {
    const title = row.Title.trim()
    const rawUuid = titleToUuid.get(title)
    const mdInfo = rawUuid ? mdIndex.get(rawUuid) : undefined

    if (!rawUuid || !mdInfo) {
      noMatchCount++
      if (noMatchCount <= 5) {
        console.warn(`  ⚠  No markdown match for: "${title.slice(0, 60)}"`)
      }
    }

    const rawBody = mdInfo ? stripMarkdownBody(mdInfo.rawContent) : ''
    const cleanBody = rawBody && !isEmptyBody(rawBody) ? rawBody : ''
    const content = cleanBody || title

    const persons = parsePersons(row['📚 Persons'])
    const primaryPerson = persons[0] ?? null
    const extraPersons = persons.slice(1)

    const hasMedia = Boolean(row.Media.trim())
    const hasBody = Boolean(cleanBody)
    const noteType = mapNoteType(row['Note Type'], title, hasMedia, hasBody)
    const createdAt = parseCreatedAt(row['Created time'])
    const dbId = randomUUID()

    if (rawUuid) notionUuidToDbId.set(rawUuid, dbId)

    notes.push({
      id: dbId,
      content,
      ai_title: title,
      note_type: noteType,
      status: 'verwerkt',
      core_idea: extractCoreIdea(cleanBody, title),
      source_author: primaryPerson?.name ?? null,
      source_title: parseMediaTitle(row.Media),
      source_id: primaryPerson ? (sourceByName.get(primaryPerson.name)?.id ?? null) : null,
      tags: extraPersons.map(p => p.name),
      processed_at: createdAt,
      created_at: createdAt,
      _rawUuid: rawUuid ?? '',
      _areas: parseAreas(row.AREAS),
      _ideaUuids: parseIdeaUuids(row.Ideas),
      _primaryPersonName: primaryPerson?.name ?? null,
    })
  }

  console.log(`📝 Notes prepared: ${notes.length} (${noMatchCount} without markdown body)`)

  // ── 5. Build note_themes ────────────────────────────────────────────────────

  const noteThemes: NoteThemeRow[] = []

  for (const note of notes) {
    for (const areaName of note._areas) {
      const theme = themeByName.get(areaName)
      if (!theme) continue
      noteThemes.push({ note_id: note.id, theme_id: theme.id })
    }
  }

  console.log(`🔗 note_themes: ${noteThemes.length}`)

  // ── 6. Build note_links (deduplicated bidirectionally) ──────────────────────

  const noteLinks: NoteLinkRow[] = []
  const seenPairs = new Set<string>()
  let unresolvedCount = 0

  for (const note of notes) {
    for (const targetRawUuid of note._ideaUuids) {
      const targetDbId = notionUuidToDbId.get(targetRawUuid)
      if (!targetDbId) {
        unresolvedCount++
        continue
      }
      if (targetDbId === note.id) continue // self-link, skip

      const [a, b] = [note.id, targetDbId].sort()
      const key = `${a}|${b}`
      if (seenPairs.has(key)) continue
      seenPairs.add(key)

      noteLinks.push({
        id: randomUUID(),
        source_id: note.id,
        target_id: targetDbId,
        type: 'related',
        reason: null,
      })
    }
  }

  console.log(`↔  note_links: ${noteLinks.length} (${unresolvedCount} unresolved refs)`)

  // ── 7. Assemble ExportPayload ───────────────────────────────────────────────

  // Strip internal fields before serializing
  const cleanNotes = notes.map(
    ({ _rawUuid: _r, _areas: _a, _ideaUuids: _i, _primaryPersonName: _p, ...rest }) => rest,
  )

  const payload = {
    exported_at: new Date().toISOString(),
    schema_version: 1,
    notes: cleanNotes,
    themes: [...themeByName.values()],
    note_themes: noteThemes,
    note_links: noteLinks,
    sources: [...sourceByName.values()],
    chapters: [],
    books: [],
    ai_usage: [],
  }

  // ── 8. Print summary ────────────────────────────────────────────────────────

  const noteTypeBreakdown = Object.entries(
    notes.reduce<Record<string, number>>((acc, n) => {
      acc[n.note_type] = (acc[n.note_type] ?? 0) + 1
      return acc
    }, {}),
  )
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ')

  console.log(`\n✅ Summary:`)
  console.log(`   Notes     : ${cleanNotes.length} (${noteTypeBreakdown})`)
  console.log(`   Themes    : ${payload.themes.length}`)
  console.log(`   Sources   : ${payload.sources.length}`)
  console.log(`   note_themes: ${payload.note_themes.length}`)
  console.log(`   note_links : ${payload.note_links.length}`)

  // ── 9. Write output ─────────────────────────────────────────────────────────

  const json = JSON.stringify(payload, null, 2)
  writeFileSync(OUT_PATH, json, 'utf-8')

  const kb = Math.round(Buffer.byteLength(json, 'utf-8') / 1024)
  console.log(`\n💾 Written: ${OUT_PATH} (${kb} KB)`)
  console.log(`\nNext steps:`)
  console.log(`  1. Open ThoughtFoundry → Settings`)
  console.log(`  2. Click "Importeer bestand" and select scripts/migration-export.json`)
  console.log(`  3. Click "Importeer"`)
}

main()
