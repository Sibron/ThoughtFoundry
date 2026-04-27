# ThoughtFoundry — Project Brief (Phase 1)

## Goal

Build a personal "thinking system" PWA for one user (Sibron Segers) to capture atomic ideas across multiple themes (autism/neurodiversity, relationships, coaching, management, personal development, etc.) so they can later be processed into informative books.

## Core Philosophy

- **Capture first, process later**: Speed of capture is critical. The UI must be fast to open and save.
- **Single user**: No multi-tenancy complexity. One account, full ownership of data.
- **Offline-first**: Must work without internet; sync when back online.
- **Mobile-first**: Primarily used on Android. Must be installable as a PWA.

## Phase 1 Scope (MVP)

### Screens

1. **Login** — Email + password authentication via Supabase Auth
2. **Capture** — Full-screen textarea to capture an idea, with optional extras:
   - Mini-note (additional context)
   - Source metadata (URL, title, author)
   - Keyboard shortcut: Cmd/Ctrl+Enter to save
3. **Inbox** — List of all notes, ordered newest first, with:
   - Text search/filter
   - Expand to read full content
   - Inline edit
   - Delete
   - Pagination (50 per page)

### Data Model

```sql
notes (
  id           uuid PK
  user_id      uuid FK → auth.users
  content      text NOT NULL
  mini_notes   text
  status       text DEFAULT 'inbox' CHECK IN ('inbox','verwerkt','archief')
  types        text[]
  tags         text[]
  source_url   text
  source_title text
  source_author text
  ai_summary   text
  created_at   timestamptz
  updated_at   timestamptz
)
```

### PWA Requirements

- Installable on Android (manifest + service worker)
- Offline queue: notes saved offline are synced when back online (IndexedDB)
- Works on home screen without browser chrome

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Build | Vite (latest, vanilla-ts template) | Fast, zero config |
| Frontend | Vanilla TS + CSS | No framework overhead for a simple tool |
| Database | Supabase Postgres (Frankfurt) | EU data residency, free tier, RLS |
| Auth | Supabase Auth (email/password) | Built-in, secure |
| PWA | vite-plugin-pwa | Auto service worker + manifest |
| Hosting | Vimexx (static FTP deploy) | Existing hosting |
| CI/CD | GitHub Actions | Auto-deploy on push to main |

## Design System

- **Colors**: Warm neutral background (`#FAFAF7`), single green accent (`#3AC48D`)
- **Dark mode**: Automatic via `prefers-color-scheme`
- **Typography**: System font stack, 16px base
- **Spacing**: 4px scale (--s-1 through --s-8)
- **Components**: Minimal — buttons, form fields, topbar, toast, badges

## Future Phases (Not in Scope Now)

- **Phase 2**: AI categorization, auto-tagging, embedding search
- **Phase 3**: Graph view / Zettelkasten — link related notes visually
- **Phase 4**: Book generation — cluster notes into chapter outlines, export to markdown/PDF
