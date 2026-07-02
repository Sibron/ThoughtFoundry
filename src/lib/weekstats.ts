// Week-momentum counters for the Vandaag dashboard and the weekoverzicht.
// All head-count queries — cheap, RLS-scoped, no payloads.

import { supabase } from './supabase'

/** Monday 00:00 local time of the current week. */
export function weekStart(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  const day = d.getDay() // 0 = zondag
  const sinceMonday = (day + 6) % 7
  d.setDate(d.getDate() - sinceMonday)
  return d
}

export interface WeekStats {
  captured: number
  processed: number
  linked: number
}

export async function fetchWeekStats(): Promise<WeekStats> {
  const since = weekStart().toISOString()
  const [captured, processed, linked] = await Promise.all([
    supabase.from('notes').select('id', { count: 'exact', head: true })
      .gte('created_at', since),
    supabase.from('notes').select('id', { count: 'exact', head: true })
      .gte('processed_at', since),
    supabase.from('note_links').select('id', { count: 'exact', head: true })
      .gte('created_at', since),
  ])
  return {
    captured: captured.count ?? 0,
    processed: processed.count ?? 0,
    linked: linked.count ?? 0,
  }
}

/** How many of the given notes were captured this week (project momentum). */
export async function countCreatedThisWeek(noteIds: string[]): Promise<number> {
  if (noteIds.length === 0) return 0
  const { count } = await supabase
    .from('notes')
    .select('id', { count: 'exact', head: true })
    .in('id', noteIds)
    .gte('created_at', weekStart().toISOString())
  return count ?? 0
}
