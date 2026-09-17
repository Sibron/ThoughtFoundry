# ThoughtFoundry

A mobile-first, Dutch-language PWA for capturing thoughts and sources,
turning them into AI-assisted insights and Zettelkasten-style linked notes,
and weaving them into book manuscripts. Capture → process → connect → write.

## What it does

Capture a thought or a source in one tap -- from the app, or by sharing a page to it from
anywhere on your phone. ThoughtFoundry then helps turn that raw capture into something
usable: Claude proposes a title, a summary, the themes it belongs to and the existing notes
it connects to, and you accept or edit each one. Over time the notes form a linked
Zettelkasten you can search semantically, see as a graph, and pull together into chapters
and a book manuscript.

It is built for one person, works offline for capture, and installs as a PWA.

## Tech stack

- **Frontend**: Vite + TypeScript, no framework (vanilla DOM rendering, hash-based router in `src/router.ts`).
- **Backend**: Supabase — Postgres with Row Level Security, Edge Functions (Deno) for AI calls, pgvector for embeddings.
- **AI**: Anthropic Claude models, invoked server-side from edge functions (`supabase/functions/`), with a monthly cost cap.
- **Embeddings**: free local `gte-small` model (384-dim) built into the Supabase Edge runtime — no external API key needed.
- **Deploy**: frontend to GitHub Pages (`.github/workflows/deploy.yml`); backend to Supabase (manual today — see `docs/DEPLOY_*.md`).

## Local development

Prerequisites: Node.js 20+, a Supabase project (or access to the shared dev project).

```bash
npm install
cp .env.example .env   # fill in VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
npm run dev
```

Other scripts:

```bash
npm test          # Vitest unit tests
npm run build     # tsc typecheck + vite build
npm run preview   # preview the production build
```

`npm test` and `npm run build` are the two checks CI runs on every pull request.

Edge-function secrets (e.g. `ANTHROPIC_API_KEY`) are set via `supabase secrets set`,
never in `.env` — they must never reach the browser. See `.env.example` for details.

## Project layout

```
src/
  pages/     one module per route (capture, note, sources, projects, studio, graph, ...)
  lib/       shared client-side logic: Supabase access, notes/sources/links CRUD,
             AI action helpers, cost tracking, search, exporter, semantic matching
  router.ts  hash-based client-side router
supabase/
  functions/   Deno edge functions (AI calls, embeddings, clustering, gap analysis)
  migrations/  SQL migrations (schema, RLS policies, RPCs) — source of truth for the DB schema
  schema.sql   consolidated schema snapshot
scripts/       one-off/maintenance scripts
docs/          deploy guides, roadmap, and audit notes
```

## Deploying

- **Frontend**: pushes to `main` trigger `.github/workflows/deploy.yml`, which builds and publishes to GitHub Pages.
- **Backend**: currently deployed manually against the Supabase project — see `docs/DEPLOY_SEMANTIC_LINKING.md` and `docs/DEPLOY_ANALYZE_SOURCE.md` for the edge-function and migration steps. Automating this is tracked in issue #32.

## More docs

- [`docs/ROADMAP.md`](docs/ROADMAP.md) — build history and current milestone arc.
- [`docs/CONSOLIDATION-AUDIT.md`](docs/CONSOLIDATION-AUDIT.md) — UI/code consolidation notes.
- [`docs/DEPLOY_SEMANTIC_LINKING.md`](docs/DEPLOY_SEMANTIC_LINKING.md), [`docs/DEPLOY_ANALYZE_SOURCE.md`](docs/DEPLOY_ANALYZE_SOURCE.md), [`docs/DEPLOY_DOEL_INSTRUMENT.md`](docs/DEPLOY_DOEL_INSTRUMENT.md) — manual backend deploy guides.
