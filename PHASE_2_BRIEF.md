# ThoughtFoundry — Phase 2 Brief (AI-verwerking)

> Gebouwd vooruitlopend op de in `ROADMAP.md` beschreven Fase D-spec, zodat de
> code klaar staat zodra de Fase B/C-data ontstaan zijn. Pas dit document later
> aan op basis van je eigen friction log voor je Fase E definitief afsluit.

## Context

Phase 1 capteert atomische ideeën in een offline-first PWA. Phase 2 voegt
AI-verwerking toe: titel, samenvatting, types, tags, thema-koppeling en
verwante nota's worden voorgesteld door Claude. Niets wordt automatisch
weggeschreven — jij accepteert of corrigeert per veld.

## Verwerk-noden (verwacht; herzien in Fase D)

- "Inbox onoverzichtelijk vanaf 30+ items" → titels en thema's per nota
- "Mistte 'snel idee' vs 'belangrijk idee' onderscheid" → types
- "Vergat dat ik al iets gelijkaardigs had ingevoerd" → related-suggesties
- "Wilde clusters zien" → thema-koppeling + later graafweergave (Phase 3)

## AI-acties

| Veld                | Bron      | Edit-bar | Default-cap |
|---------------------|-----------|----------|-------------|
| `ai_title`          | Claude    | ja       | 80 chars    |
| `ai_summary`        | Claude    | ja       | 2 zinnen    |
| `types[]`           | Claude    | ja       | max 5       |
| `tags[]`            | Claude    | ja       | max 5       |
| `matched_theme_ids` | Claude    | check    | RLS-validated |
| `new_themes[]`      | Claude    | check    | max 1 per nota |
| `related_note_ids`  | Claude    | check    | max 3       |

Ophalen: `claude-haiku-4-5` (snel, ~$0.005 per nota). Boekgeneratie gebruikt
`claude-sonnet-4-6` voor betere structuur.

## Activatie

Manuele knop **"AI-suggesties ophalen"** per nota in `/process`. Geen
automatische trigger op opslaan — capture moet snel blijven.

## Goedkeur-flow

1. Klik "AI-suggesties ophalen" — voorstel verschijnt rechts.
2. Bewerk velden vrij (titel, samenvatting, types/tags als komma-lijst).
3. Vink af welke thema's je wilt koppelen, welke `new_themes` je echt nieuw
   wilt aanmaken, en welke `related_note_ids` je wil persisteren als
   `note_links`.
4. Klik "Accepteer & volgende" — de nota gaat naar status `verwerkt` en de
   volgende nota komt op.

## Modelkeuze

| Operatie          | Model                | Reden                      |
|-------------------|----------------------|----------------------------|
| process-note      | `claude-haiku-4-5`   | snel, goedkoop, goed genoeg |
| generate-chapter  | `claude-sonnet-4-6`  | structuurkwaliteit         |
| embed-note (opt.) | `voyage-3-large`     | semantische similariteit   |

## Kostenplafond

- Default cap: **$5/maand** (configureerbaar in `/process` → "cap bijwerken").
- Warning bij **80%**, expliciete confirm bij **100%**.
- Tracking via `ai_usage` tabel; RPC `ai_cost_this_month()` aggregeert per
  gebruiker per kalendermaand.

## Datamodel-aanpassingen

```
notes:
  + ai_title         text
  + processed_at     timestamptz
  + embedding        vector(1024)   -- alleen met pgvector

themes              -- nieuw
note_themes         -- nieuw, junction
note_links          -- nieuw, Zettelkasten links
ai_usage            -- nieuw, kosten-log
chapters            -- nieuw, Phase 4 hoofdstuk-outlines
```

Volledige schema in `supabase/schema.sql`. Idempotent — kan op een Phase 1-DB
uitgevoerd worden zonder verlies.

## UI

- Desktop-first 2-koloms layout (`process-grid`); op mobiel klapt het naar
  één kolom.
- Linker pane: ruwe nota.
- Rechter pane: bewerkbare suggesties.
- Topbar toont AI-uitgaven deze maand + inbox-teller.

## Edge functions

- `process-note` — vraag suggesties op voor één nota.
- `embed-note` — optioneel: vector embedding via Voyage AI.
- `generate-chapter` — Phase 4: cluster nota's tot hoofdstuk-schets.

Vereist GitHub/Supabase secrets:
- `ANTHROPIC_API_KEY`  (verplicht)
- `VOYAGE_API_KEY`     (optioneel)

Deploy via `supabase functions deploy <naam> --no-verify-jwt=false`.

## Definition of Done

- [ ] `/process` toont onverwerkte nota's één voor één
- [ ] AI-suggesties verschijnen binnen 5s op `claude-haiku-4-5`
- [ ] Elk veld is bewerkbaar voor accept
- [ ] Status gaat naar `verwerkt` met timestamp
- [ ] `note_themes` en `note_links` worden aangemaakt
- [ ] Kostentracker toont actuele maand-uitgaven
- [ ] Cap-warning verschijnt vanaf 80%
- [ ] AI in 80% van de gevallen accuraat genoeg dat geen wijziging nodig is
