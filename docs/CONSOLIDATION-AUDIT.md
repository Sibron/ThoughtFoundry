# Feature & Tab Consolidatie-audit

> Status: **aanbeveling** (geen code-wijzigingen aan de app — dit document is de deliverable).
> Scope: **volledig** — alle vier de samenvoegingen (A·B·C·D) opgenomen.
> Datum: 2026-06-24.

## Waarom deze audit

ThoughtFoundry (mobile-first PWA, Vite + TypeScript vanilla, Supabase) is
organisch gegroeid tot **13 navigatie-items**: een bottom-bar (4 tabs + "Meer")
plus een "Meer"-overflowsheet met 9 items. Dat voelt als te veel losse tabs, en
sommige schermen doen feitelijk hetzelfde werk.

Deze audit beantwoordt twee vragen:
1. **Welke tabs kunnen onder één tab gecombineerd worden?**
2. **Welke features zijn duplicaat of sterk gelijkaardig?**

---

## Huidige navigatie (referentie)

Bron: `src/lib/nav.ts` (`NavKey`, `PRIMARY_TABS`), `src/main.ts` (routes),
`src/router.ts`.

| Plek | Items |
|------|-------|
| **Bottom bar** | Nieuw (`/capture`), Vangbak (`/inbox`), Verwerken (`/process`, AI), Thema's (`/themes`), **Meer** |
| **"Meer" sheet** | Zoeken (`/search`), Graaf (`/graph`), Bronnen (`/sources`), Projecten (`/projects`), [AI: Spark (`/spark`), Denkpartner (`/denkpartner`), Clusters (`/clusters`), Boek (`/book`)], Instellingen (`/settings`) |
| **Hulp-routes** | `/note?id=`, `/theme-sections?id=`, `/login`, `/setup` (niet in nav) |

---

## Deel 1 — Aanbevolen geconsolideerde tab-structuur

Doel: van **13 nav-items → ~6 top-level tabs**, elk met interne sub-tabs i.p.v.
losse routes. De `capture → inbox → organiseer` kernloop blijft intact.

```
1. Nieuw          (/capture)      — ongewijzigd
2. Vangbak        (/inbox)        — + zoekbalk, + weergave-toggle Lijst/Graaf
3. Verwerken      (/process, AI)  — ongewijzigd (AI-triage van inbox)
4. Denktools (AI) (/denktools)    — sub-tabs: Spark | Denkpartner | Clusters
5. Bibliotheek    (/library)      — sub-tabs: Thema's | Bronnen | Boek
6. Meer           → Instellingen  — overflow blijft enkel voor Settings/systeem
```

### Merge A — AI-denktools samen → één tab "Denktools"
**Combineert:** `/spark` + `/denkpartner` + `/clusters` (+ logisch verwant: `/process`).

- Alle drie volgen dezelfde flow: *input/scope kiezen → AI genereert output uit
  jouw nota's → kostenregel tonen*. Zie `src/pages/spark.ts`,
  `src/pages/denkpartner.ts`, `src/pages/clusters.ts` — vrijwel identieke shell.
- Voorstel: één route `/denktools` met een modus-switcher (zoals de bestaande
  in-page tabs van `book.ts`, regel 55-69). Elke modus is een paneel; de
  gedeelde kostenwidget en intro-tekst staan één keer in de shell.
- `/process` blijft een eigen bottom-bar tab (hoort bij de inbox-triageloop),
  maar kan optioneel als 4e modus binnen Denktools verschijnen.
- Blijft achter `isAiEnabled()` (`src/lib/nav.ts`), net als nu.

### Merge B — Boek + Projecten samen → één "Boek"-werkruimte
**Combineert:** `/projects` + `/book`.

- Dit is een **echt functioneel duplicaat**. `src/pages/projects.ts` beheert
  "ideegedreven boekprojecten" (containers + AI-gap-analyse); `src/pages/book.ts`
  beheert hoofdstukken + boeken (AI chapter-generatie). Beide gaan over
  langere-vorm boekproductie uit verwerkte nota's.
- Voorstel: één werkruimte met de pijplijn **Projecten → Hoofdstukken → Boeken**
  als interne tabs (book.ts heeft al een `activeTab`-switcher 'chapters'|'books';
  voeg 'projects' toe). Datamodellen `lib/projects.ts`, `lib/chapters.ts`,
  `lib/books.ts` blijven, alleen de UI wordt één scherm.

### Merge C — Bibliotheek-tab → Thema's + Bronnen + Boek
**Combineert:** `/themes` + `/sources` + (Boek-werkruimte uit Merge B).

- Thema's, Bronnen en Projecten delen **exact hetzelfde split-pane CRUD-patroon**
  (sidebar-formulier + lijst). Vergelijk `sources.ts` regels ~29-80 en
  `projects.ts` regels ~38-70: zelfde structuur, andere velden.
- Voorstel: één route `/library` met sub-tabs **Thema's | Bronnen | Boek**. Dit
  zijn alle drie "gestructureerde containers" voor nota's.
- *Let op trade-off:* Thema's staat nu in de bottom-bar (frequent gebruikt). Als
  Bibliotheek de bottom-bar plek van Thema's overneemt, opent de tab standaard op
  de Thema's-subtab zodat de hoofdfunctie één tap blijft.

### Merge D — Zoeken + Graaf opgaan in Vangbak
**Combineert:** `/search` + `/graph` → in `/inbox`.

- `/search` (`src/pages/search.ts`) en de inbox-filtering (`src/pages/inbox.ts`)
  doen beide *nota's filteren/vinden*. Zoeken hoort als zoekbalk bovenaan Vangbak;
  de aparte route vervalt (deep-link `?q=` kan blijven werken op `/inbox`).
- `/graph` is een alternatieve **weergave** van dezelfde nota's/links. Voorstel:
  een weergave-toggle **Lijst / Graaf** binnen Vangbak i.p.v. een losse tab.

---

## Deel 2 — Duplicaat & gelijkaardige features

### UX-/feature-niveau duplicaten (drijven de merges hierboven)
| # | Duplicaat | Bestanden | Aanbeveling |
|---|-----------|-----------|-------------|
| 1 | 3× "AI synthetiseert mijn nota's" | `spark.ts`, `denkpartner.ts`, `clusters.ts` | Merge A |
| 2 | 2× boek-schrijven | `projects.ts`, `book.ts` | Merge B |
| 3 | Zoeken vs inbox-filtering | `search.ts`, `inbox.ts` | Merge D |
| 4 | Graaf is alt. weergave van inbox-nota's | `graph.ts`, `inbox.ts` | Merge D |
| 5 | Thema's/Bronnen/Projecten = zelfde container-UX | `themes.ts`, `sources.ts`, `projects.ts` | Merge C |
| 6 | Nota-linken op 2 plekken | `capture.ts` ("Verbind twee") + `note.ts` (link-editor) | Eén gedeelde link-workflow/modal |

### Code-niveau duplicatie (herhaalde patronen — opruimen verlaagt onderhoud)
| Patroon | Waar | Voorstel |
|---------|------|----------|
| Split-pane CRUD-formulier+lijst | `sources.ts`, `projects.ts`, `themes.ts` | Eén herbruikbaar CRUD-list component |
| Kostenwidget (`getCostStatus` + render) | `process.ts`, `spark.ts`, `denkpartner.ts`, `clusters.ts`, `book.ts` | Eén `renderCostNote()` helper (`lib/cost.ts`) |
| Nota-titel extractie (`ai_title ?? content.slice(0,60)`) | `search.ts`, `clusters.ts`, `note.ts`, `graph.ts` | Eén `getNoteTitle(note)` helper |
| Thema-fetch `Promise.all([fetchThemes(), fetchAllNoteThemes()])` | `process.ts`, `note.ts`, `book.ts`, `graph.ts`, `themes.ts` | Eén data-loader |
| Page-boilerplate (topbar + toast + `injectStyles` + `attachTopbar`) | alle 16 pages | Page-factory helper |
| Loader/empty/error HTML (`*-loading`, `*-error`) | vrijwel elke async page | Gedeelde loader/empty/error helpers |

*Belangrijk:* dit zijn **observaties uit de exploratie**. Geen kritieke
architectuurproblemen — opruimen is optioneel en kan na de tab-consolidatie.

---

## Resultaat in één oogopslag

- **Bottom-bar:** Nieuw · Vangbak · Verwerken · Bibliotheek · Meer
  (Denktools verschijnt in bottom-bar of "Meer" afhankelijk van AI-flag, net als
  `/process` nu).
- **Van 13 → ~6 nav-items.** Geen functionaliteit verwijderd: alles leeft voort
  als sub-tab of weergave-toggle.
- **AI-gating blijft:** Denktools + Verwerken + Boek-generatie achter
  `isAiEnabled()` (`src/lib/nav.ts`).

---

## Validatie van de aanbeveling (zonder code te wijzigen)

1. **Loop-controle:** loop de kernflow na — `capture → inbox → process → themes`
   blijft maximaal 1 tap per stap in het nieuwe model.
2. **Dekkingscheck:** kruis elke huidige `NavKey` (`src/lib/nav.ts`, regel 36) af
   tegen het nieuwe model en bevestig dat geen route verweesd raakt.
3. **AI-flag scenario's:** controleer het model met AI uit (Denktools/Verwerken/
   Boek verborgen) én AI aan.
4. **Deep-links:** bevestig dat `?q=` (search) en `?id=` (note/theme-sections)
   blijven werken na de merges.

---

## Vervolgstap (apart akkoord nodig)

Als je later de implementatie wilt, is de natuurlijke volgorde:
**Merge D (laagste risico) → Merge A → Merge C + B**, telkens met de in-page
tab-switcher van `src/pages/book.ts` als blauwdruk.
