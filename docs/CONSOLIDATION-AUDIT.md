# Feature & Tab Consolidatie-audit

> Status: **aanbeveling** (geen code-wijzigingen in deze commit).
> Aanbevolen scope: **gematigd** — alleen de duidelijkste duplicaten samenvoegen.
> Datum: 2026-06-24.

## Waarom deze audit

ThoughtFoundry (mobile-first PWA, Vite + TypeScript vanilla, Supabase) is
organisch gegroeid tot **13 navigatie-items**: een bottom-bar (4 tabs + "Meer")
plus een "Meer"-overflowsheet met 9 items. Dat voelt als te veel losse tabs, en
sommige schermen doen feitelijk hetzelfde werk.

Deze audit beantwoordt twee vragen:
1. Welke tabs kunnen onder één tab gecombineerd worden?
2. Welke features zijn duplicaat of sterk gelijkaardig?

---

## Huidige navigatie (referentie)

Bron: `src/lib/nav.ts` (`NavKey`, `PRIMARY_TABS`), `src/main.ts`, `src/router.ts`.

| Plek | Items |
|------|-------|
| **Bottom bar** | Nieuw (`/capture`), Vangbak (`/inbox`), Verwerken (`/process`, AI), Thema's (`/themes`), **Meer** |
| **"Meer" sheet** | Zoeken (`/search`), Graaf (`/graph`), Bronnen (`/sources`), Projecten (`/projects`), [AI: Spark (`/spark`), Denkpartner (`/denkpartner`), Clusters (`/clusters`), Boek (`/book`)], Instellingen (`/settings`) |
| **Hulp-routes** | `/note?id=`, `/theme-sections?id=`, `/login`, `/setup` (niet in nav) |

---

## Aanbeveling (gematigd) — voer alleen de duidelijkste merges door

Twee samenvoegingen geven de meeste winst met het minste risico. De rest van de
navigatie blijft ongewijzigd.

### Merge 1 — AI-denktools onder één tab "Denktools"
**Combineert:** `/spark` + `/denkpartner` + `/clusters`.

Alle drie volgen exact dezelfde flow: *input/scope kiezen → AI genereert output
uit jouw nota's → kostenregel tonen*. De pagina-shells zijn vrijwel identiek
(`src/pages/spark.ts`, `src/pages/denkpartner.ts`, `src/pages/clusters.ts`).

- Eén route `/denktools` met een modus-switcher. Blauwdruk: de bestaande in-page
  tab-switcher in `src/pages/book.ts` (regels 55-69, `activeTab`).
- Gedeelde kostenwidget + intro staan dan één keer in de shell i.p.v. drie keer.
- Blijft achter `isAiEnabled()` (`src/lib/nav.ts`), net als nu.
- "Meer"-sheet gaat van 4 AI-items naar 1 (Denktools) + Boek.

### Merge 2 — Boek + Projecten tot één "Boek"-werkruimte
**Combineert:** `/projects` + `/book`.

Dit is een echt functioneel duplicaat. `src/pages/projects.ts` beheert
"ideegedreven boekprojecten" (containers + AI-gap-analyse); `src/pages/book.ts`
beheert hoofdstukken + boeken (AI chapter-generatie). Beide gaan over
langere-vorm boekproductie uit verwerkte nota's.

- Eén werkruimte met de pijplijn **Projecten → Hoofdstukken → Boeken** als interne
  tabs. `book.ts` heeft al een `activeTab`-switcher (`'chapters' | 'books'`); voeg
  `'projects'` toe.
- Datamodellen `lib/projects.ts`, `lib/chapters.ts`, `lib/books.ts` blijven
  ongewijzigd; alleen de UI wordt één scherm.

**Netto effect:** 13 → 10 nav-items, zonder dat er functionaliteit verdwijnt.

---

## Volledige inventaris van overlap (ter info)

De onderstaande overlappen zijn óók gevonden, maar vallen **buiten** de gematigde
aanbeveling. Bewaard hier zodat het beeld compleet is; pak ze pas op als je later
verder wilt consolideren.

### Feature-niveau duplicaten
| # | Overlap | Bestanden | Status |
|---|---------|-----------|--------|
| 1 | 3× "AI synthetiseert mijn nota's" | `spark.ts`, `denkpartner.ts`, `clusters.ts` | **In aanbeveling (Merge 1)** |
| 2 | 2× boek-schrijven | `projects.ts`, `book.ts` | **In aanbeveling (Merge 2)** |
| 3 | Zoeken vs inbox-filtering | `search.ts`, `inbox.ts` | Optioneel — Zoeken kan zoekbalk in Vangbak worden |
| 4 | Graaf is alt. weergave van inbox-nota's | `graph.ts`, `inbox.ts` | Optioneel — kan weergave-toggle Lijst/Graaf worden |
| 5 | Thema's/Bronnen/Projecten = zelfde container-UX | `themes.ts`, `sources.ts`, `projects.ts` | Optioneel — kandidaat voor "Bibliotheek"-tab |
| 6 | Nota-linken op 2 plekken | `capture.ts` ("Verbind twee") + `note.ts` | Optioneel — één gedeelde link-workflow |

### Code-niveau duplicatie (onderhoudskosten, los van tabs)
| Patroon | Waar | Voorstel |
|---------|------|----------|
| Split-pane CRUD-formulier + lijst | `sources.ts`, `projects.ts`, `themes.ts` | Eén herbruikbaar CRUD-list component |
| Kostenwidget (`getCostStatus` + render) | `process.ts`, `spark.ts`, `denkpartner.ts`, `clusters.ts`, `book.ts` | Eén `renderCostNote()` in `lib/cost.ts` |
| Nota-titel extractie (`ai_title ?? content.slice(0,60)`) | `search.ts`, `clusters.ts`, `note.ts`, `graph.ts` | Eén `getNoteTitle(note)` helper |
| Thema-fetch `Promise.all([fetchThemes(), fetchAllNoteThemes()])` | `process.ts`, `note.ts`, `book.ts`, `graph.ts`, `themes.ts` | Eén data-loader |
| Page-boilerplate (topbar + toast + `injectStyles` + `attachTopbar`) | alle 16 pages | Page-factory helper |
| Loader/empty/error-HTML (`*-loading`, `*-error`) | vrijwel elke async page | Gedeelde loader/empty/error helpers |

> Geen kritieke architectuurproblemen. Dit zijn observaties; opruimen is optioneel
> en kan los van de navigatie.

---

## Validatie van de aanbeveling (bij latere implementatie)

1. **Loop-controle:** `capture → inbox → process → themes` blijft max. 1 tap per stap.
2. **Dekkingscheck:** kruis elke huidige `NavKey` (`src/lib/nav.ts`, regel 36) af
   tegen het nieuwe model; geen route mag verweesd raken.
3. **AI-flag scenario's:** test met AI uit (Denktools/Verwerken/Boek verborgen) én aan.
4. **Deep-links:** bevestig dat `?q=` (search) en `?id=` (note/theme-sections) blijven werken.

## Suggested volgorde bij implementatie
Merge 1 (AI-tools) eerst — laagste risico, puur UI-shell. Daarna Merge 2 (Boek +
Projecten). Beide met de in-page tab-switcher van `src/pages/book.ts` als blauwdruk.
