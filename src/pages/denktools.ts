import { renderShell } from '../lib/shell'
import { mountSpark } from './spark'
import { mountDenkpartner } from './denkpartner'
import { mountClusters } from './clusters'

export function renderDenktools(app: HTMLElement): Promise<void> {
  return renderShell(app, {
    title: 'Denktools',
    navKey: 'denktools',
    tabs: [
      { key: 'spark',       label: 'Spark',       mount: mountSpark },
      { key: 'denkpartner', label: 'Denkpartner', mount: mountDenkpartner },
      { key: 'clusters',    label: 'Clusters',    mount: mountClusters },
    ],
    intros: {
      spark:       'Synthese: laat AI jouw notities tot een tekst smeden.',
      denkpartner: 'Tegenspraak: scherpe vragen die je blinde vlekken blootleggen.',
      clusters:    'Patronen: impliciete thema-clusters in je verwerkte notities.',
    },
  })
}
