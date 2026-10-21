import { parseDocumentSourceBytes, preflightDocumentPdf } from './documentSourceParser'
import { DocumentSourceError } from './documentSources'
self.onmessage = (event: MessageEvent<{ format: 'text' | 'docx' | 'xlsx' | 'pdf'; buffer: ArrayBuffer }>) => {
  try {
    if (event.data.format === 'pdf') { preflightDocumentPdf(new Uint8Array(event.data.buffer)); self.postMessage({ ok: true, data: null }) }
    else self.postMessage({ ok: true, data: parseDocumentSourceBytes(event.data.format, new Uint8Array(event.data.buffer)) })
  }
  catch (error) { self.postMessage({ ok: false, code: error instanceof DocumentSourceError ? error.code : 'unreadable' }) }
}
