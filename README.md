# ThoughtFoundry

A personal "thinking system" PWA for capturing atomic ideas. Built for a single user — collects ideas across themes (autism/neurodiversity, relationships, coaching, management, etc.) so they can later be processed by AI into chapter outlines for informative books.

## Tech Stack

- **Build:** Vite + TypeScript (vanilla, no framework)
- **Database:** Supabase Postgres (Frankfurt) with RLS
- **Auth:** Supabase Auth (email + password)
- **AI:** Anthropic Claude (Haiku 4.5 + Sonnet 4.6) via Supabase Edge Functions
- **Embeddings (optional):** Voyage AI `voyage-3-large` + pgvector
- **PWA:** vite-plugin-pwa (offline IndexedDB queue, installable)
- **Hosting:** Static build deployed to Vimexx via GitHub Actions (FTP)

## Features per phase

| Phase | Status | What |
|---|---|---|
| **1** Capture MVP | ✅ | Login, capture, inbox CRUD, offline queue, online indicator |
| **2** AI processing | ✅ | `/process` — Claude suggests title, summary, types, tags, theme matches, related notes; cost tracker with monthly cap |
| **3** Graph view | ✅ | `/graph` — force-directed network of notes by theme + explicit links (Zettelkasten) |
| **4** Book generation | ✅ | `/book` — cluster notes into chapter outlines, edit, export as Markdown |

## Setup

### 1. Clone & install

```bash
git clone https://github.com/Sibron/ThoughtFoundry.git
cd ThoughtFoundry
npm install
```

### 2. Supabase project

- Create project at [supabase.com](https://supabase.com), region **Frankfurt**.
- SQL Editor → paste `supabase/schema.sql` → Run.
  - If `vector` extension is unavailable in your region, comment out the
    `create extension if not exists "vector"` line. The rest of the schema
    still applies — only embedding-based similarity is disabled.
- Authentication → Users → add yourself.
- Authentication → URL Configuration → Site URL: your production URL.
- Settings → API → copy Project URL and `anon` key.

### 3. Environment

```bash
cp .env.example .env
# Fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
```

### 4. Deploy edge functions (Phase 2+)

```bash
# One-time: install Supabase CLI and link project
supabase link --project-ref <your-ref>

# Set secrets (these are NEVER prefixed with VITE_ — they stay server-side)
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set VOYAGE_API_KEY=pa-...   # optional, for embeddings

supabase functions deploy process-note
supabase functions deploy embed-note
supabase functions deploy generate-chapter
```

### 5. Develop

```bash
npm run dev
# → http://localhost:5173
```

### 6. Production deploy (Vimexx)

GitHub Actions auto-deploys on every push to `main`. Required secrets:

| Secret | Purpose |
|---|---|
| `VITE_SUPABASE_URL` | Build-time Supabase URL |
| `VITE_SUPABASE_ANON_KEY` | Build-time anon key |
| `FTP_SERVER`, `FTP_USERNAME`, `FTP_PASSWORD`, `FTP_SERVER_DIR` | Vimexx FTP target |

HTTPS must be enabled on the domain (PWA install requires it).

## Workflow

The development workflow lives in `ROADMAP.md`. **Discipline matters more than
the code.** The build is the easy part; using it day-to-day, recording friction
in `FRICTION_LOG.md`, then specifying the next phase from real data is what
makes this useful instead of a toy.

## Cost control

The `/process` page shows current-month AI spend vs your configured cap
(default $5). Cap is editable in the UI and stored in `localStorage`. At 80%
you get a warning before each AI call; at 100% you get an explicit confirm.
All token usage is logged to the `ai_usage` table for inspection.

## Repository layout

```
src/
  pages/        login, capture, inbox, process, graph, book
  lib/          supabase, auth, notes, themes, links, chapters, ai, cost
  router.ts     hash router
  main.ts       entry
supabase/
  schema.sql    full schema (Phase 1+2+3+4, idempotent)
  functions/
    process-note/      Claude → suggestion JSON
    embed-note/        Voyage → vector(1024)
    generate-chapter/  Claude → chapter outline JSON
    _shared/           cors, anthropic client, supabase helpers
```
