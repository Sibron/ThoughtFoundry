import { fetchAllNotes, fetchNotesSections, type Note } from './notes'
import { fetchThemes, fetchAllNoteThemes, type Theme } from './themes'
import { fetchLinks, type NoteLink } from './links'
import { fetchSources, type Source } from './sources'
import { swr, warm } from './cache'

/**
 * Named, typed snapshots for the heavy read-everything views. Each bundles the
 * queries a page needs into one cache entry so the page can render instantly
 * from the last visit and refresh in the background. The fetchers are shared
 * with `warmSnapshots()` so startup and the pages cache under identical keys.
 *
 * Bump the `:vN` suffix when a snapshot's shape changes, so an old cached blob
 * is treated as a miss instead of being parsed into the new shape.
 */

export interface NoteThemeRow { note_id: string; theme_id: string }

// ── Graph ───────────────────────────────────────────────────────────────────

export interface GraphSnapshot {
  notes: Note[]
  themes: Theme[]
  noteThemes: NoteThemeRow[]
  links: NoteLink[]
}

const GRAPH_KEY = 'graph:v1'

async function fetchGraphSnapshot(): Promise<GraphSnapshot> {
  const [notes, themes, noteThemes, links] = await Promise.all([
    fetchAllNotes(),
    fetchThemes(),
    fetchAllNoteThemes(),
    fetchLinks()
  ])
  return { notes, themes, noteThemes, links }
}

export function loadGraphSnapshot(onFresh: (s: GraphSnapshot) => void): Promise<GraphSnapshot> {
  return swr(GRAPH_KEY, fetchGraphSnapshot, onFresh)
}

// ── Themes overview ───────────────────────────────────────────────────────────

export interface ThemesSnapshot {
  themes: Theme[]
  noteThemes: NoteThemeRow[]
  noteSections: { id: string; section: string | null }[]
}

const THEMES_KEY = 'themes:v1'

async function fetchThemesSnapshot(): Promise<ThemesSnapshot> {
  const [noteThemes, noteSections, themes] = await Promise.all([
    fetchAllNoteThemes(),
    fetchNotesSections(),
    fetchThemes()
  ])
  return { themes, noteThemes, noteSections }
}

export function loadThemesSnapshot(onFresh: (s: ThemesSnapshot) => void): Promise<ThemesSnapshot> {
  return swr(THEMES_KEY, fetchThemesSnapshot, onFresh)
}

// ── Sources overview ──────────────────────────────────────────────────────────

export interface SourcesSnapshot {
  sources: Source[]
  notes: Note[]
}

const SOURCES_KEY = 'sources:v1'

async function fetchSourcesSnapshot(): Promise<SourcesSnapshot> {
  const [sources, notes] = await Promise.all([fetchSources(), fetchAllNotes()])
  return { sources, notes }
}

export function loadSourcesSnapshot(onFresh: (s: SourcesSnapshot) => void): Promise<SourcesSnapshot> {
  return swr(SOURCES_KEY, fetchSourcesSnapshot, onFresh)
}

// ── Startup warm ──────────────────────────────────────────────────────────────

/**
 * Fire-and-forget refresh of the snapshot cache shortly after sign-in, so the
 * first visit to a heavy page this session is already instant. Safe to call
 * repeatedly; it only writes storage.
 */
export function warmSnapshots(): void {
  void warm(GRAPH_KEY, fetchGraphSnapshot)
  void warm(THEMES_KEY, fetchThemesSnapshot)
  void warm(SOURCES_KEY, fetchSourcesSnapshot)
}
