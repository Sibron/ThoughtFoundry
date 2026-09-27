# Deploy: "doel-instrument" arc (M0–M12)

> **Sinds #32 gaat de backend automatisch** (`.github/workflows/deploy-backend.yml`):
> functions en migraties bij elke push naar `main` die `supabase/**` raakt. Zie
> [`DEPLOY_BACKEND.md`](DEPLOY_BACKEND.md), ook voor de handmatige CLI-route. Deze
> gids beschrijft hoe het ging vóór die automatisering en is historisch; SQL
> hieronder kan verouderd zijn — de migraties zijn leidend.

Wat er op het live Supabase-project moet landen na het mergen van deze branch.
Volgorde: **eerst de migraties (in datumvolgorde), dan de edge functions.**

Snelste route (CLI of MCP):

```bash
supabase db push          # applies supabase/migrations/2026070*.sql in order
supabase functions deploy embed-text write-section \
  process-note enrich-links denkpartner detect-clusters \
  generate-chapter gap-analysis spark
```

Zonder CLI: run elke migratie hieronder in de SQL Editor (dashboard) en
plak/deploy de functies via Edge Functions → editor, zoals in
`DEPLOY_SEMANTIC_LINKING.md` (stap 2) beschreven. De functies importeren uit `_shared/` — bij
dashboard-deploys moet je die imports inlinen of de CLI gebruiken.

---

## 1. Migraties (SQL Editor, in deze volgorde)

| Bestand | Wat het doet |
|---|---|
| `20260702053420_foundations.sql` | user_settings delete-policy; GIN-index op tags; note_type/section indexes; ivfflat probes=10 voor `note_neighbors`/`match_notes` |
| `20260703114838_vandaag.sql` | `book_projects.target_date`; `user_settings.review_weekday` |
| `20260704115148_connection_dismissals.sql` | tabel `connection_dismissals` (+RLS) voor afgewezen verbindingsvoorstellen |
| `20260705120421_writing_studio.sql` | tabellen `chapter_sections` + `chapter_section_revisions` (+RLS, trigger, indexes); `chapters.project_id`; backfill van bestaande outlines |
| `20260706121229_project_manuscript.sql` | `book_projects.chapter_order` |

Alle migraties zijn idempotent — nogmaals draaien is veilig.

## 2. Edge functions

**Nieuw:**
- `embed-text` — embed losse tekst (gte-small, gratis) voor zoeken-op-betekenis, studio-suggesties en de note-picker
- `write-section` — AI-schrijfhulp in de studio (draft / rewrite / tighten / continue)

**Gewijzigd (opnieuw deployen):**
- `spark` — semantische retrieval (embed de query + `match_notes`) met lexicale fallback
- `process-note`, `enrich-links`, `denkpartner`, `detect-clusters`, `generate-chapter`, `gap-analysis` — budget-guard (`_shared/budget.ts`, HTTP 402 + overrideCap); `detect-clusters` accepteert nu ook een `model`

**Ongewijzigd:** `embed-note`, `embed-notes-batch`.

Secrets: alleen `ANTHROPIC_API_KEY` (bestond al). Embeddings hebben geen key
nodig.

## 3. Controle na deploy

1. Instellingen → embeddings-backfill draaien als er nog nota's zonder
   embedding zijn (Zoeken → Betekenis en de Verbindingen-view hebben dit nodig).
2. Zet je maandcap tijdelijk op $0,01 en start een Spark: verwacht de melding
   "Maandbudget bereikt … Toch doorgaan?" (server-side 402). Cap terugzetten.
3. Open een bestaand hoofdstuk via Bibliotheek → Boek → "Schrijf →": de
   secties uit de oude outline moeten als rijen verschijnen (backfill).
4. Vangbak → Verbindingen: voorstellen verschijnen; "Wijs af" en herlaad —
   het paar blijft weg (dismissal-tabel).
