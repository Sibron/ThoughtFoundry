import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/**
 * True only when both env vars are present and not the example placeholders.
 * The app checks this before routing so a misconfigured build shows a clear
 * message instead of silently failing against a fake backend.
 */
export const isConfigured = Boolean(
  supabaseUrl &&
  supabaseAnonKey &&
  !supabaseUrl.includes('placeholder') &&
  !supabaseUrl.includes('your-project')
)

// Always construct a client (with harmless placeholders if unconfigured) so
// module imports never crash; `isConfigured` gates whether we actually use it.
export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder'
)
