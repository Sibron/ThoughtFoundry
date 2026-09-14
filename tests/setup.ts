// A localStorage stand-in for the Node test environment.
//
// None of these tests exercise the DOM — they cover pure logic. But several of
// the modules under test reach localStorage at *import* time (lib/supabase.ts
// reads stored credentials the moment it loads, and lib/manuscript.ts pulls it
// in transitively via lib/chapters.ts), so importing them needs the API to
// exist even though no test asserts on it.
//
// This used to be jsdom, which is a whole browser implementation for the sake
// of one key-value store — and jsdom 30 requires Node >= 22.22, while the CI
// workflow pins Node 20, so it failed there while passing locally. Twenty lines
// with no version floor at all is the better trade.

class MemoryStorage implements Storage {
  #map = new Map<string, string>()

  get length(): number { return this.#map.size }
  key(i: number): string | null { return [...this.#map.keys()][i] ?? null }
  getItem(k: string): string | null { return this.#map.get(k) ?? null }
  setItem(k: string, v: string): void { this.#map.set(String(k), String(v)) }
  removeItem(k: string): void { this.#map.delete(k) }
  clear(): void { this.#map.clear() }
  [name: string]: unknown
}

globalThis.localStorage ??= new MemoryStorage()
globalThis.sessionStorage ??= new MemoryStorage()
