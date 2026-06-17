import { supabase } from './supabase'

export interface ExportPayload {
  exported_at: string
  schema_version: 1
  notes: unknown[]
  themes: unknown[]
  note_themes: unknown[]
  note_links: unknown[]
  chapters: unknown[]
  books: unknown[]
  ai_usage: unknown[]
}

export async function buildExport(): Promise<ExportPayload> {
  const tables = ['notes', 'themes', 'note_themes', 'note_links', 'chapters', 'books', 'ai_usage'] as const
  const out: Partial<ExportPayload> = {
    exported_at: new Date().toISOString(),
    schema_version: 1
  }
  for (const t of tables) {
    const { data, error } = await supabase.from(t).select('*')
    if (error) throw new Error(`${t}: ${error.message}`)
    ;(out as Record<string, unknown>)[t] = data ?? []
  }
  return out as ExportPayload
}

export interface ImportResult {
  imported: number
  skipped: number
  errors: string[]
}

export async function importFromJson(payload: ExportPayload): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, skipped: 0, errors: [] }
  const notes = (payload.notes ?? []) as Record<string, unknown>[]

  for (const note of notes) {
    if (!note['id'] || !note['content']) { result.skipped++; continue }
    const { error } = await supabase
      .from('notes')
      .upsert(note, { onConflict: 'id', ignoreDuplicates: true })
    if (error) {
      result.errors.push(String(note['id']) + ': ' + error.message)
    } else {
      result.imported++
    }
  }
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
