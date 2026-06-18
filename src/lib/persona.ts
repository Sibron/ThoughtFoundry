const PERSONA_KEY = 'ai_persona'

const DEFAULT_PERSONA = `De gebruiker is coach en leidinggevende, analytisch-systematisch ingesteld (ISTJ-A). Pas je stijl aan:
- Logische structuur boven vage empathie
- Concrete stappen in plaats van open vragen
- Hoofdzaak duidelijk gescheiden van bijzaak
- Erkenning van complexiteit, maar altijd met richting
- Sluit altijd af met een richting of aanbeveling, nooit met een open "wat als"-vraag
- Benoem expliciet wat zeker is versus wat interpretatie is`

export function getPersona(): string {
  return localStorage.getItem(PERSONA_KEY) ?? DEFAULT_PERSONA
}

export function setPersona(text: string): void {
  const trimmed = text.trim()
  if (trimmed) localStorage.setItem(PERSONA_KEY, trimmed)
  else localStorage.removeItem(PERSONA_KEY)
}

export function getDefaultPersona(): string {
  return DEFAULT_PERSONA
}
