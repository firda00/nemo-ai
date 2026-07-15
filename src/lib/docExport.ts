export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Small, deliberately restricted Markdown renderer for downloadable documents.
// User content is escaped before the supported formatting tags are added.
export function markdownToDocumentHtml(markdown: string): string {
  const inline = (value: string) => escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*(.+?)\*/g, '$1<i>$2</i>')
    .replace(/`(.+?)`/g, '<code>$1</code>')

  let html = ''
  let inList = false
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^(#{1,6})\s+(.*)/)
    if (heading) {
      if (inList) { html += '</ul>'; inList = false }
      const level = Math.min(heading[1].length, 4)
      html += `<h${level}>${inline(heading[2])}</h${level}>`
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { html += '<ul>'; inList = true }
      html += `<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`
      continue
    }
    if (inList) { html += '</ul>'; inList = false }
    if (line.trim() !== '') html += `<p>${inline(line)}</p>`
  }
  if (inList) html += '</ul>'
  return html
}

export const DOCUMENT_STYLE = 'body{font-family:Georgia,"Times New Roman",serif;color:#111;max-width:720px;margin:32px auto;padding:0 24px;line-height:1.55}h1,h2,h3,h4{font-family:Arial,Helvetica,sans-serif;color:#1a1a2e;line-height:1.2}h1{font-size:26px}h2{font-size:21px}h3{font-size:17px}code{background:#f2f2f6;padding:1px 4px;border-radius:4px;font-size:.92em}ul{padding-left:22px}li{margin:3px 0}p{margin:8px 0}'

export function safeDocumentName(title: string): string {
  return (title || 'nemo')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .slice(0, 40)
    .replace(/^-|-$/g, '') || 'nemo'
}

export function buildWordDocument(content: string, title: string): string {
  return `<!DOCTYPE html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${DOCUMENT_STYLE}</style></head><body>${markdownToDocumentHtml(content)}</body></html>`
}

export function buildPrintableDocument(content: string, title: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${DOCUMENT_STYLE}@media print{body{margin:0}}</style></head><body>${markdownToDocumentHtml(content)}<script>window.onload=function(){window.print()}</script></body></html>`
}
