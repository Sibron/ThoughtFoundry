# Deploy: backend (Supabase) — edge functions en migraties

De frontend gaat automatisch naar GitHub Pages bij elke push naar `main`
(`.github/workflows/deploy.yml`). Sinds #32 geldt dat ook voor de backend:

| Workflow | Wanneer | Wat |
|---|---|---|
| `backend-checks.yml` | elke pull request naar `main` | `deno check` van alle edge functions; `schema.sql` + alle migraties opgebouwd in een lege Postgres 17 met pgvector, en daarna alle migraties nóg een keer |
| `deploy-backend.yml` | push naar `main` die `supabase/**` raakt, of met de hand (Actions → Run workflow) | eerst dezelfde checks; dan alle edge functions deployen; dan `supabase db push` |

`deploy-backend.yml` **doet niets** zolang deze drie repository-secrets ontbreken
(Settings → Secrets and variables → Actions):

| Secret | Waar vandaan |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | supabase.com → Account → Access Tokens |
| `SUPABASE_PROJECT_REF` | `kzrlgohyrhiipfxmkqxi` (het ThoughtFoundry-project) |
| `SUPABASE_DB_URL` | Dashboard → **Connect** → **Session pooler**. De GitHub-runners hebben geen IPv6, dus niet de directe verbinding. Het wachtwoord moet percent-encoded zijn. |

**Voeg ze pas toe na de eenmalige stap hieronder.** Daarvoor weigert `db push`
(`Remote migration versions not found in local migrations directory`), of hij
probeert migraties toe te passen waarvan het effect al live staat.

Runtime-secrets voor de functions (`ANTHROPIC_API_KEY`, `SUPADATA_API_KEY`)
blijven `supabase secrets set …`; de workflow raakt ze niet aan.

---

## Eenmalig: migratiegeschiedenis rechtzetten (#49)

Het project heeft migraties ad hoc gekregen (SQL Editor, MCP), dus de
history-tabel `supabase_migrations.schema_migrations` klopt niet met
`supabase/migrations/`. Daarbij kregen in 2026-09 alle bestanden een unieke
versie van 14 cijfers (`YYYYMMDDHHMMSS_slug.sql`); geen enkele bestandsversie
staat dus al in die tabel.

Deze stappen zijn doorlopen op een lokale kopie met precies die toestand:
effecten live, geen history-rijen voor de repo-bestanden, plus losse
remote-only rijen. Daarna gaf `db push --dry-run` alleen de drie nieuwe
migraties, en na de push "Remote database is up to date".

Eerst het project un-pausen (Dashboard → Restore). Dan, met de CLI
(`npx supabase@2`, getest met 2.118):

```bash
export DB_URL='postgresql://postgres.kzrlgohyrhiipfxmkqxi:<wachtwoord>@aws-0-eu-west-1.pooler.supabase.com:5432/postgres'

# 1. Wat staat er remote, en wat lokaal?
npx supabase@2 migration list --db-url "$DB_URL"
```

**2. Remote-only rijen** (versie in de REMOTE-kolom, geen lokaal bestand).
Controleer voor elk dat het effect door een repo-bestand gedekt is, of voeg een
idempotente migratie toe die het vastlegt. Markeer ze daarna als `reverted`. Uit
de audit van 2026-09 bekend:

| Remote naam | Gedekt door |
|---|---|
| `fix_semantic_bridges_timeout` | `20260626165956_semantic_bridges_searchpath_fix.sql` |
| `harden_function_search_path` | `20260720184137_security_hardening.sql`, sectie 2 |
| `enable_rls_on_notes_backup_tables` | vervallen: die tabellen zijn gedropt in `20260720184137_security_hardening.sql` |
| `tmp_enable_pg_net_diag` | **eerst nakijken:** `select extname from pg_extension where extname = 'pg_net';` Staat pg_net aan en gebruikt niets het, dan `drop extension pg_net;`. Is het wel nodig, leg het dan vast in een nieuwe migratie (`create extension if not exists pg_net with schema extensions;`). |

```bash
npx supabase@2 migration repair --status reverted <remote-only versies…> --db-url "$DB_URL"
```

```bash
# 3. Alle bestaande repo-migraties staan live: markeer ze als toegepast.
npx supabase@2 migration repair --status applied \
  20260617220003 20260617222521 20260618081346 20260618220749 20260618232102 \
  20260623143021 20260626121750 20260626121751 20260626165956 20260702053420 \
  20260703114838 20260704115148 20260705120421 20260706121229 20260718220604 \
  20260720184137 --db-url "$DB_URL"

# 4. Nu mag alleen nog nieuw werk openstaan:
npx supabase@2 db push --dry-run --db-url "$DB_URL"
#   verwacht: 20260927100000_user_settings_ai_quality.sql
#             20260927100100_save_note.sql
#             20260927100200_semantic_bridges_skip_dismissed.sql

# 5. Toepassen, en controleren dat er niets meer openstaat.
npx supabase@2 db push --db-url "$DB_URL"
npx supabase@2 db push --dry-run --db-url "$DB_URL"   # "Remote database is up to date"
```

6. Pas nu de drie secrets toevoegen. De eerstvolgende push naar `main` die
   `supabase/**` raakt (of Run workflow) deployt dan de functions en past alleen
   nog nieuwe migraties toe.

### Volgorde bij het mergen van PR #59

De notitie-editor roept vanaf die PR de RPC `save_note` aan. **Doe stap 1–5
vóór het mergen.** Pages deployt de frontend direct bij de merge, en zonder
`save_note` mislukt opslaan in de editor tot de migratie er staat. Zolang het
project gepauzeerd is werkt de app sowieso niet, dus het echte moment is:
un-pausen → stap 1–5 → mergen.

---

## Dagelijks werk

**Nieuwe migratie.** `npx supabase@2 migration new <slug>`, of met de hand
`supabase/migrations/YYYYMMDDHHMMSS_slug.sql`. Het bestand moet idempotent zijn
en een `--`-header hebben die zegt waarom (zie `CLAUDE.md`). `backend-checks`
bouwt op elke PR alles vers op en past het daarna nog eens toe, dus een
migratie die dat niet overleeft komt niet door review.

**Volgorde functions ↔ migraties.** De workflow deployt eerst de functions,
dan de migraties. Zo landt een migratie die een kolom dropt nooit terwijl een
live function die kolom nog leest. Het omgekeerde geval — een function die een
*nieuwe* kolom nodig heeft — zit dan een paar seconden zonder die kolom. Waar
dat telt: eerst een PR met alleen de migratie, dan een PR met de function.

**Nieuwe edge function.** Een map `supabase/functions/<naam>/index.ts` is
genoeg. Zowel `deno check` als `functions deploy` pakken hem op zonder dat een
workflow hoeft te veranderen. De CLI deployt met JWT-verificatie aan. Dat is
goed voor alles wat de app via `supabase.functions.invoke` aanroept: die stuurt
altijd een geldige JWT mee, en de anon key is er ook een. Een function die
zonder JWT bereikbaar moet zijn krijgt een `supabase/config.toml` met
`[functions.<naam>] verify_jwt = false`.

**Zonder CI** (bv. een hotfix vanaf je laptop):

```bash
npx supabase@2 functions deploy --project-ref kzrlgohyrhiipfxmkqxi --use-api
npx supabase@2 db push --db-url "$DB_URL"
```

**Lokaal de checks draaien:**

```bash
npx deno@2 check supabase/functions/*/index.ts
# met een Postgres + pgvector en PGHOST/PGUSER/PGPASSWORD gezet:
.github/scripts/replay-migrations.sh
```

---

## Verse installatie

`supabase/schema.sql` is geen migratie. Een nieuw project krijgt eerst dat
bestand en daarna de migraties:

```bash
psql "$DB_URL" -f supabase/schema.sql
npx supabase@2 db push --db-url "$DB_URL"
```

Dat `schema.sql` + migraties op een lege database werkt en een tweede keer
toepassen overleeft, bewijst `backend-checks` op elke PR. Nog open op #49:
`schema.sql` omzetten in een baseline-migratie, zodat `db push` alleen genoeg
is, en de opgebouwde schema vergelijken met het live project.
