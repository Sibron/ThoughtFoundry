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
  fleeting:   { label: 'Vluchtig',  desc: 'Ruwe gedachte, onbewerkt',              color: '#B8956A', accent: '#FDF3E8' },
  question:   { label: 'Vraag',     desc: 'Open vraag, nog zonder antwoord',        color: '#8B6BA8', accent: '#F3EDFC' },
  literature: { label: 'Bron',      desc: 'Notitie uit boek/opleiding/artikel',     color: '#6B8E7F', accent: '#EDF5F1' },
  permanent:  { label: 'Permanent', desc: 'Uitgewerkt idee in eigen woorden',        color: '#5C7FA6', accent: '#EAF1F8' },
  reflection: { label: 'Reflectie', desc: 'Coachingcase of eigen ervaring',          color: '#7F8B6B', accent: '#F1F3EB' },
  framework:  { label: 'Kader',     desc: 'Model, checklist of structuur',           color: '#6B7A8E', accent: '#EEF0F4' },
}

export const NOTE_TYPE_ORDER: NoteType[] = [
  'fleeting', 'question', 'literature', 'permanent', 'reflection', 'framework'
]
