// Verbanden — the two connection-exploration views that used to live inside the
// Vangbak: the graph and the semantic-bridges review queue. Deep-links use
// ?view= (with Dutch aliases) because the repointed legacy /inbox?view=… links
// carry that param name. ?focus=<id> needs no handling here: mountGraph reads
// it from the hash itself.

import { renderShell } from '../lib/shell'
import { mountGraph } from './graph'
import { mountConnections } from './connections'

export function renderVerbanden(app: HTMLElement): Promise<void> {
  return renderShell(app, {
    title: 'Verbanden',
    navKey: 'verbanden',
    param: 'view',
    aliases: { graaf: 'graph', verbindingen: 'connections' },
    tabs: [
      { key: 'graph',       label: 'Graaf',        mount: mountGraph },
      { key: 'connections', label: 'Verbindingen', mount: mountConnections },
    ],
    intros: {
      graph:       'Jouw notities als netwerk: zie hoe ideeën samenhangen.',
      connections: 'Voorgestelde verbindingen tussen notities — jij beslist.',
    },
  })
}
