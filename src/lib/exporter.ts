import { supabase } from './supabase'

export interface ExportPayload {
  exported_at: string
  // v1 exports omitted sources and the whole book/studio pipeline; the importer
  // accepts both versions (every read falls back to []).
  schema_version: 1 | 2
  notes: unknown[]
  themes: unknown[]
  note_themes: unknown[]
  note_links: unknown[]
  chapters: unknown[]
  books: unknown[]
  ai_usage: unknown[]
  sources?: unknown[]
  book_projects?: unknown[]
  note_book_projects?: unknown[]
  chapter_sections?: unknown[]
  chapter_section_revisions?: unknown[]
  user_settings?: unknown[]
}

export async function buildExport(): Promise<ExportPayload> {
  const tables = [
    'notes', 'themes', 'note_themes', 'note_links', 'sources',
    'book_projects', 'note_book_projects', 'chapters', 'books',
    'chapter_sections', 'chapter_section_revisions', 'user_settings', 'ai_usage'
  ] as const
  const out: Partial<ExportPayload> = {
    exported_at: new Date().toISOString(),
    schema_version: 2
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
  projects: number
  chapters: number
}

export async function importFromJson(payload: ExportPayload): Promise<ImportResult> {
  const { data: { user } } = await supabase.auth.getUser()
  const userId = user?.id
  if (!userId) throw new Error('Niet aangemeld')

  const result: ImportResult = { imported: 0, skipped: 0, errors: [], themes: 0, sources: 0, links: 0, projects: 0, chapters: 0 }

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

  // ── Sources (persons / references) — before notes: notes.source_id FK ─────
  const sourceIdRemap = new Map<string, string>()

  for (const raw of (payload.sources ?? []) as Record<string, unknown>[]) {
    const title = String(raw['title'] ?? '').trim()
    const jsonId = String(raw['id'] ?? '')
    if (!title || !jsonId) continue

    // Merge on title: a source with the same title already exists for this user
    const { data: existing } = await supabase
      .from('sources')
      .select('id')
      .eq('user_id', userId)
      .eq('title', title)
      .maybeSingle()

    if (existing) {
      sourceIdRemap.set(jsonId, existing.id)
    } else {
      const { data: inserted, error } = await supabase
        .from('sources')
        .insert({ ...raw, user_id: userId })
        .select('id')
        .single()
      if (error) {
        result.errors.push(`source "${title}": ${error.message}`)
      } else {
        sourceIdRemap.set(jsonId, inserted.id)
        result.sources++
      }
    }
  }

  // ── Book projects — before notes' junction table and chapters.project_id ──
  for (const raw of (payload.book_projects ?? []) as Record<string, unknown>[]) {
    if (!raw['id']) continue
    const { error } = await supabase
      .from('book_projects')
      .upsert({ ...raw, user_id: userId }, { onConflict: 'id', ignoreDuplicates: true })
    if (error) result.errors.push(`project "${String(raw['title'] ?? raw['id'])}": ${error.message}`)
    else result.projects++
  }

  // ── Notes ─────────────────────────────────────────────────────────────────
  const notes = (payload.notes ?? []) as Record<string, unknown>[]
  for (const note of notes) {
    if (!note['id'] || !note['content']) { result.skipped++; continue }

    // notes.source_id has an enforced FK; a dangling reference (v1 exports
    // never contained sources) must not reject the whole note.
    const sourceId = note['source_id'] ? String(note['source_id']) : null
    if (sourceId) {
      const mapped = sourceIdRemap.get(sourceId)
      if (mapped) {
        note['source_id'] = mapped
      } else {
        const { data: srcExists } = await supabase
          .from('sources').select('id').eq('id', sourceId).eq('user_id', userId).maybeSingle()
        if (!srcExists) {
          note['source_id'] = null
          result.errors.push(`nota ${String(note['id'])}: bronkoppeling verwijderd (bron ontbreekt in export)`)
        }
      }
    }

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

  // ── note_book_projects (junction) ─────────────────────────────────────────
  for (const raw of (payload.note_book_projects ?? []) as Record<string, unknown>[]) {
    if (!raw['note_id'] || !raw['project_id']) continue
    const { error } = await supabase
      .from('note_book_projects')
      .upsert({ ...raw, user_id: userId }, { onConflict: 'note_id,project_id', ignoreDuplicates: true })
    if (error) result.errors.push(`note_project: ${error.message}`)
  }

  // ── Chapters → books → sections → revisions (FK order) ───────────────────
  for (const raw of (payload.chapters ?? []) as Record<string, unknown>[]) {
    if (!raw['id']) continue
    const themeId = raw['theme_id'] ? String(raw['theme_id']) : null
    if (themeId) raw['theme_id'] = themeIdRemap.get(themeId) ?? themeId
    const { error } = await supabase
      .from('chapters')
      .upsert({ ...raw, user_id: userId }, { onConflict: 'id', ignoreDuplicates: true })
    if (error) result.errors.push(`hoofdstuk "${String(raw['title'] ?? raw['id'])}": ${error.message}`)
    else result.chapters++
  }

  for (const raw of (payload.books ?? []) as Record<string, unknown>[]) {
    if (!raw['id']) continue
    const { error } = await supabase
      .from('books')
      .upsert({ ...raw, user_id: userId }, { onConflict: 'id', ignoreDuplicates: true })
    if (error) result.errors.push(`boek "${String(raw['title'] ?? raw['id'])}": ${error.message}`)
  }

  for (const raw of (payload.chapter_sections ?? []) as Record<string, unknown>[]) {
    if (!raw['id']) continue
    const { error } = await supabase
      .from('chapter_sections')
      .upsert({ ...raw, user_id: userId }, { onConflict: 'id', ignoreDuplicates: true })
    if (error) result.errors.push(`sectie: ${error.message}`)
  }

  for (const raw of (payload.chapter_section_revisions ?? []) as Record<string, unknown>[]) {
    if (!raw['id']) continue
    const { error } = await supabase
      .from('chapter_section_revisions')
      .upsert({ ...raw, user_id: userId }, { onConflict: 'id', ignoreDuplicates: true })
    if (error) result.errors.push(`revisie: ${error.message}`)
  }

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
