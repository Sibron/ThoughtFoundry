// Manuscript composition — one place that turns chapters into Markdown, used
// by the chapter workbench, the Boeken bundles and the project Manuscript tab.
//
// Prose-first: a section written in the studio (content_md) exports its own
// text; an unwritten section falls back to assembling its attached notes.

import { fetchSections, type Chapter } from './chapters'
import type { Note } from './notes'

export interface ManuscriptSection {
  heading: string
  intent: string
  note_ids: string[]
  content_md?: string | null
}

export interface ManuscriptChapter {
  title: string
  summary: string
  sections: ManuscriptSection[]
}

/** Studio section rows when they exist, outline JSONB otherwise. */
export async function resolveChapterSections(c: Chapter): Promise<ManuscriptSection[]> {
  try {
    const rows = await fetchSections(c.id)
    if (rows.length > 0) {
      return rows.map(r => ({
        heading: r.heading,
        intent: r.intent ?? '',
        note_ids: r.note_ids,
        content_md: r.content_md
      }))
    }
  } catch { /* un-migrated client — outline fallback */ }
  return c.outline
}

export function renderChapterMarkdown(ch: ManuscriptChapter, notes: Note[]): string {
  const byId: Record<string, Note> = {}
  notes.forEach(n => { byId[n.id] = n })

  const lines: string[] = []
  lines.push(`# ${ch.title}`, '')
  if (ch.summary) lines.push(`> ${ch.summary}`, '')

  ch.sections.forEach(s => {
    lines.push(`## ${s.heading}`, '')
    if (s.content_md?.trim()) {
      lines.push(s.content_md.trim(), '')
      return
    }
    if (s.intent) lines.push(`*${s.intent}*`, '')
    s.note_ids.forEach(id => {
      const n = byId[id]
      if (!n) return
      const head = n.ai_title ?? n.content.slice(0, 80)
      lines.push(`### ${head}`, '')
      lines.push(n.content, '')
      if (n.mini_notes) lines.push(`> ${n.mini_notes}`, '')
      if (n.source_url) lines.push(`[bron](${n.source_url})`, '')
    })
  })

  lines.push('---', `*Gegenereerd via ThoughtFoundry — ${new Date().toLocaleDateString('nl-NL')}*`)
  return lines.join('\n')
}

export function renderBookMarkdown(
  title: string,
  intro: string,
  chapters: ManuscriptChapter[],
  notes: Note[],
  motto?: string
): string {
  const lines: string[] = []
  lines.push(`# ${title}`, '')
  if (motto) lines.push(`> ${motto}`, '')
  if (intro) lines.push(intro, '')

  if (chapters.length > 1) {
    lines.push('## Inhoud', '')
    chapters.forEach((c, i) => {
      lines.push(`${i + 1}. ${c.title}`)
    })
    lines.push('')
  }

  chapters.forEach((c, i) => {
    lines.push('---', '')
    const md = renderChapterMarkdown({ ...c, title: `Hoofdstuk ${i + 1}: ${c.title}` }, notes)
    // Strip the trailing "Gegenereerd via" footer per chapter
    const trimmed = md.split('\n---\n')[0]
    lines.push(trimmed, '')
  })

  lines.push('---', `*Gegenereerd via ThoughtFoundry — ${new Date().toLocaleDateString('nl-NL')}*`)
  return lines.join('\n')
}

export function downloadMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
}
