import { supabase } from './supabase'
import { saveUserSetting } from './user-settings'

const MONTHLY_CAP_KEY = 'ai_monthly_cap_usd'
const DEFAULT_CAP_USD = 5

export function getMonthlyCap(): number {
  const stored = localStorage.getItem(MONTHLY_CAP_KEY)
  const n = stored ? Number(stored) : NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAP_USD
}

export function setMonthlyCap(usd: number): void {
  localStorage.setItem(MONTHLY_CAP_KEY, String(usd))
  saveUserSetting({ ai_monthly_cap_usd: usd }).catch(() => {})
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
  const [spend, cap] = await Promise.all([fetchMonthlySpend(), Promise.resolve(getMonthlyCap())])
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

/**
 * Write the shared "AI deze maand: $x / $y" line into the element with the
 * given id. No-op when the element isn't on the page. Centralises the cost
 * widget that the AI tool pages (spark/denkpartner/clusters) each rendered.
 */
export function renderCostNote(elementId: string, cost: CostStatus): void {
  const el = document.getElementById(elementId)
  if (!el) return
  el.textContent = `AI deze maand: ${formatUsd(cost.spendUsd)} / ${formatUsd(cost.capUsd)}`
}
