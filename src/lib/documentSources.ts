import { DocumentSourceError } from '../../supabase/functions/_shared/documentSourceError'
export { DocumentSourceError, type SourceErrorCode } from '../../supabase/functions/_shared/documentSourceError'
// Durable, bounded TEXT snapshots. Raw bytes are hashed before transfer to a parser worker.
// These are local recovery records, never bearer capabilities or server-side file references.
import { z } from 'zod'
import { serializedPayloadBytes } from '../../agent-hub/documents/document-models'

export const MAX_SOURCE_BYTES = 80 * 1024
export const MAX_SOURCE_FILE_BYTES = 20 * 1024 * 1024
export const MAX_SOURCE_BATCH_BYTES = 40 * 1024 * 1024
export const SOURCE_TIMEOUT_MS = 30_000
const Fragment = z.object({ locator: z.string().min(1).max(300), text: z.string().min(1).max(MAX_SOURCE_BYTES) }).strict()
const Cell = z.object({ value: z.string().max(MAX_SOURCE_BYTES), kind: z.enum(['shared', 'inline', 'string', 'number', 'boolean', 'formula-cached', 'error']), cachedType: z.enum(['number', 'text', 'boolean']).optional() }).strict()
  .refine((cell) => cell.cachedType === undefined || cell.kind === 'formula-cached')
const Sheet = z.object({ name: z.string().min(1).max(300), rows: z.array(z.object({ rowIndex: z.number().int().min(1).max(1048576), cells: z.record(z.string().regex(/^[A-Z]{1,3}$/), Cell) }).strict()).max(2000) }).strict()
const Data = z.discriminatedUnion('format', [
  z.object({ format: z.literal('text'), fragments: z.array(Fragment).min(1).max(2000) }).strict(),
  z.object({ format: z.literal('pdf'), fragments: z.array(Fragment).min(1).max(128) }).strict(),
  z.object({ format: z.literal('docx'), fragments: z.array(Fragment).min(1).max(2000) }).strict(),
  // Optional for compatibility with existing recovery records. Missing does NOT mean 1900.
  z.object({ format: z.literal('xlsx'), dateSystem: z.enum(['1900', '1904']).optional(), sheets: z.array(Sheet).min(1).max(64) }).strict(),
])
export const DocumentSourceSnapshotSchema = z.object({
  version: z.literal(1), extractorVersion: z.literal('text-sources-1'),
  owner: z.string().min(1).max(200), submissionId: z.string().min(1).max(200),
  sources: z.array(z.object({ id: z.string().regex(/^S[1-4]$/), name: z.string().min(1).max(240),
    size: z.number().int().positive().max(MAX_SOURCE_FILE_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/), data: Data,
  }).strict()).min(1).max(4),
}).strict().superRefine((snapshot, ctx) => {
  if (serializedPayloadBytes(snapshot) > MAX_SOURCE_BYTES
    || snapshot.sources.reduce((n, s) => n + s.size, 0) > MAX_SOURCE_BATCH_BYTES) ctx.addIssue({ code: 'custom', message: 'source_size' })
  for (const [index, source] of snapshot.sources.entries()) {
    if (source.id !== `S${index + 1}`) ctx.addIssue({ code: 'custom', message: 'source_order' })
    const fragments = fragmentsOf(source)
    if (new Set(fragments.map((f) => f.locator)).size !== fragments.length) ctx.addIssue({ code: 'custom', message: 'duplicate_locator' })
  }
})
export type DocumentSourceSnapshot = z.infer<typeof DocumentSourceSnapshotSchema>
export type DocumentSource = DocumentSourceSnapshot['sources'][number]
export type SourceData = z.infer<typeof Data>
export function checkSourceScope(scope: { signal: AbortSignal; alive: () => boolean }): void {
  if (scope.signal.aborted || !scope.alive()) throw new DocumentSourceError('cancelled')
}
export function fragmentsOf(source: Pick<DocumentSource, 'data'>): Array<z.infer<typeof Fragment>> {
  if (source.data.format !== 'xlsx') return source.data.fragments
  return source.data.sheets.flatMap((sheet, index) => sheet.rows.map((row) => ({
    locator: `sheet:${index + 1}:row:${row.rowIndex}`,
    text: `${JSON.stringify(sheet.name)} / ${row.rowIndex}: ` + Object.entries(row.cells)
      .sort(([a], [b]) => a.length - b.length || a.localeCompare(b))
      .map(([column, cell]) => `${column}=${JSON.stringify(cell.value)}${cell.kind === 'formula-cached' ? ' [cached]' : ''}`).join(' | '),
  })))
}
export function sourceMode(brief: string): 'copy' | 'excerpts' | 'margin' | 'profit' {
  // Inspect the instruction, not quoted material following a colon/newline.
  const head = brief.split(/[:\n]/, 1)[0]
  if (/марж|рентабельн|margin|profitab|marja|rentabel/i.test(head)) return 'margin'
  if (/прибыл|\bprofit\b|foyda/i.test(head)) return 'profit'
  if (/кратк|выжим|резюм|обобщ|вывод|анализ|summary|summari|extract|qisqa|xulosa|tahlil/i.test(head)) return 'excerpts'
  return 'copy'
}
export function validateSourceSnapshot(value: unknown, owner: string, submissionId: string): DocumentSourceSnapshot {
  const parsed = DocumentSourceSnapshotSchema.safeParse(value)
  if (!parsed.success || parsed.data.owner !== owner || parsed.data.submissionId !== submissionId) throw new DocumentSourceError('incomplete')
  return parsed.data
}
export function sourceReference(source: DocumentSource): string { return `${source.id} · ${source.name}\nSHA-256: ${source.sha256}` }
export function copySourceText(snapshot: DocumentSourceSnapshot): string {
  return snapshot.sources.map((source) => [sourceReference(source), ...fragmentsOf(source).map((f) => `[${source.id}/${f.locator}]\n${f.text}`)].join('\n\n')).join('\n\n')
}

// The model can SELECT quotations; it cannot supply prose, computed values or new citations.
// A substring match proves quotation fidelity only, not relevance or an abstractive summary.
export function verifiedSourceExcerpts(snapshot: DocumentSourceSnapshot, value: unknown): string {
  const selected = z.object({ quotes: z.array(z.object({ sourceId: z.string(), locator: z.string(), quote: z.string().min(1).max(12000) }).strict()).min(1).max(40) }).strict().safeParse(value)
  if (!selected.success) throw new DocumentSourceError('invalid_selection')
  const seen = new Set<string>()
  return selected.data.quotes.map((item) => {
    const source = snapshot.sources.find((s) => s.id === item.sourceId)
    const fragment = source && fragmentsOf(source).find((f) => f.locator === item.locator)
    const key = JSON.stringify(item)
    if (!source || !fragment || !item.quote.trim() || !fragment.text.includes(item.quote) || seen.has(key)) throw new DocumentSourceError('invalid_selection')
    seen.add(key)
    return `${sourceReference(source)}\n[${source.id}/${item.locator}]\n${item.quote}`
  }).join('\n\n')
}
