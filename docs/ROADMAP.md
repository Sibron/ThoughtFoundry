# ThoughtFoundry - Master Build Playbook

## 0) Live Execution Checklist (Update Every Session)

Use this block as the session dashboard. Every Claude session starts here first.

### Global status
- [ ] Fase A complete
- [ ] Fase B complete
- [ ] Fase C complete
- [ ] Fase D complete
- [ ] Fase E complete

### Current focus
- `Current fase:` [ ] A  [ ] B  [ ] C  [ ] D  [ ] E
- `Current step:`
- `Current PR/branch:`
- `Blockers:` none
- `Next action (single line):`

### Fase A checklist
- [ ] Supabase project configured
- [ ] Schema applied (`supabase/schema.sql`)
- [ ] Auth user created
- [ ] `.env` configured locally
- [ ] Local app boots (`npm run dev`)
- [ ] Login tested (wrong + right)
- [ ] Capture save works (button + Ctrl/Cmd+Enter)
- [ ] Inbox CRUD verified
- [ ] Deploy secrets configured
- [ ] Production deploy successful
- [ ] PWA install verified on Android
- [ ] Offline queue + sync verified

### Fase B checklist
- [ ] >= 30 production notes captured
- [ ] >= 7 friction entries logged
- [ ] >= 3 usage contexts covered
- [ ] No code changes made during this fase

### Fase C checklist
- [ ] Friction entries classified (S/E)
- [ ] Critical capture bugs identified (max 5)
- [ ] GitHub issues created with `phase-1-fix`
- [ ] Fix PRs opened one-by-one
- [ ] Fixes verified locally and in production
- [ ] All `phase-1-fix` issues closed

### Fase D checklist
- [ ] Structural processing needs extracted from friction
- [ ] Phase 2 spec fields fully updated in this file
- [ ] Spec reviewed for internal consistency
- [ ] Spec is implementation-ready without guesswork

### Fase E checklist
- [ ] `/process` one-note workflow works
- [ ] AI suggestions fetched via edge function
- [ ] Suggestions editable before accept
- [ ] Accept persists status + `processed_at`
- [ ] Themes/links persistence verified
- [ ] Cost tracker and 80% warning verified
- [ ] 100% cap confirm behavior verified
- [ ] >= 80% accept-without-edit quality reached

### Session handoff log (append newest on top)
- `YYYY-MM-DD | Session # | Fase | Done this session | Next step | Owner`
- `2026-06-17 | S007 | Phase B | Task 6: "Toon een oude nota" random note button in capture footer (non-modal panel) | Deploy edge function update + review PDF artifact for feature inspiration | Claude`
- `2026-06-17 | S006 | Phase B | Task 5: debounced client-side duplicate hint in capture, zero API cost | Task 6 random note button | Claude`
- `2026-06-17 | S005 | Phase B | Task 4: section field in process-note edge function + renderSuggestion select + acceptSuggestion persistence | Task 5 duplicate hint | Claude`
- `2026-06-17 | S004 | Phase B | Task 3: per-theme note count + 5-segment section progress bar on themes overview | Task 4 section suggestion | Claude`
- `2026-06-17 | S003 | Phase B | Task 2: replaced all confirm() in process.ts with archive undo toast + inline cost cap disable | Task 3 theme progress | Claude`
- `2026-06-17 | S002 | Phase B | Task 1: schema migration (notes.section, themes.parent_id), applied to live DB, TS interfaces updated | Task 2 remove modals | Claude`

---

This is the single source of truth for planning, implementation, review, and release.

Legacy docs are merged into this document:
- old `README.md`
- old `PROJECT_BRIEF.md`
- old `PHASE_2_BRIEF.md`
- old `FRICTION_LOG.md` template

If any instruction in code comments, PR text, or memory conflicts with this file: this file wins.

---

## 1) Goal

Build a personal "thinking system" PWA for one user (Sibron) to capture atomic ideas and process them into structured knowledge and book-ready material.

Success criteria:
- Capture is always fast.
- App is usable on Android as installable PWA.
- Workflow is phase-based, with explicit done gates.
- AI support improves processing quality without removing human control.

---

## 2) Product Scope (Target End State)

### Phase 1 - Capture MVP
- Login
- Capture
- Inbox CRUD
- Offline queue + sync

### Phase 2 - AI Processing
- `/process` page
- AI suggestions (title, summary, types, tags, themes, related)
- Human approval before persist
- Cost tracking and cap warnings

### Phase 3 - Graph
- `/graph` network view of notes by themes/links

### Phase 4 - Book Generation
- `/book` chapter outline generation/edit/export

### Phase 5 - Curation and Export
- `/themes` CRUD
- `/settings` (cap, usage log, data export)
- Inbox search and bulk actions

---

## 3) Core Principles

1. Capture first, process later.
2. Single user, no multi-tenant complexity.
3. Offline-first behavior is required for capture flow.
4. One phase at a time. No skipping done criteria.
5. During observation phases: no code changes.
6. Human-in-the-loop for AI persistence.

---

## 4) Technical Baseline

### Stack
- Vite + TypeScript (vanilla)
- Supabase Postgres + RLS
- Supabase Auth (email/password)
- Supabase Edge Functions
- Claude models (Haiku for fast processing, Sonnet for deeper generation)
- Optional embeddings via Voyage + pgvector
- Static deploy via GitHub Actions + FTP

### Key paths
- `src/pages/*` - UI screens
- `src/lib/*` - app/domain logic
- `supabase/schema.sql` - idempotent full schema
- `supabase/functions/*` - AI/edge runtime

### Required secrets
Build/client:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Server/edge:
- `ANTHROPIC_API_KEY` (required)
- `VOYAGE_API_KEY` (optional)

Deploy:
- `FTP_SERVER`
- `FTP_USERNAME`
- `FTP_PASSWORD`
- `FTP_SERVER_DIR`

---

## 5) Canonical Workflow (Fase A-E)

Follow this linearly:

`Fase A -> Fase B -> Fase C -> Fase D -> Fase E`

Do not start the next fase until the current done criteria are true.

---

## 6) Agent Runbook (copy/paste prompts + gates)

This section is optimized for a Claude coding agent.

## FASE A - Setup and Phase 1 Live

### Trigger
Start of implementation.

### Agent prompt
"Implement Phase 1 Capture MVP in this repository using this playbook as source of truth. Open one PR with: login, capture, inbox CRUD, offline queue basics, and route protection. Keep scope strict to Phase 1."

### Build checklist
- [ ] Confirm expected dependencies only in `package.json`
- [ ] Implement/verify routes for `/login`, `/capture`, `/inbox`
- [ ] Implement capture save flow (including Ctrl/Cmd+Enter)
- [ ] Implement inbox list/edit/delete
- [ ] Ensure Supabase env usage via `src/lib/supabase.ts`
- [ ] Ensure local offline queue behavior for capture path
- [ ] Keep UI minimal and mobile-first

### Manual review checklist
- [ ] Read PR end-to-end
- [ ] Test wrong/right login
- [ ] Create/edit/delete note
- [ ] Verify row changes in Supabase table
- [ ] Test keyboard shortcut

### Done criteria Fase A
- [ ] Production app runs on target domain
- [ ] PWA install works on Android
- [ ] You can capture in <= 2 taps from phone
- [ ] Offline capture queues and syncs when online

---

## FASE B - Use and Observe (No code)

### Trigger
Fase A done.

### Rule
No coding in this fase.

### Activity
Log one-line observations each use session.

### Friction log format
`YYYY-MM-DD | [P1|P2|P3|P4|P5] | observation`

Examples:
- `2026-05-11 | P1 | Inbox became hard to scan after 30 notes`
- `2026-05-11 | P1 | Save tap target too small while walking`

### Done criteria Fase B
- [ ] Minimum 30 production notes
- [ ] Minimum 7 friction entries
- [ ] Minimum 3 usage contexts (work, travel, home)

---

## FASE C - Stabilize Phase 1

### Trigger
Fase B done.

### Agent prompt
"Analyze friction items tagged P1 and fix critical Phase 1 capture bugs only. One PR per bug, priority order, no new features."

### Triage method
For each friction entry:
- `S` = structural recurring issue
- `E` = one-off annoyance

Split S items:
- Capture-bug -> fix now (Fase C)
- Processing-need -> input for Fase D

### Issue protocol
Per critical capture bug, create issue with:
- Current behavior
- Desired behavior
- Frequency
- Label: `phase-1-fix`
- Priority 1..5

### Done criteria Fase C
- [ ] All `phase-1-fix` issues closed
- [ ] No known critical capture bug remains

---

## FASE D - Phase 2 Specification

### Trigger
Fase C done.

### Output
One internal Phase 2 spec section in this file (below), updated from real friction data.

### Agent prompt
"Draft and refine Phase 2 implementation spec inside the playbook, based on structural processing needs from Phase 1 usage. Keep it implementation-ready and testable."

### Required spec fields
- [ ] Context
- [ ] Processing needs grouped from friction
- [ ] AI actions per field
- [ ] Activation flow (manual)
- [ ] Human approval flow
- [ ] Model choice
- [ ] Cost cap behavior
- [ ] Data model changes
- [ ] UI behavior
- [ ] Edge functions and secrets
- [ ] Definition of done

### Done criteria Fase D
- [ ] Phase 2 spec is complete in this document
- [ ] It covers all structural processing needs
- [ ] It is specific enough that agent can implement without guessing

---

## FASE E - Build Phase 2

### Trigger
Fase D done.

### Agent prompt
"Implement Phase 2 exactly as specified in this playbook. Open PR(s) with tests/checklist evidence. Keep human approval before persistence."

### Build checklist
- [ ] `/process` shows one inbox note at a time
- [ ] AI suggestion fetch wired through edge function
- [ ] Editable fields before accept
- [ ] Accept action sets status `verwerkt` and `processed_at`
- [ ] Theme links and note links persisted
- [ ] Cost tracker and cap warnings visible

### Review checklist
- [ ] Secrets configured for edge runtime
- [ ] End-to-end process flow verified with real note
- [ ] Cap warning at 80%, explicit confirm at 100%
- [ ] AI output quality acceptable for practical daily use

### Done criteria Fase E
- [ ] In >= 80% of notes you can click accept with no edits
- [ ] Cost remains inside your monthly cap target

---

## 7) Phase 2 Implementation Spec (Merged)

### Context
Phase 2 adds AI processing to captured notes while keeping capture fast and user-controlled.

### Processing needs
- Inbox becomes hard to scan after scale-up
- Need distinction between quick and important ideas
- Need detection of related notes to avoid duplicates
- Need theme clustering as input for graph and books

### AI actions
| Field | Source | Editable | Limits |
|---|---|---|---|
| `ai_title` | Claude | yes | 80 chars |
| `ai_summary` | Claude | yes | 2 sentences |
| `types[]` | Claude | yes | max 5 |
| `tags[]` | Claude | yes | max 5 |
| `matched_theme_ids` | Claude | yes | validated |
| `new_themes[]` | Claude | yes | max 1 |
| `related_note_ids` | Claude | yes | max 3 |

### Activation
Manual trigger in `/process` only. Never auto-run on capture save.

### Human approval flow
1. Fetch suggestions.
2. Edit any field.
3. Select accepted themes/new themes/related links.
4. Accept and move to next note.

### Model choice
- `process-note`: `claude-haiku-4-5`
- `generate-chapter`: `claude-sonnet-4-6`
- `embed-note` optional: `voyage-3-large`

### Cost cap
- Default cap: $5/month
- Warn at 80%
- Explicit confirm at 100%
- Source: `ai_usage` + RPC `ai_cost_this_month()`

### Data model changes
- `notes.ai_title` text
- `notes.processed_at` timestamptz
- `notes.embedding` vector(1024) optional
- `themes`, `note_themes`, `note_links`, `ai_usage`, `chapters`

### UI
- Desktop-first two-column process view
- Left: raw note
- Right: editable suggestions
- Top: monthly AI spend + inbox counter

### Edge functions
- `process-note`
- `embed-note` (optional)
- `generate-chapter`

### Phase 2 Definition of Done
- [ ] `/process` renders unprocessed notes one-by-one
- [ ] Suggestions return within practical latency target (<= 5s typical)
- [ ] All suggested fields are editable
- [ ] Accept updates status and timestamp
- [ ] Theme and related links persist correctly
- [ ] Cost tracker reflects current-month usage
- [ ] 80% warning appears before calls

---

## 8) Test and Release Protocol

For each fase with code changes:
1. Agent opens PR.
2. Human review against checklist in this file.
3. Local verification on real flows.
4. Merge only when done criteria are true.
5. Verify in production after deploy.

No parallel large PR streams. Prefer one scoped PR at a time.

---

## 9) Troubleshooting Quick Table

| Problem | First check | Next action |
|---|---|---|
| SQL error on `vector` extension | region support | skip vector extension temporarily |
| `npm install` fails | Node version | use Node 20 LTS |
| blank local app | env values | verify `.env` values |
| PWA install not available | HTTPS | fix SSL first |
| login fails in prod | Supabase URL config | ensure site URL is registered |
| FTP deploy fails | secret names | verify exact secret keys |

---

## 10) Governance

- This file is the only planning/spec file in `docs`.
- Update this file immediately after any accepted phase decision.
- Never create a second roadmap/brief file.
- If uncertain, choose the smallest change that preserves phase discipline.

---

## Session Start Protocol (Mandatory Before Coding)
1. Open this file and read `0) Live Execution Checklist` fully.
2. Update `Current fase`, `Current step`, and `Next action` to match reality.
3. Confirm exactly one fase is active; if unclear, stop and ask for clarification.
4. List the smallest next implementation unit (one PR-sized change).
5. Start work only after checklist/handoff fields are updated.

### Session End Protocol (Mandatory Before Handoff)
1. Tick all checklist items completed in this session.
2. Add one line in `Session handoff log` (newest on top).
3. Update `Blockers` and `Next action (single line)`.
4. If done criteria for current fase are met, mark fase complete and move focus.
5. Stop without starting a new fase unless explicitly requested.

