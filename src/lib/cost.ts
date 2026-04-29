import { supabase } from './supabase'

const MONTHLY_CAP_KEY = 'ai_monthly_cap_usd'
const DEFAULT_CAP_USD = 5

export function getMonthlyCap(): number {
  const stored = localStorage.getItem(MONTHLY_CAP_KEY)
  const n = stored ? Number(stored) : NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAP_USD
}

export function setMonthlyCap(usd: number): void {
  localStorage.setItem(MONTHLY_CAP_KEY, String(usd))
}

// Server-synced cap. Returns null if user_settings row absent or table missing.
// Caller should fall back to getMonthlyCap().
export async function fetchMonthlyCapServer(): Promise<number | null> {
  const { data, error } = await supabase
    .from('user_settings')
    .select('monthly_cap_usd')
    .maybeSingle()
  if (error) {
    // Table may not exist on older schemas — fall back silently.
    return null
  }
  if (!data) return null
  const n = Number(data.monthly_cap_usd)
  return Number.isFinite(n) && n > 0 ? n : null
}

export async function setMonthlyCapServer(usd: number): Promise<void> {
  const { data: userResp, error: userErr } = await supabase.auth.getUser()
  if (userErr || !userResp.user) throw new Error('Niet aangemeld')
  const userId = userResp.user.id
  const { error } = await supabase
    .from('user_settings')
    .upsert({ user_id: userId, monthly_cap_usd: usd, updated_at: new Date().toISOString() })
  if (error) throw error
  setMonthlyCap(usd)
}

// Resolves cap with this priority: server > localStorage > default.
export async function getEffectiveCap(): Promise<number> {
  const server = await fetchMonthlyCapServer().catch(() => null)
  if (server != null) {
    setMonthlyCap(server) // mirror to localStorage for offline use
    return server
  }
  return getMonthlyCap()
}

export async function fetchMonthlySpend(): Promise<number> {
  const { data, error } = await supabase.rpc('ai_cost_this_month')
  if (error) {
    console.warn('ai_cost_this_month rpc failed:', error.message)
    return 0
  }
  return Number(data ?? 0)
}

export interface CostStatus {
  spendUsd: number
  capUsd: number
  ratio: number
  warn: boolean    // ≥ 80%
  block: boolean   // ≥ 100%
}

export async function getCostStatus(): Promise<CostStatus> {
  const [spend, cap] = await Promise.all([fetchMonthlySpend(), getEffectiveCap()])
  const ratio = cap > 0 ? spend / cap : 0
  return {
    spendUsd: spend,
    capUsd: cap,
    ratio,
    warn: ratio >= 0.8,
    block: ratio >= 1
  }
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 3 : 2)}`
}
