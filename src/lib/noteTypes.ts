export type NoteType =
  | 'fleeting'
  | 'question'
  | 'literature'
  | 'permanent'
  | 'reflection'
  | 'framework'

export interface NoteTypeMeta {
  label: string
  desc: string
  color: string
  accent: string // lighter tint for backgrounds
}

export const NOTE_TYPES: Record<NoteType, NoteTypeMeta> = {
  fleeting:   { label: 'Vluchtig',  desc: 'Ruwe gedachte, onbewerkt',              color: '#B8824A', accent: '#FDF2E6' },
  question:   { label: 'Vraag',     desc: 'Open vraag, nog zonder antwoord',        color: '#7E5E9E', accent: '#F4EEFB' },
  literature: { label: 'Bron',      desc: 'Notitie uit boek/opleiding/artikel',     color: '#5E8A72', accent: '#EAF4EE' },
  permanent:  { label: 'Permanent', desc: 'Uitgewerkt idee in eigen woorden',        color: '#4E749C', accent: '#E8F0F8' },
  reflection: { label: 'Reflectie', desc: 'Coachingcase of eigen ervaring',          color: '#6E7E52', accent: '#EFF2E6' },
  framework:  { label: 'Kader',     desc: 'Model, checklist of structuur',           color: '#5E6E82', accent: '#EAEEF4' },
}

export const NOTE_TYPE_ORDER: NoteType[] = [
  'fleeting', 'question', 'literature', 'permanent', 'reflection', 'framework'
]
