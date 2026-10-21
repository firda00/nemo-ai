import { Unzip, UnzipInflate } from 'fflate'
import { DocumentSourceError } from './documentSourceError.ts'
export function decode(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new DocumentSourceError('unreadable') }
}
export function boundedOfficeParts(bytes: Uint8Array, format: 'docx' | 'xlsx', limits = { entryBytes: 8 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 }): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = Object.create(null)
  const names = new Set<string>()
  let total = 0
  let failure: DocumentSourceError | null = null
  const unzip = new Unzip((file) => {
    if (failure) return
    if (names.has(file.name) || names.size >= 256 || file.name.includes('..') || file.name.includes('\\')) { failure = new DocumentSourceError('unreadable'); return }
    names.add(file.name)
    // A text-only contract cannot silently discard pictures, equations, embedded files.
    if (/^(word|xl)\/(media|embeddings|charts|externalLinks)\/|^xl\/comments|vbaProject/i.test(file.name)) { failure = new DocumentSourceError('incomplete'); return }
    const needed = format === 'docx' ? /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/.test(file.name)
      : /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(file.name)
    if (!needed) return
    if (file.originalSize !== undefined && file.originalSize > limits.entryBytes) { failure = new DocumentSourceError('too_large'); return }
    const chunks: Uint8Array[] = []
    let size = 0
    out[file.name] = new Uint8Array()
    file.ondata = (error, chunk, final) => {
      if (failure) return
      size += chunk?.length ?? 0
      total += chunk?.length ?? 0
      if (error || size > limits.entryBytes || total > limits.totalBytes) {
        failure = new DocumentSourceError(error ? 'unreadable' : 'too_large'); file.terminate(); return
      }
      if (chunk) chunks.push(chunk)
      if (final) {
        if (file.originalSize !== undefined && file.originalSize !== size) { failure = new DocumentSourceError('unreadable'); return }
        const merged = new Uint8Array(size)
        let offset = 0
        for (const part of chunks) { merged.set(part, offset); offset += part.length }
        out[file.name] = merged
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  try {
    for (let offset = 0; offset < bytes.length && !failure; offset += 512) unzip.push(bytes.subarray(offset, offset + 512), offset + 512 >= bytes.length)
  } catch { throw new DocumentSourceError('unreadable') }
  if (failure) throw failure
  if (!out[format === 'docx' ? 'word/document.xml' : 'xl/workbook.xml']?.length || Object.values(out).some((v) => !v.length)) throw new DocumentSourceError('unreadable')
  return out
}
