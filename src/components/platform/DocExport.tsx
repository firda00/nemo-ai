import { FileText, FileType2, FileDown } from 'lucide-react'
import { useI18n } from '../../i18n'
import { buildPrintableDocument, buildWordDocument, safeDocumentName } from '../../lib/docExport'

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  URL.revokeObjectURL(url)
}

/**
 * Export an agent deliverable as a real downloadable file: Markdown, Word (.doc, opens in
 * MS Word / Google Docs) or PDF (via the browser's print dialog). No external libraries.
 */
export function DocExport({ content, title = 'Nemo' }: { content: string; title?: string }) {
  const { t } = useI18n()
  const base = safeDocumentName(title)

  const asMarkdown = () => download(`${base}.md`, new Blob([content], { type: 'text/markdown;charset=utf-8' }))
  const asWord = () => {
    const doc = buildWordDocument(content, title)
    download(`${base}.doc`, new Blob(['﻿', doc], { type: 'application/msword' }))
  }
  const asPdf = () => {
    const w = window.open('', '_blank')
    if (!w) return
    w.document.write(buildPrintableDocument(content, title))
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
