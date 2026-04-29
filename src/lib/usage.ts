import { supabase } from './supabase'

export interface UsageRow {
  id: string
  user_id: string
  model: string
  operation: string
  input_tokens: number
  output_tokens: number
  cost_usd: number
  created_at: string
}

export async function fetchRecentUsage(limit = 50): Promise<UsageRow[]> {
  const { data, error } = await supabase
    .from('ai_usage')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []) as UsageRow[]
}

export interface UsageSummary {
  totalCost: number
  byModel: Record<string, { count: number; cost: number }>
  byOperation: Record<string, { count: number; cost: number }>
}

export function summarize(rows: UsageRow[]): UsageSummary {
  const summary: UsageSummary = { totalCost: 0, byModel: {}, byOperation: {} }
  rows.forEach(r => {
    const cost = Number(r.cost_usd ?? 0)
    summary.totalCost += cost
    const m = (summary.byModel[r.model] ??= { count: 0, cost: 0 })
    m.count += 1; m.cost += cost
    const o = (summary.byOperation[r.operation] ??= { count: 0, cost: 0 })
    o.count += 1; o.cost += cost
  })
  return summary
}
