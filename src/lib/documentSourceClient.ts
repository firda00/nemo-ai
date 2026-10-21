import { checkSourceScope, DocumentSourceError, MAX_SOURCE_BATCH_BYTES, MAX_SOURCE_BYTES, MAX_SOURCE_FILE_BYTES,
  SOURCE_TIMEOUT_MS, validateSourceSnapshot, type DocumentSourceSnapshot, type SourceData, type SourceErrorCode } from './documentSources'
import { serializedPayloadBytes } from '../../agent-hub/documents/document-models'

type Scope = { signal: AbortSignal; alive: () => boolean }
type Format = 'text' | 'pdf' | 'docx' | 'xlsx'
export function sourceFileFormat(name: string): Format {
  if (/\.pdf$/i.test(name)) return 'pdf'
  if (/\.docx$/i.test(name)) return 'docx'
  if (/\.xlsx$/i.test(name)) return 'xlsx'
  if (/\.(txt|md|csv|tsv|json)$/i.test(name)) return 'text'
  throw new DocumentSourceError('unsupported', name)
}
function parseInWorker(format: Format, buffer: ArrayBuffer, scope: Scope): Promise<SourceData> {
  checkSourceScope(scope)
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./documentSource.worker.ts', import.meta.url), { type: 'module' })
    let settled = false
    const finish = (result: { ok: true; data: SourceData } | { ok: false; code: SourceErrorCode }) => {
      if (settled) return
      settled = true
      worker.terminate()
      scope.signal.removeEventListener('abort', abort)
      if (result.ok) resolve(result.data); else reject(new DocumentSourceError(result.code))
    }
    const abort = () => finish({ ok: false, code: 'cancelled' })
    scope.signal.addEventListener('abort', abort, { once: true })
    if (scope.signal.aborted) { abort(); return }
    worker.onmessage = (event) => finish(event.data)
    worker.onerror = () => finish({ ok: false, code: 'unreadable' })
    try { worker.postMessage({ format, buffer }, [buffer]) } catch { finish({ ok: false, code: 'unreadable' }) }
  })
}

export interface SourceExtractionDeps {
  read: (file: File) => Promise<ArrayBuffer>
  hash: (bytes: ArrayBuffer) => Promise<string>
  parse: (format: Format, bytes: ArrayBuffer, scope: Scope) => Promise<SourceData>
}
const defaultDeps: SourceExtractionDeps = {
  read: (file) => file.arrayBuffer(),
  hash: async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join(''),
  parse: async (format, bytes, scope) => {
    if (format !== 'pdf') return parseInWorker(format, bytes, scope)
    // Inspect in a disposable worker before PDF.js can decode images/object streams. Keep
    // the original buffer for PDF.js; both allocations remain within the file/batch budget.
    await parseInWorker('pdf', bytes.slice(0), scope)
    checkSourceScope(scope)
    return (await import('./documentPdfSource')).parseDocumentPdf(bytes, scope)
  },
}
// One deadline includes reads, hash and every file. Late reads/hashes cannot start new work.
export async function extractDocumentSources(files: File[], owner: string, submissionId: string, scope: Scope,
  deps: SourceExtractionDeps = defaultDeps, timeoutMs = SOURCE_TIMEOUT_MS): Promise<DocumentSourceSnapshot> {
  checkSourceScope(scope)
  if (!files.length || files.length > 4 || files.reduce((n, f) => n + f.size, 0) > MAX_SOURCE_BATCH_BYTES) throw new DocumentSourceError('too_large')
  const formats = files.map((file) => {
    if (file.size <= 0) throw new DocumentSourceError('unreadable', file.name)
    if (file.size > MAX_SOURCE_FILE_BYTES || file.name.length > 240) throw new DocumentSourceError('too_large', file.name)
    return sourceFileFormat(file.name)
  })
  const controller = new AbortController()
  const abort = () => controller.abort()
  scope.signal.addEventListener('abort', abort, { once: true })
  let timedOut = false
  let currentName = ''
  const deadline = Date.now() + timeoutMs
  const localScope = { signal: controller.signal, alive: () => {
    if (Date.now() >= deadline) { timedOut = true; controller.abort() }
    return !timedOut && scope.alive() && !scope.signal.aborted
  } }
  let abortReject: (() => void) | undefined
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  try {
    const cancelled = new Promise<never>((_, reject) => {
      abortReject = () => reject(new DocumentSourceError(timedOut ? 'timeout' : 'cancelled', currentName))
      controller.signal.addEventListener('abort', abortReject, { once: true })
    })
    const work = async () => {
      const sources: DocumentSourceSnapshot['sources'] = []
      for (const [index, file] of files.entries()) {
        currentName = file.name
        checkSourceScope(localScope)
        const bytes = await deps.read(file)
        checkSourceScope(localScope)
        if (bytes.byteLength !== file.size) throw new DocumentSourceError('unreadable')
        const sha256 = await deps.hash(bytes) // BEFORE worker transfer detaches buffer
        checkSourceScope(localScope)
        const data = await deps.parse(formats[index], bytes, localScope)
        checkSourceScope(localScope)
        sources.push({ id: `S${index + 1}`, name: file.name, size: file.size, sha256, data })
        if (serializedPayloadBytes(sources) > MAX_SOURCE_BYTES) throw new DocumentSourceError('too_large')
      }
      return validateSourceSnapshot({ version: 1, extractorVersion: 'text-sources-1', owner, submissionId, sources }, owner, submissionId)
    }
    return await Promise.race([work(), cancelled])
  } catch (error) {
    if (error instanceof DocumentSourceError) throw new DocumentSourceError(timedOut ? 'timeout' : error.code, error.fileName || currentName)
    throw new DocumentSourceError('unreadable', currentName)
  } finally {
    clearTimeout(timer)
    if (abortReject) controller.signal.removeEventListener('abort', abortReject)
    controller.abort()
    scope.signal.removeEventListener('abort', abort)
  }
}
