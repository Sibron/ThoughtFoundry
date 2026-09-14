import { renderShell } from '../lib/shell'
import { mountThemes } from './themes'
import { mountSources } from './sources'
import { mountBook } from './book'

export function renderLibrary(app: HTMLElement): Promise<void> {
  return renderShell(app, {
    title: 'Bibliotheek',
    navKey: 'library',
    tabs: [
      { key: 'themes',  label: "Thema's", mount: mountThemes },
      { key: 'sources', label: 'Bronnen', mount: mountSources },
      { key: 'book',    label: 'Boek',    mount: mountBook },
    ],
  })
}
