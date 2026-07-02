// Tiny, safe Markdown → HTML for previews (studio, spark results). Escapes
// FIRST, then applies a deliberately small grammar: headings, bold, italic,
// links, unordered/ordered lists, blockquotes, paragraphs. No dependency, no
// raw-HTML passthrough.

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function inline(text: string): string {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*\n]+?)\*(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/(^|\W)_([^_\n]+?)_(?=\W|$)/g, '$1<em>$2</em>')
    // [text](https://…) — only http(s) targets survive.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
}

export function renderMarkdownHtml(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  let inQuote = false

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null } }
  const closeQuote = () => { if (inQuote) { out.push('</blockquote>'); inQuote = false } }

  for (const raw of lines) {
    const line = raw.trimEnd()

    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      closeList(); closeQuote()
      const level = Math.min(heading[1].length + 1, 5) // h1 in md -> h2 in page
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }
    if (/^[-*]\s+/.test(line)) {
      closeQuote()
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul' }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`)
      continue
    }
    if (/^\d+\.\s+/.test(line)) {
      closeQuote()
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol' }
      out.push(`<li>${inline(line.replace(/^\d+\.\s+/, ''))}</li>`)
      continue
    }
    if (/^>\s?/.test(line)) {
      closeList()
      if (!inQuote) { out.push('<blockquote>'); inQuote = true }
      out.push(`<p>${inline(line.replace(/^>\s?/, ''))}</p>`)
      continue
    }
    if (line.trim() === '') {
      closeList(); closeQuote()
      continue
    }
    closeList(); closeQuote()
    out.push(`<p>${inline(line)}</p>`)
  }
  closeList(); closeQuote()
  return out.join('\n')
}

/** Rough word count for progress display. */
export function countWords(text: string | null | undefined): number {
  if (!text) return 0
  return text.trim().split(/\s+/).filter(Boolean).length
}
