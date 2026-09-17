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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Is this string a well-formed UUID?
 *
 * Every row id in this app is a uuid, but ids also arrive from the URL
 * (`#/note?id=…`) and get interpolated into PostgREST `.or()` filter strings,
 * which are a little query language of their own. Checking the shape first
 * means a malformed or hand-edited id produces a clean "not found" instead of
 * a confusing PostgREST 400 — and it keeps crafted filter syntax out of the
 * query entirely.
 */
export function isUuid(value: string | null | undefined): value is string {
  return !!value && UUID_RE.test(value)
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
