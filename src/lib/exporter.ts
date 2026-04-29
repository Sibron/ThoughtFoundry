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
  table: string
  imported: number
  errors: string[]
}

const IMPORT_ORDER: Array<keyof ExportPayload> = [
  'themes',
  'notes',
  'note_themes',
  'note_links',
  'chapters',
  'books',
  'ai_usage'
]

export async function importPayload(payload: ExportPayload): Promise<ImportResult[]> {
  if (payload.schema_version !== 1) {
    throw new Error(`Onbekende schema_version: ${(payload as { schema_version?: unknown }).schema_version}`)
  }
  const { data: userResp, error: userErr } = await supabase.auth.getUser()
  if (userErr || !userResp.user) throw new Error('Niet aangemeld')
  const userId = userResp.user.id

  const results: ImportResult[] = []
  for (const table of IMPORT_ORDER) {
    const rows = (payload[table] as Array<Record<string, unknown>> | undefined) ?? []
    if (rows.length === 0) {
      results.push({ table, imported: 0, errors: [] })
      continue
    }
    // Re-stamp user_id so import works regardless of source account.
    const stamped = rows.map(r => ({ ...r, user_id: userId }))
    const conflictKey = table === 'note_themes' ? 'note_id,theme_id' : 'id'
    const { error } = await supabase.from(table).upsert(stamped, { onConflict: conflictKey })
    if (error) {
      results.push({ table, imported: 0, errors: [error.message] })
    } else {
      results.push({ table, imported: rows.length, errors: [] })
    }
  }
  return results
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
