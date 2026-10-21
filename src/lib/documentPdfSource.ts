import { getDocument, GlobalWorkerOptions, OPS } from 'pdfjs-dist'
import { DocumentSourceError, MAX_SOURCE_BYTES, checkSourceScope, type SourceData } from './documentSources'

export async function parseDocumentPdf(buffer: ArrayBuffer, scope: { signal: AbortSignal; alive: () => boolean }): Promise<SourceData> {
  checkSourceScope(scope)
  GlobalWorkerOptions.workerSrc = new URL('../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
  const loading = getDocument({ data: buffer, useSystemFonts: false, disableFontFace: true, stopAtErrors: true, maxImageSize: 0 })
  const abort = () => { void loading.destroy().catch(() => {}) }
  scope.signal.addEventListener('abort', abort, { once: true })
  const fragments: Array<{ locator: string; text: string }> = []
  let bytes = 0
  try {
    const pdf = await loading.promise
    checkSourceScope(scope)
    if (pdf.numPages > 128) throw new DocumentSourceError('too_large')
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      checkSourceScope(scope)
      const page = await pdf.getPage(pageNo)
      checkSourceScope(scope)
      // A scanned page with a text footer is still a scan. Refuse visible image/path/shading
      // content whose factual meaning cannot be represented by the text layer alone.
      const operators = await page.getOperatorList().catch(() => { throw new DocumentSourceError('incomplete') })
      checkSourceScope(scope)
      const unsupported = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject,
        OPS.paintImageMaskXObjectGroup, OPS.paintInlineImageXObjectGroup, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat,
        OPS.paintSolidColorImageMask, OPS.shadingFill, OPS.constructPath])
      if (operators.fnArray.some((op: number) => unsupported.has(op))) throw new DocumentSourceError('incomplete')
      // Form fields/annotations may contain factual text absent from the page's text layer.
      if ((await page.getAnnotations()).length) throw new DocumentSourceError('incomplete')
      checkSourceScope(scope)
      const reader = page.streamTextContent().getReader()
      let text = ''
      try {
        for (;;) {
          const chunk = await reader.read()
          checkSourceScope(scope)
          if (chunk.done) break
          for (const item of chunk.value.items) if ('str' in item) {
            const addition = item.str + (item.hasEOL ? '\n' : ' ')
            bytes += new TextEncoder().encode(addition).length
            if (bytes > MAX_SOURCE_BYTES) throw new DocumentSourceError('too_large')
            text += addition
          }
        }
      } finally { await reader.cancel().catch(() => {}); page.cleanup() }
      if (!text.trim()) throw new DocumentSourceError('incomplete') // scanned/blank page: no quiet omission
      fragments.push({ locator: `page:${pageNo}`, text })
    }
    return { format: 'pdf', fragments }
  } finally { scope.signal.removeEventListener('abort', abort); await loading.destroy().catch(() => {}) }
}
