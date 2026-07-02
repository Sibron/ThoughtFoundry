// Server-side enforcement of the monthly AI budget.
//
// The client already warns at 80% and asks for confirmation at 100%
// (src/lib/cost.ts), but until now nothing stopped a call once it reached the
// edge function — the cap was purely cosmetic. This guard makes it real while
// keeping the existing UX: a blocked call returns HTTP 402 with the spend/cap
// figures, the client shows a confirm, and a retry with `overrideCap: true`
// goes through. The cap is a threshold with an explicit override, not a wall.
//
// Call right after requireUserId in every Anthropic-calling function. The two
// embed functions stay unguarded — gte-small embeddings are free.

// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { jsonResponse } from './cors.ts'

const DEFAULT_CAP_USD = 5

export async function enforceBudget(
  client: SupabaseClient<any, 'public', any>,
  body: { overrideCap?: unknown }
): Promise<Response | null> {
  if (body.overrideCap === true) return null

  // Fail open on read errors: a transient settings/RPC failure should degrade
  // to the old (client-only) behaviour, never lock the user out of AI.
  let cap = DEFAULT_CAP_USD
  try {
    const { data } = await client
      .from('user_settings')
      .select('ai_monthly_cap_usd')
      .maybeSingle()
    if (data && data.ai_monthly_cap_usd != null) cap = Number(data.ai_monthly_cap_usd)
  } catch { return null }

  let spend = 0
  try {
    const { data, error } = await client.rpc('ai_cost_this_month')
    if (error) return null
    spend = Number(data ?? 0)
  } catch { return null }

  if (spend >= cap) {
    return jsonResponse({ error: 'ai_budget_exceeded', spend, cap }, 402)
  }
  return null
}
