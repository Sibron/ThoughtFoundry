/**
 * migrate-readwise.ts
 *
 * Converts a Readwise markdown export (the folder you get from
 * Readwise → Export → "Export to Markdown") into a ThoughtFoundry
 * ExportPayload JSON file that can be imported via Settings → Data-import.
 *
 * Each markdown file becomes one **source** (bron). Each highlight inside it
 * becomes one **note** of type 'literature' ("Bron"), linked to that source.
 * Nested "**Note:**" annotations become the note's mini_notes.
 *
 * Every note is written with status='verwerkt' and processed_at === created_at,
 * which is exactly what the in-app "Oude notities AI-verwerken" feature looks
 * for (see fetchNoteIdsNeedingReprocess in src/lib/notes.ts). So after importing
 * the JSON you can run that feature to give every highlight a proper AI title,
 * summary, themes and section — while content, mini_notes, note_type and the
 * source fields are preserved.
 *
 * Usage:
 *   READWISE_EXPORT_DIR=/path/to/unzipped/Readwise npx tsx scripts/migrate-readwise.ts
 *
 * Output:
 *   scripts/readwise-export.json  (ready to import in ThoughtFoundry Settings)
 */

import { randomUUID } from 'crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

// ── Config ──────────────────────────────────────────────────────────────────

const EXPORT_DIR = process.env['READWISE_EXPORT_DIR'] ?? '/tmp/readwise_export'
const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = join(__dirname, 'readwise-export.json')

// ── Types ───────────────────────────────────────────────────────────────────

type SourceType = 'book' | 'article' | 'paper' | 'podcast' | 'video' | 'course' | 'other'

interface SourceRecord {
  id: string
  title: string
  author: string | null
  type: SourceType
  year: null
  url: string | null
  summary: null
  tags: string[]
}

interface NoteRecord {
  id: string
  content: string
  mini_notes: string | null
  status: 'verwerkt'
  note_type: 'literature'
  core_idea: null
  use_for: null
  source_id: string
  source_title: string | null
  source_author: string | null
  source_url: string | null
  ai_title: string
  ai_summary: string
  tags: string[]
  section: null
  processed_at: string
  created_at: string
}

interface DocMeta {
  author: string | null
  fullTitle: string | null
  category: string | null
  tags: string[]
  url: string | null
}

interface ParsedHighlight {
  content: string
  note: string | null
  /** Per-highlight url (podcast snips carry their own share link). */
  url: string | null
}

// ── Helpers (mirrors scripts/migrate-notion.ts) ───────────────────────────────

/** Slugify a tag/theme name: lowercase, hyphenated, accent-stripped. */
function slugifyTag(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function ensureStop(s: string): string {
  if (!s) return s
  return /[.!?…:]$/.test(s) ? s : s + '.'
}

/** A short AI-title fallback: first line, capped at 80 chars. Reprocess overwrites it. */
function fallbackTitle(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim()
  return oneLine.length > 80 ? oneLine.slice(0, 79).trimEnd() + '…' : oneLine
}

/** A 1-2 sentence Dutch-agnostic summary fallback, capped ~200 chars. Reprocess overwrites it. */
function fallbackSummary(content: string): string {
  const prose = content.replace(/\s+/g, ' ').trim()
  if (!prose) return ''
  const sentences = prose.match(/[^.!?]+[.!?]+/g)
  let summary = sentences && sentences.length ? sentences.slice(0, 2).join(' ').trim() : prose
  if (summary.length > 200) summary = summary.slice(0, 197).trimEnd() + '…'
  return ensureStop(summary)
}

// ── Directory walk ────────────────────────────────────────────────────────────

/** Recursively collect every .md file under dir. */
function findMarkdownFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...findMarkdownFiles(full))
    } else if (entry.toLowerCase().endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

// ── Metadata parsing ──────────────────────────────────────────────────────────

const CATEGORY_TO_TYPE: Record<string, SourceType> = {
  books: 'book',
  articles: 'article',
  podcasts: 'podcast',
  tweets: 'other',
  supplementals: 'other',
}

/** Folder name (Books/Articles/Podcasts) → type, as a fallback when Category is absent. */
function folderFallbackType(filePath: string): SourceType {
  const lower = filePath.toLowerCase()
  if (lower.includes('/books/') || lower.includes('\\books\\')) return 'book'
  if (lower.includes('/articles/') || lower.includes('\\articles\\')) return 'article'
  if (lower.includes('/podcasts/') || lower.includes('\\podcasts\\')) return 'podcast'
  return 'other'
}

/** Split a "Document Tags" value into individual tag names. Handles both
 *  "#business #Favorites" and multi-word "#Second Brain". */
function parseDocTags(value: string): string[] {
  return value
    .split('#')
    .map((t) => t.trim())
    .filter(Boolean)
}

function parseMetadata(lines: string[]): DocMeta {
  const meta: DocMeta = { author: null, fullTitle: null, category: null, tags: [], url: null }
  for (const raw of lines) {
    const line = raw.trim()
    let m: RegExpMatchArray | null
    if ((m = line.match(/^-\s*Author:\s*(.+)$/i))) meta.author = m[1].trim() || null
    else if ((m = line.match(/^-\s*Full Title:\s*(.+)$/i))) meta.fullTitle = m[1].trim() || null
    else if ((m = line.match(/^-\s*Category:\s*(.+)$/i))) meta.category = m[1].replace(/^#/, '').trim().toLowerCase() || null
    else if ((m = line.match(/^-\s*Document Tags:\s*(.+)$/i))) meta.tags = parseDocTags(m[1])
    else if ((m = line.match(/^-\s*URL:\s*(.+)$/i))) meta.url = m[1].trim() || null
  }
  return meta
}

// ── Highlights parsing ────────────────────────────────────────────────────────

const SNIP_RE = /\s*\(\[Time[^\]]*\]\((https?:\/\/[^)]+)\)\)\s*$/

/**
 * Parse the body of the "### Highlights" section into individual highlights.
 * - "- text"                  (column 0)  → new highlight
 * - "    - **Note:** text"   (indented)  → annotation for the current highlight
 * - other indented non-empty lines       → continuation of the active block
 *   (the note if one is open, otherwise the highlight)
 */
function parseHighlights(lines: string[]): ParsedHighlight[] {
  const highlights: ParsedHighlight[] = []
  let cur: { content: string[]; note: string[] | null } | null = null

  const flush = () => {
    if (!cur) return
    const content = cur.content.join('\n').trim()
    const note = cur.note ? cur.note.join('\n').trim() : null
    if (content) {
      let url: string | null = null
      let cleaned = content
      const m = content.match(SNIP_RE)
      if (m) {
        url = m[1]
        cleaned = content.replace(SNIP_RE, '').trim()
      }
      highlights.push({ content: cleaned, note: note || null, url })
    }
    cur = null
  }

  for (const line of lines) {
    const topBullet = line.match(/^-\s+(.*)$/) // no leading whitespace
    const noteBullet = line.match(/^\s+-\s+\*\*Note:\*\*\s?(.*)$/i)

    if (topBullet) {
      flush()
      cur = { content: [topBullet[1]], note: null }
    } else if (noteBullet && cur) {
      cur.note = [noteBullet[1]]
    } else if (line.trim() && cur) {
      // Continuation of whichever block is currently open.
      if (cur.note) cur.note.push(line.trim())
      else cur.content.push(line.trim())
    }
    // blank lines and pre-highlight noise are ignored
  }
  flush()
  return highlights
}

/** Split a file into its Metadata lines and its Highlights lines. */
function splitSections(rawContent: string): { metaLines: string[]; highlightLines: string[]; h1: string } {
  const lines = rawContent.split('\n')
  const h1 = (lines[0] ?? '').replace(/^#+\s*/, '').trim()

  let section: 'none' | 'meta' | 'highlights' = 'none'
  const metaLines: string[] = []
  const highlightLines: string[] = []

  for (const line of lines) {
    const heading = line.match(/^###\s+(.+)$/)
    if (heading) {
      const name = heading[1].trim().toLowerCase()
      if (name === 'metadata') section = 'meta'
      else if (name === 'highlights') section = 'highlights'
      else section = 'none'
      continue
    }
    if (section === 'meta') metaLines.push(line)
    else if (section === 'highlights') highlightLines.push(line)
  }

  return { metaLines, highlightLines, h1 }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(EXPORT_DIR)) {
    console.error(`Export dir not found: ${EXPORT_DIR}`)
    console.error(`Set READWISE_EXPORT_DIR to the unzipped Readwise export folder.`)
    process.exit(1)
  }

  console.log('📂 Reading Readwise export from:', EXPORT_DIR)

  const files = findMarkdownFiles(EXPORT_DIR).sort()
  console.log(`   Markdown files: ${files.length}`)

  const sources: SourceRecord[] = []
  const notes: NoteRecord[] = []

  // Each note gets a unique, strictly-increasing created_at (== processed_at) so
  // (a) the "needs reprocess" filter matches and (b) highlight order is preserved.
  const baseTime = Date.now()
  let noteSeq = 0

  let skippedEmpty = 0
  const typeCount: Record<string, number> = {}

  for (const file of files) {
    const raw = readFileSync(file, 'utf-8')
    const { metaLines, highlightLines, h1 } = splitSections(raw)
    const meta = parseMetadata(metaLines)

    const title = meta.fullTitle || h1 || '(zonder titel)'
    const type = (meta.category && CATEGORY_TO_TYPE[meta.category]) || folderFallbackType(file)
    typeCount[type] = (typeCount[type] ?? 0) + 1

    const source: SourceRecord = {
      id: randomUUID(),
      title,
      author: meta.author,
      type,
      year: null,
      url: meta.url,
      summary: null,
      tags: [],
    }
    sources.push(source)

    const noteTags = [...new Set(meta.tags.map(slugifyTag).filter(Boolean))].slice(0, 5)

    const parsed = parseHighlights(highlightLines)
    for (const h of parsed) {
      if (!h.content) {
        skippedEmpty++
        continue
      }
      const stamp = new Date(baseTime + noteSeq * 1000).toISOString()
      noteSeq++

      notes.push({
        id: randomUUID(),
        content: h.content,
        mini_notes: h.note,
        status: 'verwerkt',
        note_type: 'literature',
        core_idea: null,
        use_for: null,
        source_id: source.id,
        source_title: title,
        source_author: meta.author,
        source_url: h.url ?? meta.url,
        ai_title: fallbackTitle(h.content),
        ai_summary: fallbackSummary(h.content),
        tags: noteTags,
        section: null,
        processed_at: stamp,
        created_at: stamp,
      })
    }
  }

  // ── Assemble ExportPayload ──────────────────────────────────────────────────
  const payload = {
    exported_at: new Date().toISOString(),
    schema_version: 1,
    notes,
    themes: [],
    note_themes: [],
    note_links: [],
    sources,
    chapters: [],
    books: [],
    ai_usage: [],
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n✅ Summary:`)
  console.log(`   Sources : ${sources.length} (${Object.entries(typeCount).map(([k, v]) => `${k}: ${v}`).join(', ')})`)
  console.log(`   Notes   : ${notes.length} highlights${skippedEmpty ? ` (${skippedEmpty} empty skipped)` : ''}`)
  const withNotes = notes.filter((n) => n.mini_notes).length
  console.log(`   Of which carry a "**Note:**" annotation: ${withNotes}`)

  const json = JSON.stringify(payload, null, 2)
  writeFileSync(OUT_PATH, json, 'utf-8')
  const kb = Math.round(Buffer.byteLength(json, 'utf-8') / 1024)
  console.log(`\n💾 Written: ${OUT_PATH} (${kb} KB)`)

  console.log(`\nNext steps:`)
  console.log(`  1. Open ThoughtFoundry → Settings → Data-import`)
  console.log(`  2. Choose scripts/readwise-export.json and click "Importeer"`)
  console.log(`  3. (optional) Settings → "Oude notities AI-verwerken" → "Start AI-herverwerking"`)
}

main()
