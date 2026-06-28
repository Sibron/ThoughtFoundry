import { createClient } from '@supabase/supabase-js'

const STORAGE_URL_KEY = 'tf_supabase_url'
const STORAGE_KEY_KEY  = 'tf_supabase_anon_key'

// Credentials are read from localStorage first (user-entered via setup screen),
// falling back to build-time env vars for deployments that provide them.
const storedUrl = localStorage.getItem(STORAGE_URL_KEY) ?? undefined
const storedKey = localStorage.getItem(STORAGE_KEY_KEY)  ?? undefined

const supabaseUrl     = storedUrl ?? (import.meta.env.VITE_SUPABASE_URL     as string | undefined)
const supabaseAnonKey = storedKey ?? (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)

function isValidUrl(url: string | undefined): boolean {
  if (!url) return false
  if (url.includes('placeholder') || url.includes('your-project')) return false
  try { new URL(url); return true } catch { return false }
}

export const isConfigured = Boolean(
  isValidUrl(supabaseUrl) &&
  supabaseAnonKey &&
  supabaseAnonKey !== 'placeholder'
)

// Always create a client so module imports never throw; isConfigured gates usage.
export const supabase = createClient(
  supabaseUrl     || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder'
)

/**
 * Fetch every row of a query, transparently paging past PostgREST's default
 * 1000-row ceiling. Supabase caps any un-ranged `.select()` at 1000 rows
 * silently — which quietly truncates "fetch all" reads (note_themes, links,
 * the full note set) once a user's data grows past that, making notes vanish
 * from views that join across those sets (e.g. the graph). Pass a builder that
 * applies `.range(from, to)`; this keeps requesting pages until one comes back
 * short, which only happens at the true end of the table.
 */
export async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>
): Promise<T[]> {
  const PAGE_SIZE = 1000
  const all: T[] = []
  for (let i = 0; ; i++) {
    const from = i * PAGE_SIZE
    const { data, error } = await page(from, from + PAGE_SIZE - 1)
    if (error) throw error
    const rows = (data ?? []) as T[]
    all.push(...rows)
    if (rows.length < PAGE_SIZE) break
  }
  return all
}

/** Persist user-supplied credentials and reload so the client picks them up. */
export function saveSupabaseConfig(url: string, anonKey: string): void {
  localStorage.setItem(STORAGE_URL_KEY, url.trim())
  localStorage.setItem(STORAGE_KEY_KEY,  anonKey.trim())
  location.reload()
}

/** Remove stored credentials (e.g. when switching projects). */
export function clearSupabaseConfig(): void {
  localStorage.removeItem(STORAGE_URL_KEY)
  localStorage.removeItem(STORAGE_KEY_KEY)
}
