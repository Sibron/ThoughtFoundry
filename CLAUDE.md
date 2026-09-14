# ThoughtFoundry — working notes for Claude Code

A mobile-first, Dutch-language PWA for capturing thoughts and sources, turning them into
AI-assisted insights and linked Zettelkasten notes, and weaving those into book
manuscripts. Vite + TypeScript with **no framework**, on Supabase (Postgres + RLS + Deno
edge functions). Capture → process → connect → write.

`docs/ROADMAP.md` is the single source of truth for scope and history; it says so itself,
and it wins over code comments and PR text where they disagree.

## The five projects

Five personal side projects that deliberately share a *shape*: the same section order in
this file, the same kinds of convention, the same commit style. They share no code -- each
repo stands alone, and where two of them use the same pattern, it was arrived at twice.

| Project | Stack | State lives in | Runs as |
|---|---|---|---|
| OutfitForge | Flask + SQLite, server-rendered | SQLite + photo folders, relocatable to a NAS | local, `127.0.0.1:5000` |
| BreinBeestjes | Flask + SQLite, server-rendered | SQLite (WAL) + project folders | local, opens a browser itself |
| ThoughtFoundry | Vite + TypeScript, no framework | Supabase Postgres, remote | GitHub Pages + Supabase |
| DND-characters | Vite + React 19 | browser storage + JSON on disk | local, or one standalone HTML file |
| BOTC_sorting_sets | stdlib Python CLI | nothing persistent | one-shot command |

Where this project answers a shared question differently from its siblings, the next
section says which, and why. Those differences are deliberate; do not "fix" them.
## The one design principle

> **AI proposes. The user confirms. The database stores the confirmed truth.**

`process-note` is the reference: it returns a title, a summary and candidate links, and
writes nothing. The note changes only when the user accepts it.

## Ground rules

1. **Inspect before editing.** Comments here carry regression history -- `fetchAllRows`
   exists because PostgREST silently caps an un-ranged `select()` at 1000 rows and notes
   vanished from the graph.
2. **RLS is the security boundary, not the client.** The anon key is baked into a public
   GitHub Pages build and is world-readable. Every table is `user_id`-scoped with four
   policies. A feature that needs to bypass RLS is a feature that needs rethinking.
3. **`ANTHROPIC_API_KEY` never reaches the browser.** All AI runs in edge functions, and the
   key is set with `supabase secrets set`. Never prefix a secret with `VITE_`.
4. **Every schema change is a dated migration** in `supabase/migrations/`, idempotent, with
   a `--` comment explaining why. `schema.sql` is a consolidated snapshot, not the source
   of truth; never edit it for a change that belongs in a migration.
5. **Validate model output against the user's own rows** before storing it. `process-note`
   strips hallucinated theme and note ids and checks `section` against an allowlist.
6. **The app must load without Supabase credentials** -- `isConfigured` gates use and
   `renderSetup` takes over. A client is always constructed so imports never throw.
7. **AI is optional and capped.** `isAiEnabled()` and `aiGuard()` gate the features;
   `_shared/budget.ts` enforces a monthly spend limit server-side and returns HTTP 402.
   It fails *open* on a read error, deliberately.
8. **Offline is a feature, not a nicety.** Captures queue in IndexedDB and flush on
   reconnect. Do not add a write path that assumes the network.
9. **Don't over-engineer.** One runtime dependency (`@supabase/supabase-js`). No framework,
   no state library, no component library. Adding a dependency is a decision.
10. **Dutch in the UI, English in code, comments and commits.**

## Where this one deliberately differs

- **This is the only one that is hosted, and the only one with auth.** Supabase email +
  password, plus RLS on every table. The other four are localhost or offline, and
  OutfitForge's ground rules name "no auth" as a design decision. The reason is the
  product: capture has to work from a phone, via the PWA share target.
- **Postgres, not SQLite**, and the database is remote. There is no `data/` folder and no
  local source of truth; the IndexedDB cache is a cache.
- **Migrations are dated (`YYYYMMDD_slug.sql`), not numbered**, and are applied by hand
  against the project -- there is no runner and no `user_version` equivalent. The Python
  projects apply theirs automatically at startup. Same discipline, different mechanism.
- **Rendering is client-side string templates**, not server-rendered Jinja. A page is
  `render*(app: HTMLElement)`, which replaces `app.innerHTML` and re-attaches listeners.
- **Tests are thin, not absent.** Vitest covers the pure modules only; everything that
  touches Supabase, IndexedDB or the DOM is still verified by hand. Where the other
  projects say "tests are part of the feature", here that holds for `lib/` logic and not
  yet for a page. See "Testing" below.
- **AI runs server-side in Deno**, not in the app process, so it can hold the key and
  enforce the budget. `_shared/anthropic.ts` calls the REST API with `fetch` rather than
  the SDK, to keep the cold start small.

## Data, state and migrations

Supabase Postgres. Core tables: `notes` (with a `vector(384)` embedding), `themes`
(self-referencing for hierarchy), `note_themes`, `note_links`, `sources`, `book_projects`,
`chapters`, `chapter_sections`, `chapter_section_revisions`, `ai_usage`, `user_settings`,
`connection_dismissals`. RPCs cover semantic search (`match_notes`, `note_neighbors`,
`semantic_bridges`) and cost (`ai_cost_this_month`).

Migration rules, all already followed by the existing files:

- One dated file per change, `supabase/migrations/YYYYMMDD_slug.sql`.
- **Idempotent**: `if not exists`, `drop policy if exists` before create, `do $$` guards
  around anything that depends on a column existing. Files are re-run by hand and must
  survive it.
- A `--` header saying *why*. `20260718_simplify_model.sql` is the model: it drops columns
  and collapses link types, and the header argues the case.
- Applied manually -- see `docs/DEPLOY_*.md`. Automating this is issue #32.
- `20260720_security_hardening.sql` revokes `execute` on `SECURITY DEFINER` functions from
  `anon`. A new such function must do the same, or it bypasses RLS for anyone with the
  public key.

Client state: module-level closures per page, `localStorage` for preferences, IndexedDB for
the snapshot cache (`cache.ts`, stale-while-revalidate) and the offline write queue. There
is no store and no reactivity.

## House style

**One module per route** in `src/pages/`, exporting `render<Name>(app)`. Four pages are
shells that mount sub-views as tabs (`library`, `verbanden`, `denktools`, `inbox`); follow
`library.ts` for the `TABS` array shape.

**All PostgREST access lives in `src/lib/<entity>.ts`** -- `notes.ts`, `themes.ts`,
`links.ts`, `sources.ts`, `projects.ts`, `chapters.ts`. Plain async functions, no classes,
no repository object. A page must not build its own query.

**Always page large reads through `fetchAllRows`.** A bare `.select()` stops at 1000 rows
without erroring.

**Routing** is the hash router in `router.ts`. Use `setLeaveGuard` for unsaved changes and
`onRouteLeave` for cleanup; both are drained on navigation. Retired routes get a redirect
entry rather than being deleted, so old links and bookmarks keep working.

**Styling.** `src/style.css` holds the tokens -- accent ramp, surfaces, typography, a 4px
spacing scale, radii, `--touch-min`, the z-index scale. Never hardcode a colour or a
spacing value; use the token. Global classes are deliberately few (`.btn`, `.badge`,
`.topbar`, `.bottom-nav`, `.toast`). Everything else is per-page CSS injected by an
`injectXStyles()` function guarded by `if (document.getElementById('x-styles')) return`.
Dark mode is defined twice on purpose: by `prefers-color-scheme` and by `[data-theme]`.

**Shared UI lives in `src/lib/` as functions, not components** -- `crud-list.ts` is the
closest thing to a real component and is the one to extend for a new
sidebar-form-plus-grid screen. `shell.ts` owns the tabbed host used by Bibliotheek,
Denktools and Verbanden; a new tabbed screen is a `renderShell()` call, not a fourth copy.
`ai-action.ts` is the single way an AI feature is triggered; do not invent a second.

**Every route is loaded on demand** from `main.ts`, so the capture screen does not wait on
the graph engine. A new page is a `() => guard(async () => (await import('./pages/x')).renderX)`
entry, never a static import.

**Commits** get an imperative one-line subject in plain language, then prose explaining the
problem, the decision, and what was deliberately left undone.

## Testing

`npm test` (Vitest, jsdom) and `npm run build` (`tsc && vite build`). `ci.yml` runs both on
pull requests. Tests live in `tests/`, one file per module under test.

Covered today -- the pure modules, no Supabase and no network:
`lib/similarity.ts`, `lib/markdown.ts` (escaping first: it writes into `innerHTML` and
renders text `analyze-source` fetched from arbitrary sites), `lib/manuscript.ts`,
`lib/cost.ts` (cap thresholds, via a mocked client), `fetchAllRows` + `isUuid` in
`lib/supabase.ts`, `lib/sections.ts`, and `functions/_shared/anthropic.ts`.

**Still uncovered, and the honest list of where a regression can still land silently:**
- `lib/exporter.ts` -- the v1/v2/v3 payload migrations and the theme/source id remapping.
  The most valuable next suite; needs a fake PostgREST or a Supabase branch.
- The offline IndexedDB queue in `lib/notes.ts` -- jsdom has no IndexedDB.
- Every rendering path. There are no DOM tests at all.

`tsconfig.json` now includes `tests` as well as `src`, so anything a test imports gets
typechecked -- which is how `functions/_shared/anthropic.ts` is covered. The rest of
`supabase/functions/` is still not typechecked by `npm run build`; an edge function can
break without the build noticing. Importing a module from a test is currently the only way
to pull it into `tsc`.

When a bug is fixed, add the test that fails against the old code first, and say in the
commit that you checked it fails. `tests/manuscript.test.ts` is the worked example.

## AI calls

Every call is a Deno edge function in `supabase/functions/`; the browser only ever calls
`supabase.functions.invoke` through the typed façade in `src/lib/ai.ts`.

- `_shared/anthropic.ts` is the only place that talks to the API. Models are typed, with a
  `PRICING` table and `estimateCost()`. Structured output is enforced by prompt contract
  and `parseJsonFromResponse`, which strips code fences.
- `_shared/budget.ts` checks `user_settings.ai_monthly_cap_usd` against
  `ai_cost_this_month()` and returns **402** `{error:'ai_budget_exceeded', spend, cap}`,
  which `ai.ts` maps to a typed `AiBudgetError`. A new AI function must go through it.
- `_shared/supabase.ts`'s `getUserClient(req)` forwards the caller's `Authorization` header
  so **RLS still applies inside the function**. Use it rather than a service-role client.
- `logUsage()` writes `ai_usage` on every call. Skipping it makes the cost page wrong.
- Never log prompt bodies or keys, and never log a third-party API's raw response body
  either -- an account endpoint can carry more than you asked for.
- **Narrow `body.model` through `resolveModel()`.** The request interface's TS union is a
  compile-time fiction over `await req.json()`, and the anon key is public. An unpriced
  model makes `estimateCost()` return a value that has no entry in `PRICING`; a `NaN` in
  `ai_usage.cost_usd` makes the monthly cap compare false forever.
- Embeddings are free: the Supabase Edge runtime's built-in `gte-small` (384 dims). No key,
  no cost -- so embedding more is cheap, and calling Claude for it would be a mistake.
- Prompts are Dutch, demand JSON-only output, and every id the model returns is validated
  against the user's own rows before use.

## Running it

```
npm install
cp .env.example .env    # VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
npm run dev
npm run build           # tsc typecheck + bundle -- the only gate
```

Credentials are read from `localStorage` first and the build-time env second, so a deployed
build can be pointed at another project from the Settings page without rebuilding.

Frontend deploys to GitHub Pages on every push to `main` (`deploy.yml`). The backend --
migrations and edge functions -- is deployed by hand; see `docs/DEPLOY_*.md`.
