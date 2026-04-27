# ThoughtFoundry — Roadmap

**Doel:** stap-voor-stap begeleiding van "Copilot agent draait Phase 1" tot "Phase 2 staat klaar."
**Aanpak:** Claude AI doet alle code. Jouw rol = spec schrijven, reviewen, testen, gebruiken, beslissen.
**Status nu:** Phase 1 (Capture MVP) wordt gebouwd door Copilot Cloud Agent.

---

## Terminologie

Om verwarring te vermijden, twee verschillende reeksen:

| Term | Betekenis | Waar |
|---|---|---|
| **Phase 1, 2, 3, 4** | Productfeatures (Capture / AI-verwerking / Netwerk / Boekgeneratie) | `PROJECT_BRIEF.md` |
| **Fase A, B, C, D, E** | Workflow-stadia van dit project (deze roadmap) | dit document |

---

## Overzicht workflow

```
[Fase A] Setup & Live  →  [Fase B] Gebruiken  →  [Fase C] Stabiliseren  →
[Fase D] Phase 2 spec  →  [Fase E] Phase 2 bouwen  →  (cyclus herhaalt voor Phase 3, 4)
```

Lineair. Eén fase tegelijk. Niet vooruit werken.

---

## Drie kernregels

1. **Niet vooruitspringen.** Done-criterium niet behaald = volgende fase niet starten.
2. **Geen scope creep.** Tijdens Fase B raak je geen code aan. Tijdens Fase D schrijf je geen code.
3. **Twijfel = simpelste keuze.** Bij elke beslissing: minst werk wint.

---

# FASE A — Setup & Live

**Trigger:** Copilot heeft een PR geopend voor Phase 1.
**Doel:** ThoughtFoundry draait op `https://sibronprojectsthoughtfoundry.eu` en is geïnstalleerd als PWA op je gsm.

## Stappen

### A.1 — Supabase opzetten
- [ ] Account op [supabase.com](https://supabase.com)
- [ ] New project → naam `thoughtfoundry` → Region **Frankfurt (EU Central)** → sterk wachtwoord
- [ ] SQL Editor → `supabase/schema.sql` plakken → Run
- [ ] Verifiëren: Table Editor toont 4 tabellen (`notes`, `themes`, `note_themes`, `note_links`)
- [ ] Authentication → Users → Add user → jouw email + sterk wachtwoord
- [ ] Authentication → URL Configuration → Site URL: `https://sibronprojectsthoughtfoundry.eu`
- [ ] Settings → API → kopieer `Project URL` + `anon public` key naar wachtwoordmanager

### A.2 — Vimexx + domein
- [ ] Subdomein `sibronprojectsthoughtfoundry.eu` actief in Vimexx-paneel
- [ ] **SSL aanzetten** (Let's Encrypt — kritisch, zonder HTTPS geen PWA)
- [ ] FTP-credentials noteren: server, username, password, webroot path
- [ ] FTP-toegang testen (FileZilla of Vimexx-bestandsbeheer)

### A.3 — PR reviewen (kritische stap, niet overslaan)
- [ ] PR-beschrijving lezen, agent's checklist doorlopen
- [ ] Bestandsstructuur vergelijken met sectie 3 van `PROJECT_BRIEF.md`
- [ ] `package.json` — alleen verwachte dependencies?
- [ ] `src/pages/capture.ts` — lees volledig, snap je elke regel?
- [ ] `src/lib/supabase.ts` — env vars correct?
- [ ] Definition of Done (sectie 12 brief) afgevinkt door agent?
- [ ] Iets onduidelijk → comment op PR, vraag Copilot om uitleg. Niet zelf rommelen.

### A.4 — Lokaal testen
- [ ] PR-branch lokaal pullen in PyCharm
- [ ] `npm install`
- [ ] `.env` invullen (Supabase URL + anon key)
- [ ] `npm run dev` → `http://localhost:5173`
- [ ] **Test-script:**
  1. Login werkt (wrong + right password)
  2. Capture: typ idee → opslaan → veld leeg, focus terug
  3. Inbox: idee staat bovenaan
  4. Bewerken werkt en persisteert
  5. Verwijderen werkt (met confirm)
  6. Cmd/Ctrl+Enter slaat op
  7. Supabase Table Editor toont/wijzigt/verwijdert de juiste rows
- [ ] Bug? → comment op PR, vraag Copilot om fix. Stop fase A hier tot fix erin zit.

### A.5 — Deploy naar productie
- [ ] GitHub Secrets toevoegen:
  - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
  - `FTP_SERVER`, `FTP_USERNAME`, `FTP_PASSWORD`, `FTP_SERVER_DIR`
- [ ] PR mergen naar `main`
- [ ] GitHub Actions → wachten tot deploy groen
- [ ] `https://sibronprojectsthoughtfoundry.eu` → login werkt
- [ ] Eerste echte productie-nota toevoegen → check Supabase

### A.6 — PWA installeren op gsm
- [ ] Chrome Android → site openen → "Toevoegen aan startscherm"
- [ ] App vanaf startscherm openen → geen browserbalk = correct
- [ ] Vlieg-modus aan → nota toevoegen → opslaan in offline queue
- [ ] Vlieg-modus uit → herlaad → nota gesynchroniseerd

## Done-criterium Fase A

✅ Je kan vanaf je gsm in 2 taps een nota vastleggen, online of offline.

> **Stop-signaal:** als A.6 niet werkt, niet doorgaan naar Fase B. Issue openen, agent laten fixen.

---

# FASE B — Gebruiken & Observeren

**Trigger:** Fase A done.
**Doel:** echte gebruikspatronen ontdekken voor je iets nieuws bouwt.
**Codewijzigingen tijdens deze fase: NUL.**

Dit is de fase die in je Notion-systeem ontbrak. Je bouwde, je gebruikte niet. Nu omgekeerd.

## Werkwijze

**Capture-zijde (continu):**
- Idee komt op → direct in app → 2 taps → klaar
- Geen overdenken of het "goed genoeg" is
- Geen tags, geen thema's bedenken (komt in Phase 2)

**Reflectie-zijde (na elk gebruik):**
- Open `FRICTION_LOG.md` in je repo (maak aan bij start Fase B)
- Eén regel per frustratie of observatie. Voorbeelden:
  - "Wilde extra notitie toevoegen, tap-target te klein"
  - "Vergat dat ik al iets gelijkaardigs had ingevoerd"
  - "Inbox onoverzichtelijk vanaf 30+ items"
  - "Mistte 'snel idee' vs 'belangrijk idee' onderscheid"
- Geen oplossingen bedenken. Pure observatie.

## Stop-signalen tijdens Fase B

Herken deze gedachten — doe NIETS:

| Gedachte | Reactie |
|---|---|
| *"Ik moet snel een tag-systeem toevoegen"* | NEE → friction log |
| *"De kleur klopt niet, even fixen"* | NEE → friction log |
| *"Mis een snelle bewerk-knop"* | NEE → friction log |
| *"Misschien moet ik toch ook…"* | NEE → friction log |

**Reden:** pas met genoeg gebruik weet je wat structureel knelt vs. wat eenmalige ergernis was. Anders bouw je opnieuw een toren die je niet gebruikt.

## Done-criteria Fase B

Alle drie moeten waar zijn:

- ✅ **Minimum 30 nota's** vastgelegd in productie-database
- ✅ **Minimum 7 friction log entries**
- ✅ **Minimum 3 verschillende gebruikscontexten** ervaren (bv: tijdens werk, onderweg, thuis 's avonds)

> **Belangrijk:** dit is GEEN tijdgebonden criterium. Het kan een week duren of een maand. Het signaal is gebruik, niet kalender.

> **Anti-haast-check:** als je met 12 nota's al naar Fase C wil → herlees je eigen friction log. Zie je 5+ entries die ALS je doorbouwt vanzelf opnieuw zullen voorkomen? Zo ja, te vroeg.

---

# FASE C — Stabiliseren

**Trigger:** Fase B done-criteria allemaal afgevinkt.
**Doel:** Phase 1 is solide voor je AI-verwerking erop bouwt.

## C.1 — Friction log analyseren

- [ ] Friction log volledig doorlezen
- [ ] Per regel labelen:
  - **S** = structureel (komt blijven terugkomen)
  - **E** = eenmalig (eenmalige ergernis, gewenning)
- [ ] Schrappen alle E-items
- [ ] S-items splitsen in twee categorieën:

| Categorie | Wat | Wat ermee |
|---|---|---|
| **Capture-bugs** | Iets is stuk of slecht in de huidige Phase 1 | Fixen NU (Fase C) |
| **Verwerk-noden** | Iets vraagt om AI/structuur die er nog niet is | Input voor Phase 2 spec (Fase D) |

> **Hoofdzaak vs bijzaak:** maximaal 5 capture-bugs labelen als kritisch. Meer dan 5 = je bent te streng aan het filteren. Herlees, schrap.

## C.2 — Capture-bugs als GitHub Issues

- [ ] Per kritische capture-bug één issue:
  - Titel: korte beschrijving
  - Body: huidig gedrag / gewenst gedrag / hoe vaak het voorkwam
  - Label: `phase-1-fix`
  - Prioriteit 1-5

## C.3 — Agent laten fixen

- [ ] Copilot opdracht: "Fix issues labeled `phase-1-fix` in priority order. One PR per issue."
- [ ] Per PR: lokaal testen → mergen → deploy verifiëren op productie
- [ ] Niet meerdere PR's tegelijk mergen

## Done-criterium Fase C

✅ Alle `phase-1-fix` issues gesloten. Geen bekende capture-bugs open.

---

# FASE D — Phase 2 Specificatie

**Trigger:** Fase C done.
**Doel:** een Phase 2 brief schrijven met dezelfde diepgang als `PROJECT_BRIEF.md`, gebaseerd op echte gebruiksdata.

## D.1 — Brief schrijven

Maak `PHASE_2_BRIEF.md` met deze secties:

- [ ] **Context:** kort, wat doet Phase 2 toevoegen aan ThoughtFoundry
- [ ] **Verwerk-noden:** lijst van alle verwerk-S-items uit Fase C, gegroepeerd
- [ ] **AI-acties:** wat moet Claude doen bij verwerking?
  - Types detecteren (theorie / voorbeeld / methodiek / ...)
  - Tags voorstellen
  - Bestaande thema's matchen, nieuwe voorstellen
  - Vergelijkbare nota's vinden (via embeddings)
  - Korte samenvatting genereren
- [ ] **Activatie:** manuele knop "Verwerk inbox" — niet automatisch bij opslaan
- [ ] **Goedkeur-flow:** jij accepteert/wijzigt elke suggestie voor het persisteert
- [ ] **Modelkeuze:** Claude Haiku 4.5 voor snelle taken, Sonnet voor complexere — of allebei
- [ ] **Kostenplafond:** bv. max €5/maand → client-side teller, waarschuwing bij 80%
- [ ] **Datamodel-aanpassingen:** welke velden vult AI in? (`types`, `tags`, `ai_summary`, `embedding`, gekoppelde `themes`)
- [ ] **UI:** verwerk-scherm = desktop-first, één nota per keer, suggesties aan rechterkant, accepteer/wijzig per veld
- [ ] **Definition of Done:** concrete checklist zoals in `PROJECT_BRIEF.md` sectie 12

## D.2 — Brief reviewen op interne consistentie

- [ ] Stel jezelf één vraag: *"Als ik Phase 2 morgen krijg zoals nu beschreven — lost het al mijn verwerk-noden op?"*
- [ ] Zo nee → brief aanvullen
- [ ] Zo ja → committen naar repo

## Done-criterium Fase D

✅ `PHASE_2_BRIEF.md` staat in repo, dekt alle verwerk-noden uit Fase C, heeft Definition of Done.

---

# FASE E — Phase 2 Bouwen

**Trigger:** Fase D done.
**Doel:** AI-verwerking live op productie.

## E.1 — Agent starten
- [ ] Copilot opdracht: "Read PHASE_2_BRIEF.md and implement in full. Open a PR."

## E.2 — Reviewcyclus
Hetzelfde patroon als Fase A.3-A.5:
- PR reviewen → lokaal testen → secrets aanvullen (`ANTHROPIC_API_KEY`) → mergen → productie verifiëren

## E.3 — Gebruiksperiode (mini-Fase B voor Phase 2)
Zelfde discipline als Fase B:
- Verwerk regelmatig je inbox via de nieuwe AI-knop
- Friction log bijhouden (apart bestand of zelfde, met `[P2]` prefix)
- Geen nieuwe features bouwen tot je echt patroon ziet

## Done-criterium Fase E

✅ AI verwerkt nota's accuraat genoeg dat jij in 80% van de gevallen "Accepteer" klikt zonder wijziging.

---

# Faaltabel

| Probleem | Eerste check | Volgende stap |
|---|---|---|
| Supabase: SQL geeft error op `vector` extensie | Niet beschikbaar in regio? | Skip die regel — vector is voor Phase 2, niet kritisch nu |
| Supabase: kan geen user aanmaken | Email confirmatie aan? | Settings → Auth → uncheck "Enable email confirmations" |
| Vimexx: SSL werkt niet | DNS gepropageerd? | Wacht 1-2u, retry |
| GitHub Action: FTP fail | Secret correct gespeld? | Check exact: hoofdletters, geen spaties |
| Lokaal: `npm install` faalt | Node-versie? | Gebruik Node 20 LTS |
| Lokaal: blank scherm | Console error? | Meestal env var ontbreekt — check `.env` |
| PWA: "Toevoegen aan startscherm" verschijnt niet | HTTPS actief? | Eerst Vimexx SSL fixen |
| Login werkt niet op productie | CORS-error? | Supabase → Auth → URL Configuration → Site URL toevoegen |
| Iets anders | — | Comment op PR/issue, agent oplossen laten. Niet zelf urenlang debuggen. |

---

# Self-check vragen

Stel jezelf bij elke fase-overgang:

1. Heb ik op eigen houtje code gewijzigd dat NIET in een fase-stap stond? → herlees regel 2
2. Is het done-criterium echt behaald, of overtuig ik mezelf? → eerlijke check
3. Voel ik drang naar de volgende fase voor de huidige af is? → herken patroon, stop
4. Werkt het systeem voor mij, of werk ik voor het systeem?

---

# Wat staat er bewust NIET in deze roadmap

- **Phase 3** (netwerk-visualisatie van nota-verbanden) — komt na Fase E
- **Phase 4** (boekgeneratie / hoofdstuk-export) — laatste fase
- **Multi-user / sharing** — nooit, persoonlijke tool
- **Native mobile-app** — PWA volstaat

Als iets daarvan toch dringend voelt → friction log, niet bouwen.

---

**Slot:** deze roadmap is de externe prefrontale cortex voor dit project. Vertrouw de structuur. Als je merkt dat je ervan afwijkt, vraag jezelf: optimaliseer ik, of ontwijk ik?
