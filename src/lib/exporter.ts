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
