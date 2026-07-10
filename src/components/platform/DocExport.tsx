import { FileText, FileType2, FileDown } from 'lucide-react'
import { useI18n } from '../../i18n'

// Minimal Markdown -> HTML (headings, bold/italic/code, bullet lists, paragraphs) so the
// exported Word/PDF looks like a real document, not a raw dump.
function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s: string) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*(.+?)\*/g, '$1<i>$2</i>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
  let html = '', inList = false
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^(#{1,6})\s+(.*)/)
    if (h) { if (inList) { html += '</ul>'; inList = false } const lvl = Math.min(h[1].length, 4); html += `<h${lvl}>${inline(h[2])}</h${lvl}>`; continue }
    if (/^\s*[-*]\s+/.test(line)) { if (!inList) { html += '<ul>'; inList = true } html += `<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`; continue }
    if (inList) { html += '</ul>'; inList = false }
    if (line.trim() === '') continue
    html += `<p>${inline(line)}</p>`
  }
  if (inList) html += '</ul>'
  return html
}

const STYLE = 'body{font-family:Georgia,"Times New Roman",serif;color:#111;max-width:720px;margin:32px auto;padding:0 24px;line-height:1.55}h1,h2,h3,h4{font-family:Arial,Helvetica,sans-serif;color:#1a1a2e;line-height:1.2}h1{font-size:26px}h2{font-size:21px}h3{font-size:17px}code{background:#f2f2f6;padding:1px 4px;border-radius:4px;font-size:.92em}ul{padding-left:22px}li{margin:3px 0}p{margin:8px 0}'

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  URL.revokeObjectURL(url)
}
const safe = (t: string) => (t || 'nemo').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40).replace(/^-|-$/g, '') || 'nemo'

/**
 * Export an agent deliverable as a real downloadable file: Markdown, Word (.doc, opens in
 * MS Word / Google Docs) or PDF (via the browser's print dialog). No external libraries.
 */
export function DocExport({ content, title = 'Nemo' }: { content: string; title?: string }) {
  const { t } = useI18n()
  const base = safe(title)

  const asMarkdown = () => download(`${base}.md`, new Blob([content], { type: 'text/markdown;charset=utf-8' }))
  const asWord = () => {
    const doc = `<!DOCTYPE html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${title}</title><style>${STYLE}</style></head><body>${mdToHtml(content)}</body></html>`
    download(`${base}.doc`, new Blob(['﻿', doc], { type: 'application/msword' }))
  }
  const asPdf = () => {
    const w = window.open('', '_blank')
    if (!w) return
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><style>${STYLE}@media print{body{margin:0}}</style></head><body>${mdToHtml(content)}<script>window.onload=function(){window.print()}</script></body></html>`)
    w.document.close()
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted">{t('docExport.export')}</span>
      <button onClick={asWord} className="inline-flex items-center gap-1.5 rounded-lg border border-ice/12 px-2.5 py-1.5 text-[12px] font-medium text-muted transition hover:text-text"><FileType2 size={13} className="text-cyan" /> Word</button>
      <button onClick={asPdf} className="inline-flex items-center gap-1.5 rounded-lg border border-ice/12 px-2.5 py-1.5 text-[12px] font-medium text-muted transition hover:text-text"><FileDown size={13} className="text-danger" /> PDF</button>
      <button onClick={asMarkdown} className="inline-flex items-center gap-1.5 rounded-lg border border-ice/12 px-2.5 py-1.5 text-[12px] font-medium text-muted transition hover:text-text"><FileText size={13} className="text-violet" /> Markdown</button>
    </div>
  )
}
