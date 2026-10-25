// An in-memory stand-in for the slice of supabase-js + PostgREST that the
// modules under test call. It is not a database. It models exactly the
// behaviour the importer, the offline queue and the settings sync depend on,
// and nothing else:
//
//   - primary keys and unique constraints (23505),
//   - upsert with onConflict + ignoreDuplicates, i.e. ON CONFLICT DO NOTHING,
//   - foreign keys, checked at the end of the statement as Postgres does (23503),
//   - unknown columns, which PostgREST rejects before the query runs (PGRST204),
//   - RLS as "you see and write only rows carrying your user_id",
//   - the 1000-row cap on a read with no range,
//   - single() / maybeSingle() and their PGRST116 error.
//
// A write is all-or-nothing per request, like a single SQL statement. There
// are no cascades, triggers or defaults beyond a generated `id`. When a test
// needs more fidelity, add it here rather than faking it inline -- the point
// is that one fake is argued about once.
//
// Tests use it through vi.mock, keeping the real `fetchAllRows`:
//
//   vi.mock('../src/lib/supabase', async (orig) => ({
//     ...(await orig<typeof import('../src/lib/supabase')>()),
//     supabase: (await import('./helpers/fake-supabase')).fake.client,
//   }))

export type Row = Record<string, unknown>
export interface PgError { message: string; code: string }
export interface Result { data: unknown; error: PgError | null }
export type Op = 'select' | 'insert' | 'upsert' | 'update' | 'delete'

export interface TableSpec {
  pk: string[]
  unique?: string[][]
  /** When present, any other key in a written row is rejected (PGRST204). */
  columns?: string[]
  /** `col` references `table.id`. */
  fks?: { col: string; table: string }[]
  checks?: { name: string; ok: (row: Row) => boolean }[]
}

const NOTE_COLUMNS = [
  'id', 'user_id', 'content', 'mini_notes', 'status', 'core_idea', 'use_for',
  'source_id', 'source_url', 'source_title', 'source_author', 'ai_summary', 'ai_title',
  'processed_at', 'section', 'created_at', 'updated_at', 'embedding', 'embedded_at',
]

/** The constraints of the live schema that the import path can trip over. */
export const SCHEMA: Record<string, TableSpec> = {
  notes: {
    pk: ['id'],
    columns: NOTE_COLUMNS,
    fks: [{ col: 'source_id', table: 'sources' }],
    checks: [{ name: 'notes_status_check', ok: r => ['inbox', 'verwerkt', 'archief'].includes(String(r['status'] ?? 'inbox')) }],
  },
  themes: {
    pk: ['id'],
    unique: [['user_id', 'name']],
    fks: [{ col: 'parent_id', table: 'themes' }],
  },
  note_themes: {
    pk: ['note_id', 'theme_id'],
    fks: [{ col: 'note_id', table: 'notes' }, { col: 'theme_id', table: 'themes' }],
  },
  note_links: {
    pk: ['id'],
    unique: [['source_id', 'target_id']],
    fks: [{ col: 'source_id', table: 'notes' }, { col: 'target_id', table: 'notes' }],
    checks: [{ name: 'note_links_check', ok: r => r['source_id'] !== r['target_id'] }],
  },
  sources: { pk: ['id'] },
  book_projects: { pk: ['id'] },
  note_book_projects: {
    pk: ['note_id', 'project_id'],
    fks: [{ col: 'note_id', table: 'notes' }, { col: 'project_id', table: 'book_projects' }],
  },
  chapters: {
    pk: ['id'],
    fks: [{ col: 'theme_id', table: 'themes' }, { col: 'project_id', table: 'book_projects' }],
  },
  chapter_sections: { pk: ['id'], fks: [{ col: 'chapter_id', table: 'chapters' }] },
  chapter_section_revisions: { pk: ['id'], fks: [{ col: 'section_id', table: 'chapter_sections' }] },
  user_settings: { pk: ['user_id'] },
  ai_usage: { pk: ['id'] },
}

/** PostgREST's db-max-rows: a read without a range stops here, silently. */
export const MAX_ROWS = 1000

export class FakeSupabase {
  schema: Record<string, TableSpec> = SCHEMA
  userId: string | null = 'user-a'
  /** Every request that reached "the server", in order. */
  requests: { table: string; op: Op; rows: number }[] = []
  /** Return an error to reject a write before anything is applied. */
  failWrite: ((table: string, op: Op, rows: Row[]) => PgError | null) | null = null

  #tables = new Map<string, Row[]>()
  #seq = 0

  readonly client = {
    auth: {
      getUser: async () => ({ data: { user: this.userId ? { id: this.userId } : null }, error: null }),
    },
    from: (table: string) => new Query(this, table),
  }

  reset(): void {
    this.#tables.clear()
    this.requests = []
    this.failWrite = null
    this.userId = 'user-a'
  }

  /** The live rows of a table, for assertions. Mutating them mutates the table. */
  table(name: string): Row[] {
    let rows = this.#tables.get(name)
    if (!rows) { rows = []; this.#tables.set(name, rows) }
    return rows
  }

  /** Put rows in place without constraint checks -- test fixtures only. */
  seed(name: string, rows: Row[]): void {
    this.table(name).push(...rows.map(r => ({ ...r })))
  }

  /** Deep copy of every table, for before/after comparisons. */
  snapshot(): Record<string, Row[]> {
    return Object.fromEntries([...this.#tables].map(([k, v]) => [k, structuredClone(v)]))
  }

  writes(table: string): number {
    return this.requests.filter(r => r.table === table && r.op !== 'select').length
  }

  nextId(): string {
    return `00000000-0000-4000-8000-${String(++this.#seq).padStart(12, '0')}`
  }

  replace(name: string, rows: Row[]): void {
    this.#tables.set(name, rows)
  }
}

const err = (code: string, message: string): PgError => ({ code, message })

function project(row: Row, cols: string): Row {
  if (cols.trim() === '*') return { ...row }
  const out: Row = {}
  for (const c of cols.split(',').map(s => s.trim()).filter(Boolean)) out[c] = row[c]
  return out
}

const keyOf = (row: Row, cols: string[]) => JSON.stringify(cols.map(c => row[c] ?? null))

class Query implements PromiseLike<Result> {
  #db: FakeSupabase
  #table: string
  #op: Op = 'select'
  #cols = '*'
  #returning = false
  #payload: Row[] = []
  #patch: Row = {}
  #onConflict: string[] | null = null
  #ignoreDuplicates = false
  #filters: ((r: Row) => boolean)[] = []
  #orders: { col: string; asc: boolean }[] = []
  #range: [number, number] | null = null
  #mode: 'many' | 'single' | 'maybeSingle' = 'many'

  constructor(db: FakeSupabase, table: string) {
    this.#db = db
    this.#table = table
  }

  select(cols = '*'): this {
    this.#cols = cols
    if (this.#op !== 'select') this.#returning = true
    return this
  }
  insert(values: Row | Row[]): this {
    this.#op = 'insert'
    this.#payload = (Array.isArray(values) ? values : [values]).map(r => ({ ...r }))
    return this
  }
  upsert(values: Row | Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean; defaultToNull?: boolean } = {}): this {
    this.#op = 'upsert'
    this.#payload = (Array.isArray(values) ? values : [values]).map(r => ({ ...r }))
    this.#onConflict = opts.onConflict ? opts.onConflict.split(',').map(s => s.trim()) : null
    this.#ignoreDuplicates = !!opts.ignoreDuplicates
    return this
  }
  update(patch: Row): this { this.#op = 'update'; this.#patch = { ...patch }; return this }
  delete(): this { this.#op = 'delete'; return this }
  eq(col: string, v: unknown): this { this.#filters.push(r => r[col] === v); return this }
  neq(col: string, v: unknown): this { this.#filters.push(r => r[col] !== v); return this }
  in(col: string, vs: unknown[]): this { this.#filters.push(r => vs.includes(r[col])); return this }
  order(col: string, opts: { ascending?: boolean } = {}): this {
    this.#orders.push({ col, asc: opts.ascending !== false })
    return this
  }
  range(from: number, to: number): this { this.#range = [from, to]; return this }
  single(): this { this.#mode = 'single'; return this }
  maybeSingle(): this { this.#mode = 'maybeSingle'; return this }

  then<A = Result, B = never>(
    ok?: ((v: Result) => A | PromiseLike<A>) | null,
    fail?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve().then(() => this.#run()).then(ok, fail)
  }

  #spec(): TableSpec { return this.#db.schema[this.#table] ?? { pk: ['id'] } }
  #mine = (r: Row) => !('user_id' in r) || r['user_id'] === this.#db.userId

  #run(): Result {
    const rows = this.#op === 'select' || this.#op === 'update' || this.#op === 'delete' ? 0 : this.#payload.length
    this.#db.requests.push({ table: this.#table, op: this.#op, rows })
    if (this.#op === 'select') return this.#shape(this.#read())
    const denied = this.#validate()
    if (denied) return { data: null, error: denied }
    const out = this.#write()
    if ('error' in out) return { data: null, error: out.error }
    return this.#returning ? this.#shape(out.rows) : { data: null, error: null }
  }

  #read(): Row[] {
    let rows = this.#db.table(this.#table).filter(this.#mine).filter(r => this.#filters.every(f => f(r)))
    for (const { col, asc } of [...this.#orders].reverse()) {
      rows = [...rows].sort((a, b) => {
        const x = String(a[col] ?? ''), y = String(b[col] ?? '')
        return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1)
      })
    }
    const [from, to] = this.#range ?? [0, MAX_ROWS - 1]
    return rows.slice(from, Math.min(to + 1, from + MAX_ROWS))
  }

  #shape(rows: Row[]): Result {
    const data = rows.map(r => project(r, this.#cols))
    if (this.#mode === 'many') return { data, error: null }
    if (data.length === 1) return { data: data[0], error: null }
    if (data.length === 0 && this.#mode === 'maybeSingle') return { data: null, error: null }
    return { data: null, error: err('PGRST116', 'JSON object requested, multiple (or no) rows returned') }
  }

  #validate(): PgError | null {
    const spec = this.#spec()
    const written = this.#op === 'update' ? [this.#patch] : this.#payload
    if (spec.columns) {
      for (const r of written) {
        const bad = Object.keys(r).find(k => !spec.columns!.includes(k))
        if (bad) return err('PGRST204', `Could not find the '${bad}' column of '${this.#table}' in the schema cache`)
      }
    }
    if ((this.#op === 'insert' || this.#op === 'upsert') && written.some(r => 'user_id' in r && r['user_id'] !== this.#db.userId)) {
      return err('42501', `new row violates row-level security policy for table "${this.#table}"`)
    }
    return this.#db.failWrite?.(this.#table, this.#op, written) ?? null
  }

  #write(): { rows: Row[] } | { error: PgError } {
    const spec = this.#spec()
    const before = this.#db.table(this.#table)
    const next = before.map(r => r)
    const touched: Row[] = []

    if (this.#op === 'delete' || this.#op === 'update') {
      const hit = before.filter(this.#mine).filter(r => this.#filters.every(f => f(r)))
      if (this.#op === 'delete') {
        this.#db.replace(this.#table, before.filter(r => !hit.includes(r)))
        return { rows: hit }
      }
      for (const r of hit) {
        const i = next.indexOf(r)
        next[i] = { ...r, ...this.#patch }
        touched.push(next[i])
      }
    } else {
      const target = this.#onConflict ?? spec.pk
      for (const incoming of this.#payload) {
        const row = { ...incoming }
        if (spec.pk.length === 1 && spec.pk[0] === 'id' && row['id'] == null) row['id'] = this.#db.nextId()
        const clash = this.#op === 'upsert' ? next.findIndex(r => keyOf(r, target) === keyOf(row, target)) : -1
        if (clash >= 0) {
          if (this.#ignoreDuplicates) continue
          if (touched.includes(next[clash])) return { error: err('21000', 'ON CONFLICT DO UPDATE command cannot affect row a second time') }
          next[clash] = { ...next[clash], ...row }
          touched.push(next[clash])
          continue
        }
        next.push(row)
        touched.push(row)
      }
    }

    // Constraints are checked against the state at the end of the statement.
    const constraints = [spec.pk, ...(spec.unique ?? [])]
    for (const cols of constraints) {
      const seen = new Set<string>()
      for (const r of next) {
        const k = keyOf(r, cols)
        if (seen.has(k)) {
          return { error: err('23505', `duplicate key value violates unique constraint "${this.#table}_${cols.join('_')}_key"`) }
        }
        seen.add(k)
      }
    }
    for (const r of touched) {
      for (const c of spec.checks ?? []) {
        if (!c.ok(r)) return { error: err('23514', `new row for relation "${this.#table}" violates check constraint "${c.name}"`) }
      }
      for (const fk of spec.fks ?? []) {
        const v = r[fk.col]
        if (v == null) continue
        const pool = fk.table === this.#table ? next : this.#db.table(fk.table)
        if (!pool.some(p => p['id'] === v)) {
          return { error: err('23503', `insert or update on table "${this.#table}" violates foreign key constraint "${this.#table}_${fk.col}_fkey"`) }
        }
      }
    }
    this.#db.replace(this.#table, next)
    return { rows: touched }
  }
}

/** One fake per test file: vitest isolates modules per file. */
export const fake = new FakeSupabase()
