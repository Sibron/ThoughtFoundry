# ThoughtFoundry

A mobile-first, Dutch-language PWA for capturing thoughts and sources,
turning them into AI-assisted insights and Zettelkasten-style linked notes,
and weaving them into book manuscripts. Capture → process → connect → write.

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
npm run build     # tsc typecheck + vite build
npm run preview   # preview the production build
```

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
