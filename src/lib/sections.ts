// The five book-chapter sections a note can belong to. Shared between the
// process accelerator and the note editor so the slugs/labels never drift.

export interface SectionMeta {
  slug: string
  label: string
}

export const SECTIONS: SectionMeta[] = [
  { slug: 'probleemstelling',          label: 'Probleemstelling' },
  { slug: 'theoretische_onderbouwing', label: 'Theoretische onderbouwing' },
  { slug: 'ondersteunende_concepten',  label: 'Ondersteunende concepten' },
  { slug: 'methodieken',               label: 'Methodieken / handvaten' },
  { slug: 'reflectievragen',           label: 'Reflectie- of verdiepingsvragen' },
]

export function sectionLabel(slug: string | null): string {
  if (!slug) return ''
  return SECTIONS.find(s => s.slug === slug)?.label ?? slug
}
