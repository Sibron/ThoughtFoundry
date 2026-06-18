// Web Share Target handling. The PWA manifest declares a GET share_target that
// points at the app root with ?title=&text=&url= params. When the OS shares
// into ThoughtFoundry we land here: fold the shared bits into the capture draft
// (so restoreDraft picks them up), clean the URL, and route to /capture.

const DRAFT_KEY = 'capture_draft'

interface CaptureDraft {
  content?: string
  url?: string
}

export function consumeSharedContent(): void {
  const params = new URLSearchParams(window.location.search)
  const title = (params.get('title') ?? '').trim()
  const text = (params.get('text') ?? '').trim()
  const url = (params.get('url') ?? '').trim()

  if (!title && !text && !url) return

  const content = [title, text].filter(Boolean).join('\n').trim() || url
  const draft: CaptureDraft = { content }
  if (url) draft.url = url

  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  } catch { /* storage full / unavailable — best effort */ }

  // Drop the query string (keep the base path) and force the capture route.
  history.replaceState(null, '', window.location.pathname + '#/capture')
  if (window.location.hash !== '#/capture') window.location.hash = '/capture'
}
