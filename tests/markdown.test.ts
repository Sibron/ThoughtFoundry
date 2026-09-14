import { describe, expect, it } from 'vitest'
import { countWords, renderMarkdownHtml } from '../src/lib/markdown'

// This renderer writes straight into innerHTML, and it renders AI output and
// text pulled from arbitrary websites by analyze-source. Escaping is the whole
// safety story, so it is tested first.
describe('renderMarkdownHtml escaping', () => {
  it('escapes raw HTML instead of passing it through', () => {
    const html = renderMarkdownHtml('<img src=x onerror="alert(1)">')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('escapes HTML inside emphasis and headings', () => {
    expect(renderMarkdownHtml('## <script>x</script>')).not.toContain('<script>')
    expect(renderMarkdownHtml('**<b>x</b>**')).toContain('&lt;b&gt;')
  })

  it('only linkifies http(s) targets', () => {
    expect(renderMarkdownHtml('[klik](https://example.com)'))
      .toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">klik</a>')
    const js = renderMarkdownHtml('[klik](javascript:alert(1))')
    expect(js).not.toContain('<a ')
    expect(js).not.toContain('href')
  })
})

describe('renderMarkdownHtml grammar', () => {
  it('shifts markdown headings down one level', () => {
    expect(renderMarkdownHtml('# Kop')).toBe('<h2>Kop</h2>')
    expect(renderMarkdownHtml('### Kop')).toBe('<h4>Kop</h4>')
  })

  it('renders bold and italic', () => {
    expect(renderMarkdownHtml('**vet**')).toContain('<strong>vet</strong>')
    expect(renderMarkdownHtml('een *schuin* woord')).toContain('<em>schuin</em>')
  })

  it('renders and closes unordered and ordered lists', () => {
    const ul = renderMarkdownHtml('- een\n- twee')
    expect(ul).toBe('<ul>\n<li>een</li>\n<li>twee</li>\n</ul>')
    expect(renderMarkdownHtml('1. een')).toBe('<ol>\n<li>een</li>\n</ol>')
  })

  it('closes a list when prose resumes', () => {
    const html = renderMarkdownHtml('- een\n\ngewone alinea')
    expect(html).toContain('</ul>')
    expect(html.indexOf('</ul>')).toBeLessThan(html.indexOf('<p>gewone alinea</p>'))
  })

  it('renders blockquotes and wraps bare lines in paragraphs', () => {
    expect(renderMarkdownHtml('> citaat')).toBe('<blockquote>\n<p>citaat</p>\n</blockquote>')
    expect(renderMarkdownHtml('los')).toBe('<p>los</p>')
  })

  it('returns an empty string for empty input', () => {
    expect(renderMarkdownHtml('')).toBe('')
  })
})

describe('countWords', () => {
  it('counts whitespace-separated words', () => {
    expect(countWords('een twee  drie\nvier')).toBe(4)
  })
  it('treats empty, blank and missing text as zero', () => {
    expect(countWords('')).toBe(0)
    expect(countWords('   ')).toBe(0)
    expect(countWords(null)).toBe(0)
    expect(countWords(undefined)).toBe(0)
  })
})
