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
  sources?: unknown[]
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
  themes: number
  sources: number
  links: number
}

export async function importFromJson(payload: ExportPayload): Promise<ImportResult> {
  const { data: { user } } = await supabase.auth.getUser()
  const userId = user?.id
  if (!userId) throw new Error('Niet aangemeld')

  const result: ImportResult = { imported: 0, skipped: 0, errors: [], themes: 0, sources: 0, links: 0 }

  // ── Themes — upsert by name, track id remapping ───────────────────────────
  const themeIdRemap = new Map<string, string>()

  for (const raw of (payload.themes ?? []) as Record<string, unknown>[]) {
    const name = String(raw['name'] ?? '').trim()
    const jsonId = String(raw['id'] ?? '')
    if (!name || !jsonId) continue

    // Check if a theme with this name already exists for this user
    const { data: existing } = await supabase
      .from('themes')
      .select('id')
      .eq('user_id', userId)
      .eq('name', name)
      .maybeSingle()

    if (existing) {
      themeIdRemap.set(jsonId, existing.id)
    } else {
      const { data: inserted, error } = await supabase
        .from('themes')
        .insert({ ...raw, user_id: userId, id: jsonId })
        .select('id')
        .single()
      if (error) {
        result.errors.push(`theme "${name}": ${error.message}`)
      } else {
        themeIdRemap.set(jsonId, inserted.id)
        result.themes++
      }
    }
  }

  // ── Sources (persons / references) ───────────────────────────────────────
  for (const raw of (payload.sources ?? []) as Record<string, unknown>[]) {
    const title = String(raw['title'] ?? '').trim()
    if (!title) continue

    // Skip if a source with same title already exists
    const { data: existing } = await supabase
      .from('sources')
      .select('id')
      .eq('user_id', userId)
      .eq('title', title)
      .maybeSingle()

    if (!existing) {
      const { error } = await supabase
        .from('sources')
        .insert({ ...raw, user_id: userId })
      if (error) result.errors.push(`source "${title}": ${error.message}`)
      else result.sources++
    }
  }

  // ── Notes ─────────────────────────────────────────────────────────────────
  const notes = (payload.notes ?? []) as Record<string, unknown>[]
  for (const note of notes) {
    if (!note['id'] || !note['content']) { result.skipped++; continue }
    const { error } = await supabase
      .from('notes')
      .upsert({ ...note, user_id: userId }, { onConflict: 'id', ignoreDuplicates: true })
    if (error) {
      result.errors.push(String(note['id']) + ': ' + error.message)
    } else {
      result.imported++
    }
  }

  // ── note_themes — remap theme IDs where name-collision renamed the theme ──
  for (const raw of (payload.note_themes ?? []) as Record<string, unknown>[]) {
    const noteId = String(raw['note_id'] ?? '')
    const jsonThemeId = String(raw['theme_id'] ?? '')
    if (!noteId || !jsonThemeId) continue

    const actualThemeId = themeIdRemap.get(jsonThemeId) ?? jsonThemeId
    const { error } = await supabase
      .from('note_themes')
      .upsert({ note_id: noteId, theme_id: actualThemeId, user_id: userId }, { onConflict: 'note_id,theme_id', ignoreDuplicates: true })
    if (error) result.errors.push(`note_theme ${noteId}→${actualThemeId}: ${error.message}`)
  }

  // ── note_links ────────────────────────────────────────────────────────────
  for (const raw of (payload.note_links ?? []) as Record<string, unknown>[]) {
    if (!raw['source_id'] || !raw['target_id']) continue
    const { error } = await supabase
      .from('note_links')
      .upsert({ ...raw, user_id: userId }, { onConflict: 'source_id,target_id', ignoreDuplicates: true })
    if (error) result.errors.push(`link: ${error.message}`)
    else result.links++
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
