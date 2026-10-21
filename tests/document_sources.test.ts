import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { periodXlsx, sourceDocx, sourceXlsx } from './fixtures/document-source-fixtures'
import { parseDocumentSourceBytes, preflightDocumentPdf } from '../src/lib/documentSourceParser'
import { PDFDocument, PDFName } from 'pdf-lib'
import { extractDocumentSources, type SourceExtractionDeps } from '../src/lib/documentSourceClient'
import { copySourceText, DocumentSourceError, fragmentsOf, sourceMode, validateSourceSnapshot, verifiedSourceExcerpts, type DocumentSourceSnapshot } from '../src/lib/documentSources'
import { buildSourceMarginReport } from '../src/lib/documentSourceReport'
import { DocumentPeriodSchema, isCalendarDate, sourceCellDate } from '../src/lib/documentPeriod'
import { filterSourcePeriod } from '../src/lib/documentPeriodFilter'
import { buildDocumentModel } from '../agent-hub/documents/document-models'
import { clearDocumentJobsStorage, discardSourceDocumentDraft, hasDocumentRecoveryIssue, listRecentDocumentJobs, prepareDocumentSubmission, prepareSourceDocument, recallDocumentJob, regenerateSourceDocument, rememberDocumentJob, updateSourceDocumentOptions } from '../src/lib/documentJobs'

const raw = 'Первый источник. Выручка 120, себестоимость 50. O‘zbekcha: aniq matn.'
const makeSnapshot = (data = parseDocumentSourceBytes('text', strToU8(raw))): DocumentSourceSnapshot => validateSourceSnapshot({ version: 1, extractorVersion: 'text-sources-1', owner: 'owner', submissionId: 'request', sources: [{ id: 'S1', name: 'source.txt', size: 80, sha256: 'a'.repeat(64), data }] }, 'owner', 'request')
const scope = () => ({ signal: new AbortController().signal, alive: () => true })
const deps: SourceExtractionDeps = { read: (file) => file.arrayBuffer(), hash: async (bytes) => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex'), parse: async (format, bytes) => { if (format === 'pdf') throw new Error('PDF tested in browser'); return parseDocumentSourceBytes(format, new Uint8Array(bytes)) } }
let storage: Map<string, string>
beforeEach(() => {
  storage = new Map()
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k), get length() { return storage.size }, key: (i: number) => [...storage.keys()][i] ?? null })
  clearDocumentJobsStorage()
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('calendar period selection and recovery', () => {
  const period = { from: '2026-07-01', to: '2026-07-31' }
  const snapshot = () => makeSnapshot(parseDocumentSourceBytes('xlsx', periodXlsx()))
  test('calendar parsing rejects rollovers, ambiguous formats and timestamps', () => {
    for (const value of ['2026-02-29', '1900-02-29', '2026-04-31', '2026-00-10', '2026-13-01', '07/01/2026', '2026-07-01T00:00:00Z']) expect(isCalendarDate(value)).toBe(false)
    expect(isCalendarDate('2000-02-29')).toBe(true)
    expect(sourceCellDate({ value: '29.02.2024', kind: 'inline' })).toBe('2024-02-29')
    expect(sourceCellDate({ value: '31.02.2024', kind: 'string' })).toBeNull()
    expect(DocumentPeriodSchema.safeParse({ from: period.to, to: period.from }).success).toBe(false)
    expect(DocumentPeriodSchema.safeParse({ from: '2026-02-30', to: period.to }).success).toBe(false)
  })
  test('Excel epochs, fictitious leap day and fractional boundaries are exact', () => {
    const numeric = (value: string, system?: '1900' | '1904') => sourceCellDate({ value, kind: 'number' }, system)
    expect(numeric('59', '1900')).toBe('1900-02-28')
    expect(numeric('60', '1900')).toBeNull()
    expect(numeric('61', '1900')).toBe('1900-03-01')
    expect(numeric('0', '1904')).toBe('1904-01-01')
    expect(numeric('1462', '1900')).toBe(numeric('0', '1904'))
    expect(numeric('61.9999999999999999999999999', '1900')).toBe('1900-03-01')
    for (const value of ['0', '-1', '60.5', '1e6', 'NaN', '999999999999']) expect(numeric(value, '1900')).toBeNull()
    expect(numeric('61')).toBeNull()
    expect(sourceCellDate({ value: '61', kind: 'inline' }, '1900')).toBeNull()
    expect(sourceCellDate({ value: '61', kind: 'formula-cached' }, '1900')).toBeNull()
    expect(sourceCellDate({ value: '61', kind: 'formula-cached', cachedType: 'text' }, '1900')).toBeNull()
    expect(sourceCellDate({ value: '61', kind: 'formula-cached', cachedType: 'number' }, '1900')).toBe('1900-03-01')
  })
  test('parser retains explicit and default date systems and rejects malformed booleans', () => {
    for (const [flag, system] of [[undefined, '1900'], ['0', '1900'], ['false', '1900'], ['1', '1904'], ['true', '1904']] as const) expect(parseDocumentSourceBytes('xlsx', periodXlsx({ date1904: flag }))).toMatchObject({ dateSystem: system })
    for (const flag of ['', 'yes', 'TRUE', '2']) expect(() => parseDocumentSourceBytes('xlsx', periodXlsx({ date1904: flag }))).toThrow()
  })
  test('inclusive month handles both sheets, returns, summary rows and outside-period currency/overflow', () => {
    const original = snapshot()
    const before = JSON.stringify(original)
    const result = buildSourceMarginReport(original, 'Маржа за июль', { language: 'ru', period })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reports[0].totals).toMatchObject({ rowsTotal: 3, revenueCents: 40000, marginCentsComplete: 29000, returnsCount: 1 })
    expect(result.reports[0].rows.map((r) => [r.sheet, r.rowIndex])).toEqual([['Продажи', 6], ['Продажи', 7], ['Возвраты', 5]])
    expect(result.periodAudit[0].rows.filter((r) => r.decision === 'outside_period').map((r) => r.row)).toEqual([5, 8])
    expect(result.periodAudit[0].rows.find((r) => r.row === 7)).toMatchObject({ column: 'F', raw: '31.07.2026', date: '2026-07-31', decision: 'included' })
    expect(result.reports[0].excludedSummaryRows).toEqual([{ sheet: 'Продажи', rowIndex: 9, name: 'Итого' }])
    expect(result.text).toContain('290.00 USD')
    expect(result.text).toContain('2026-07-01 — 2026-07-31')
    expect(result.text).toContain('9999999999999999999999') // full original source appendix
    expect(result.text).not.toContain('Фильтр дат не применялся')
    expect(JSON.stringify(original)).toBe(before)
  })
  test('header at tenth original record and preamble remain intact after selection', () => {
    const original = snapshot()
    const data = original.sources[0].data
    if (data.format !== 'xlsx') throw new Error('fixture')
    data.sheets = [data.sheets[0]]
    const sheet = data.sheets[0]
    sheet.rows = [...Array.from({ length: 9 }, (_, i) => ({ rowIndex: i + 1, cells: { A: { value: `Note ${i}`, kind: 'inline' as const } } })), ...sheet.rows.slice(1).map((r) => ({ ...r, rowIndex: r.rowIndex + 6 }))]
    const result = buildSourceMarginReport(original, '', { language: 'en', period })
    expect(result.ok).toBe(true)
    if (result.ok) { expect(result.reports[0].mapping[0].headerRowIndex).toBe(10); expect(result.reports[0].rows.map((r) => r.rowIndex)).toEqual([12, 13]) }
  })
  test('invalid dates including a cost gap and an outside row stop the entire batch', () => {
    const original = snapshot()
    if (original.sources[0].data.format !== 'xlsx') throw new Error('fixture')
    const row = original.sources[0].data.sheets[0].rows.find((r) => r.rowIndex === 5)!
    row.cells.F.value = '31.02.2026'
    row.cells.D.value = ''
    const result = buildSourceMarginReport(original, '', { language: 'ru', period })
    expect(result).toMatchObject({ ok: false, reason: 'needs_source_dates', issues: [{ sourceId: 'S1', sheet: 'Продажи', row: 5, reason: 'invalid_date' }] })
  })
  test('missing or ambiguous date columns never select a preferred column silently', () => {
    for (const ambiguous of [false, true]) {
      const original = snapshot()
      if (original.sources[0].data.format !== 'xlsx') throw new Error('fixture')
      const header = original.sources[0].data.sheets[0].rows[1]
      if (ambiguous) header.cells.G = { value: 'Дата оплаты', kind: 'inline' }
      else delete header.cells.F
      expect(buildSourceMarginReport(original, '', { language: 'uz', period })).toMatchObject({ ok: false, reason: 'needs_source_dates', issues: [{ sheet: 'Продажи', reason: ambiguous ? 'ambiguous_date_column' : 'missing_date_column' }] })
    }
  })
  test('old snapshots remain readable; unknown numeric epoch is refused; empty selection is not zero profit', () => {
    const original = snapshot()
    if (original.sources[0].data.format !== 'xlsx') throw new Error('fixture')
    delete original.sources[0].data.dateSystem
    expect(validateSourceSnapshot(original, 'owner', 'request')).toEqual(original)
    const row = original.sources[0].data.sheets[0].rows[2]
    row.cells.F = { value: '46204', kind: 'number' }
    expect(buildSourceMarginReport(original, '', { language: 'ru', period })).toMatchObject({ ok: false, reason: 'needs_source_dates' })
    expect(buildSourceMarginReport(snapshot(), '', { language: 'ru', period: { from: '2025-01-01', to: '2025-01-31' } })).toEqual({ ok: false, reason: 'no_rows_period' })
  })
  test('a file outside the period remains in the audit and source appendix alongside a selected file', () => {
    const original = snapshot()
    const second = structuredClone(original.sources[0])
    second.id = 'S2'; second.sha256 = 'b'.repeat(64)
    if (second.data.format !== 'xlsx') throw new Error('fixture')
    for (const sheet of second.data.sheets) for (const row of sheet.rows) if (row.rowIndex > 4 && row.cells.F?.value) row.cells.F.value = '2025-01-01'
    original.sources.push(second)
    const result = buildSourceMarginReport(original, '', { language: 'ru', period })
    expect(result.ok).toBe(true)
    if (result.ok) { expect(result.reports).toHaveLength(1); expect(result.periodAudit).toHaveLength(2); expect(result.text).toContain(second.sha256) }
  })
  test('confirmed period survives module reload, exact submission and regeneration; invalid options cannot replace it', async () => {
    prepareSourceDocument('owner', { submissionId: 'request', kind: 'typst_document', title: 'Маржа', brief: 'Маржа за июль' }, snapshot(), { language: 'ru' })
    updateSourceDocumentOptions('owner', 'request', { language: 'ru', period })
    for (const bad of [{ from: '2026-02-31', to: period.to }, { from: period.to, to: period.from }]) expect(() => updateSourceDocumentOptions('owner', 'request', { language: 'ru', period: bad })).toThrow()
    expect(() => updateSourceDocumentOptions('owner', 'request', { language: 'ru', period, wholeWorkbook: true })).toThrow()
    vi.resetModules()
    const fresh = await import('../src/lib/documentJobs')
    const saved = fresh.recallDocumentJob('owner', 'request')!
    expect(saved.sourceOptions?.period).toEqual(period)
    expect(fresh.recallDocumentJob('other', 'request')).toBeNull()
    const report = buildSourceMarginReport(saved.source!, saved.brief, saved.sourceOptions!)
    if (!report.ok) throw new Error(report.reason)
    const model = buildDocumentModel('typst_document', report.title, report.text)
    if (!model.ok) throw new Error(model.reason)
    const ready = fresh.prepareDocumentSubmission('owner', { submissionId: 'request', kind: 'typst_document', title: 'Маржа', brief: saved.brief, input: model.input as unknown as Record<string, unknown> })
    expect(ready.sourceOptions?.period).toEqual(period)
    fresh.rememberDocumentJob('owner', { ...ready, state: 'accepted', jobId: '11111111-1111-4111-8111-111111111111', terminal: true })
    expect(fresh.regenerateSourceDocument('owner', 'request').sourceOptions?.period).toEqual(period)
    expect(filterSourcePeriod(saved.source!.sources[0], period).included).toBe(3)
  })
})

describe('complete source extraction', () => {
  test('preserves UTF-8 text and refuses oversize/invalid decoding instead of slicing', () => {
    expect(parseDocumentSourceBytes('text', strToU8(raw))).toEqual({ format: 'text', fragments: [{ locator: 'text:1', text: raw }] })
    expect(() => parseDocumentSourceBytes('text', new Uint8Array([0xff]))).toThrow()
    expect(() => parseDocumentSourceBytes('text', strToU8('a'.repeat(82000)))) .toThrow()
  })
  test('DOCX includes table cells and separate header locations', () => {
    const data = parseDocumentSourceBytes('docx', sourceDocx())
    const text = copySourceText(makeSnapshot(data))
    expect(text).toContain('Таблица: сохранённая ячейка')
    expect(text).toContain('word/header1.xml:p:1')
    expect(text).toContain('Важный колонтитул')
  })
  test('DOCX rejects images, truncated ZIPs and malformed XML', () => {
    expect(() => parseDocumentSourceBytes('docx', sourceDocx(raw, { 'word/media/image1.png': new Uint8Array([1]) }))).toThrow()
    expect(() => parseDocumentSourceBytes('docx', sourceDocx().slice(0, 80))).toThrow()
    expect(() => parseDocumentSourceBytes('docx', zipSync({ 'word/document.xml': strToU8('<unclosed>') }))).toThrow()
  })
  test('tracked DOCX moves are refused instead of duplicating facts', () => {
    const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:moveFrom><w:r><w:t>Revenue 990</w:t></w:r></w:moveFrom><w:moveTo><w:r><w:t>Revenue 990</w:t></w:r></w:moveTo></w:p></w:body></w:document>'
    expect(() => parseDocumentSourceBytes('docx', zipSync({ 'word/document.xml': strToU8(xml) }))).toThrow()
  })
  test('bounded PDF preflight accepts classic text and refuses object streams and inline images before PDF.js', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage()
    page.drawText('Complete source content in a real text-only PDF.')
    const textBytes = await doc.save({ useObjectStreams: false })
    expect(() => preflightDocumentPdf(textBytes)).not.toThrow()
    const compressedObjects = await doc.save()
    expect(() => preflightDocumentPdf(compressedObjects)).toThrow()
    for (const delimiter of [' ', '\x00', '{', '}']) {
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(`${delimiter}BI${delimiter}/W 1 /H 1 /BPC 8 /CS /G ID a EI`)))
      const bytes = await doc.save({ useObjectStreams: false })
      expect(() => preflightDocumentPdf(bytes)).toThrow()
    }
    page.node.set(PDFName.of('Contents'), doc.context.obj([doc.context.register(doc.context.flateStream(' B')), doc.context.register(doc.context.flateStream('I /W 1 /H 1 ID a EI'))]))
    const split = await doc.save({ useObjectStreams: false })
    expect(() => preflightDocumentPdf(split)).toThrow()
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream('q Q '.repeat(60000))))
    const operatorFlood = await doc.save({ useObjectStreams: false })
    expect(() => preflightDocumentPdf(operatorFlood)).toThrow()
  })
  test.each([{ prefix: false, singleQuotes: false }, { prefix: true, singleQuotes: true }])('XLSX preserves both sheets with XML variant %j', (options) => {
    const data = parseDocumentSourceBytes('xlsx', sourceXlsx(options))
    expect(data.format).toBe('xlsx')
    expect(fragmentsOf({ data })).toHaveLength(4)
    expect(fragmentsOf({ data })[3]).toMatchObject({ locator: 'sheet:2:row:2' })
    expect(fragmentsOf({ data })[3].text).toContain('Товар Второй')
  })
  test.each([{ formula: true }, { duplicateRef: true }])('rejects incomplete workbook %j', (options) => {
    expect(() => parseDocumentSourceBytes('xlsx', sourceXlsx(options))).toThrow()
  })
  test('same filename/size/mtime with changed bytes has a different hash', async () => {
    const a = new File(['first'], 'same.txt', { lastModified: 42 })
    const b = new File(['other'], 'same.txt', { lastModified: 42 })
    const result = await extractDocumentSources([a, b], 'owner', 'request', scope(), deps)
    expect(result.sources[0].sha256).not.toBe(result.sources[1].sha256)
  })
  test('last-file error rejects the whole batch', async () => {
    const files = [new File([raw], 'one.txt'), new File([raw], 'two.txt'), new File([raw], 'three.txt'), new File([new Uint8Array([0xff])], 'four.txt')]
    await expect(extractDocumentSources(files, 'owner', 'request', scope(), deps)).rejects.toMatchObject({ code: 'unreadable', fileName: 'four.txt' })
  })
  test('serialized batch bound rejects multiple individually valid sources', async () => {
    await expect(extractDocumentSources([new File(['a'.repeat(45000)], '1.txt'), new File(['b'.repeat(45000)], '2.txt')], 'owner', 'request', scope(), deps)).rejects.toMatchObject({ code: 'too_large' })
  })
  test.each(['read', 'hash', 'parse'] as const)('session loss during %s prevents the next phase', async (phase) => {
    const controller = new AbortController()
    let release!: (value: never) => void
    const delayed = new Promise<never>((resolve) => { release = resolve })
    const calls: string[] = []
    const wrapped = Object.fromEntries(Object.entries(deps).map(([name, fn]) => [name, (...args: never[]) => { calls.push(name); return name === phase ? delayed : (fn as (...a: never[]) => unknown)(...args) }])) as unknown as SourceExtractionDeps
    const run = extractDocumentSources([new File([raw], 'source.txt')], 'owner', 'request', { signal: controller.signal, alive: () => true }, wrapped)
    await vi.waitFor(() => expect(calls).toContain(phase))
    controller.abort()
    await expect(run).rejects.toMatchObject({ code: 'cancelled' })
    const previous = [...calls]
    release((phase === 'read' ? strToU8(raw).buffer : phase === 'hash' ? 'a'.repeat(64) : parseDocumentSourceBytes('text', strToU8(raw))) as never)
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toEqual(previous)
  })
  test('a hung read has one hard deadline', async () => {
    await expect(extractDocumentSources([new File([raw], 'source.txt')], 'owner', 'request', scope(), { ...deps, read: () => new Promise(() => {}) }, 15)).rejects.toMatchObject({ code: 'timeout' })
  })
  test('a delayed timer cannot start hash or parsing after the absolute deadline', async () => {
    const hash = vi.fn(deps.hash)
    const file = new File([raw], 'source.txt')
    await expect(extractDocumentSources([file], 'owner', 'request', scope(), { ...deps, hash, read: async () => {
      const until = Date.now() + 30
      while (Date.now() < until) { /* simulate a stalled main thread */ }
      return strToU8(raw).buffer as ArrayBuffer
    } }, 5)).rejects.toMatchObject({ code: 'timeout' })
    expect(hash).not.toHaveBeenCalled()
  })
})

describe('durable source lifecycle', () => {
  const prepare = () => prepareSourceDocument('owner', { submissionId: 'request', kind: 'typst_document', title: 'Исходники', brief: 'Создай PDF' }, makeSnapshot(), { language: 'ru' })
  test('cold reload finds the pre-generation draft, full sources and owner', async () => {
    const original = prepare()
    vi.resetModules()
    const reloaded = await import('../src/lib/documentJobs')
    expect(reloaded.listRecentDocumentJobs('owner')).toEqual([original])
    expect(reloaded.listRecentDocumentJobs('other')).toEqual([])
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 8 * 86400000)
    expect(reloaded.recallDocumentJob('owner', 'request')).toEqual(original)
  })
  test('quota/readback failure prevents a prepared record', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, length: 0, key: () => null })
    expect(prepare).toThrow('STORAGE_UNAVAILABLE')
    expect(recallDocumentJob('owner', 'request')).toBeNull()
  })
  test('v3 owner tampering is retained as recovery error, not a bare-brief retry', () => {
    prepare()
    const key = 'nemo.documentJobs.job.owner.request'
    storage.set(key, storage.get(key)!.replace('\\"owner\\":\\"owner\\"', '\\"owner\\":\\"other\\"'))
    expect(hasDocumentRecoveryIssue('owner')).toBe(true)
    expect(listRecentDocumentJobs('owner')).toEqual([])
    expect(() => recallDocumentJob('owner', 'request')).toThrow('RECOVERY_UNAVAILABLE')
    expect(storage.has(key)).toBe(true)
  })
  test('a stored array request ID cannot be coerced into a valid UUID', () => {
    prepare()
    const key = 'nemo.documentJobs.job.owner.request'
    const entry = JSON.parse(storage.get(key)!)
    const record = JSON.parse(entry.v)
    record.requestId = [record.requestId]
    entry.v = JSON.stringify(record)
    storage.set(key, JSON.stringify(entry))
    expect(hasDocumentRecoveryIssue('owner')).toBe(true)
    expect(() => recallDocumentJob('owner', 'request')).toThrow('RECOVERY_UNAVAILABLE')
  })
  test('snapshot → exact input → accepted → failed → atomic regenerate preserves source and options', () => {
    const draft = prepare()
    updateSourceDocumentOptions('owner', 'request', { language: 'ru', currency: 'USD', wholeWorkbook: true })
    const model = buildDocumentModel('typst_document', 'Исходники', copySourceText(draft.source!))
    if (!model.ok) throw new Error('fixture')
    const pending = prepareDocumentSubmission('owner', { ...draft, input: model.input })
    expect(pending.source).toEqual(draft.source)
    expect(prepareDocumentSubmission('owner', { ...draft, input: model.input })).toEqual(pending)
    rememberDocumentJob('owner', { ...pending, state: 'accepted', jobId: 'aaaaaaaa-1111-4111-8111-111111111111', terminal: true })
    const regenerated = regenerateSourceDocument('owner', 'request')
    expect(regenerated.source).toEqual(draft.source)
    expect(regenerated.sourceOptions?.currency).toBe('USD')
    expect(regenerated.requestId).not.toBe(pending.requestId)
    expect(regenerated.input).toBeUndefined()
  })
  test('discard frees preparing capacity and refuses uncertain submissions', () => {
    const draft = prepare()
    discardSourceDocumentDraft('owner', 'request')
    expect(recallDocumentJob('owner', 'request')).toBeNull()
    prepare()
    const model = buildDocumentModel('typst_document', 'Исходники', copySourceText(draft.source!))
    if (!model.ok) throw new Error('fixture')
    prepareDocumentSubmission('owner', { ...draft, input: model.input })
    expect(() => discardSourceDocumentDraft('owner', 'request')).toThrow('RECOVERY_UNAVAILABLE')
  })
})

describe('source-backed content and calculations', () => {
  test('only literal quote plus existing locator is accepted; extra prose is refused', () => {
    const snapshot = makeSnapshot()
    const quote = { sourceId: 'S1', locator: 'text:1', quote: 'Выручка 120' }
    expect(verifiedSourceExcerpts(snapshot, { quotes: [quote] })).toContain('Выручка 120')
    for (const change of [{ quote: 'Выручка 9000' }, { sourceId: 'S2' }, { locator: 'page:99' }]) expect(() => verifiedSourceExcerpts(snapshot, { quotes: [{ ...quote, ...change }] })).toThrow(DocumentSourceError)
    expect(() => verifiedSourceExcerpts(snapshot, { quotes: [quote], conclusion: 'Profitable' })).toThrow()
    expect(sourceMode('Сделай PDF: в материале есть слово маржа')).toBe('copy')
  })
  test('both sheets calculate by the existing engine with provenance and no LLM', () => {
    const report = buildSourceMarginReport(makeSnapshot(parseDocumentSourceBytes('xlsx', sourceXlsx())), 'Сделай PDF по марже', { language: 'ru' })
    expect(report.ok).toBe(true)
    if (!report.ok) return
    expect(report.reports[0].totals.revenueCents).toBe(40000)
    expect(report.reports[0].totals.marginCentsComplete).toBe(27000)
    expect(report.text).toContain('270.00 USD')
    expect(report.text).toContain('sheet:2:row:2')
  })
  test('missing currency is a clarification, partial costs are explicitly partial', () => {
    expect(buildSourceMarginReport(makeSnapshot(parseDocumentSourceBytes('xlsx', sourceXlsx({ currency: null }))), '', { language: 'ru' })).toEqual({ ok: false, reason: 'needs_currency' })
    const result = buildSourceMarginReport(makeSnapshot(parseDocumentSourceBytes('xlsx', sourceXlsx({ missingCost: true }))), '', { language: 'ru' })
    expect(result.ok && result.text).toContain('ЧАСТИЧНЫЙ РАСЧЁТ')
  })
  test('period requests stop before calculation; explicit whole-file option is labelled honestly', () => {
    const snapshot = makeSnapshot(parseDocumentSourceBytes('xlsx', sourceXlsx()))
    expect(buildSourceMarginReport(snapshot, 'Маржа за июль', { language: 'ru' })).toEqual({ ok: false, reason: 'needs_period' })
    const result = buildSourceMarginReport(snapshot, 'Маржа за июль', { language: 'ru', wholeWorkbook: true })
    expect(result.ok && result.text).toContain('Фильтр дат не применялся')
    for (const brief of ['за прошлый год', 'за последние 30 дней', 'for last year', 'o‘tgan yil']) expect(buildSourceMarginReport(snapshot, brief, { language: 'ru' })).toEqual({ ok: false, reason: 'needs_period' })
  })
})
