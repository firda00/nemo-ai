// Bounded raw-XLSX ingestion for the product-margin report. Pure and offline-testable.
//
// Safety contract (finance-stage review conditions):
//   • decompression is bounded BEFORE allocation: the unzip filter sees each entry's declared
//     expanded size and the running totals, and aborts the archive without inflating anything
//     further once a cap is crossed — this is the bomb guard repairXlsxDimensions lacks;
//   • only the parts a margin report needs are ever inflated (workbook, rels, sharedStrings,
//     worksheets); every other entry is skipped unread;
//   • ALL sheets are preserved with per-row provenance (sheet name + 1-based row index);
//   • row limits REJECT the workbook instead of silently truncating — a margin total over a
//     partial file is a lie, so there is no partial-parse mode here;
//   • formulas are NEVER executed and external links never followed: a formula cell WITH a
//     cached value contributes that cached value (marked as such); a formula cell WITHOUT one
//     is rejected into the issues list, never guessed.
import { strFromU8, Unzip, UnzipInflate } from 'fflate'

export interface XlsxCell {
  value: string
  kind: 'shared' | 'inline' | 'string' | 'number' | 'boolean' | 'formula-cached' | 'error'
  cachedType?: 'number' | 'text' | 'boolean'
}
export interface XlsxRow { rowIndex: number; cells: Record<string, XlsxCell> }
export interface XlsxSheet { name: string; rows: XlsxRow[] }
export interface XlsxParseIssue { code: string; sheet?: string; rowIndex?: number; cellRef?: string }
export type XlsxParseResult =
  | { ok: true; sheets: XlsxSheet[]; issues: XlsxParseIssue[]; sharedStringCount: number }
  | {
    ok: false
    reason: 'bad_archive' | 'archive_too_large' | 'entry_too_large' | 'too_many_entries'
      | 'not_xlsx' | 'sheet_rows_over_limit' | 'workbook_rows_over_limit' | 'too_many_shared_strings'
      | 'parse_timeout' | 'worker_failed'
    detail?: string
  }

const MAX_ENTRIES = 200
const MAX_TOTAL_EXPANDED_BYTES = 40 * 1024 * 1024
const MAX_ENTRY_EXPANDED_BYTES = 20 * 1024 * 1024
const MAX_ROWS_PER_SHEET = 20_000
const MAX_ROWS_TOTAL = 60_000
const MAX_SHARED_STRINGS = 200_000

const WORKSHEET_RE = /^xl\/worksheets\/sheet\d+\.xml$/
const NEEDED = (name: string) =>
  name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels'
  || name === 'xl/sharedStrings.xml' || WORKSHEET_RE.test(name)

type GuardReason = 'archive_too_large' | 'entry_too_large' | 'too_many_entries' | 'bad_archive'
class XlsxGuardError extends Error {
  readonly reason: GuardReason
  constructor(reason: GuardReason) {
    super(reason)
    this.reason = reason
  }
}

// invalid numeric references must decode to nothing, never throw out of the parser
function safeCodePoint(code: number): string {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
    ? String.fromCodePoint(code)
    : ''
}

export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, dec: string) => safeCodePoint(Number(dec)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // control chars are invalid in XML 1.0 — strip instead of emitting a broken document
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point here
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

function parseSharedStrings(xml: string): string[] | null {
  const strings: string[] = []
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    if (strings.length >= MAX_SHARED_STRINGS) return null
    let text = ''
    for (const t of si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += decodeXmlEntities(t[1])
    strings.push(text)
  }
  return strings
}

function parseWorkbookSheets(workbookXml: string, relsXml: string | null): Array<{ name: string; target: string }> {
  const relTargets = new Map<string, string>()
  if (relsXml) {
    for (const rel of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = /\bId="([^"]+)"/.exec(rel[0])?.[1]
      const target = /\bTarget="([^"]+)"/.exec(rel[0])?.[1]
      if (id && target) relTargets.set(id, target.replace(/^\/?(?:xl\/)?/, 'xl/').replace(/^xl\/xl\//, 'xl/'))
    }
  }
  const sheets: Array<{ name: string; target: string }> = []
  for (const sheet of workbookXml.matchAll(/<sheet\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(sheet[0])?.[1]
    const relId = /\br:id="([^"]+)"/.exec(sheet[0])?.[1]
    if (name === undefined) continue
    const target = (relId && relTargets.get(relId)) || ''
    sheets.push({ name: decodeXmlEntities(name), target })
  }
  return sheets
}

/**
 * Streamed, capped unzip. Honest metadata semantics:
 *   • caps are enforced on the ACTUAL inflated bytes as they stream out — no size field is
 *     trusted for allocation, and the compressed input is fed in small slices so a synchronous
 *     inflate can never emit one giant chunk past the guards;
 *   • the streaming reader takes sizes from LOCAL file headers (the central directory is never
 *     consulted, so lies there cannot influence anything); a LOCAL header whose declared size
 *     disagrees with the actual output rejects the archive as corrupt;
 *   • the decoder is terminated the moment any cap trips — nothing keeps inflating.
 */
const PUSH_CHUNK_BYTES = 64 * 1024

function boundedUnzip(data: Uint8Array): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {}
  let entryCount = 0
  let totalActual = 0
  let failure: XlsxGuardError | null = null
  const unzip = new Unzip((file) => {
    if (failure) return
    entryCount += 1
    if (entryCount > MAX_ENTRIES) { failure = new XlsxGuardError('too_many_entries'); return }
    if (file.originalSize !== undefined && file.originalSize > MAX_ENTRY_EXPANDED_BYTES) {
      failure = new XlsxGuardError('entry_too_large'); return
    }
    if (!NEEDED(file.name)) return // never even started
    const chunks: Uint8Array[] = []
    let actual = 0
    const abort = (reason: ConstructorParameters<typeof XlsxGuardError>[0]) => {
      failure = new XlsxGuardError(reason)
      try { file.terminate() } catch { /* already stopped */ }
    }
    file.ondata = (error, chunk, final) => {
      if (failure) return
      if (error) { abort('bad_archive'); return }
      if (chunk) {
        actual += chunk.length
        totalActual += chunk.length
        if (actual > MAX_ENTRY_EXPANDED_BYTES) { abort('entry_too_large'); return }
        if (totalActual > MAX_TOTAL_EXPANDED_BYTES) { abort('archive_too_large'); return }
        chunks.push(chunk)
      }
      if (final) {
        // local-header integrity: declared ≠ actual is a lie, and lies fail closed
        if (file.originalSize !== undefined && file.originalSize !== actual) { abort('bad_archive'); return }
        const merged = new Uint8Array(actual)
        let offset = 0
        for (const part of chunks) { merged.set(part, offset); offset += part.length }
        files[file.name] = merged
      }
    }
    try { file.start() } catch { failure = new XlsxGuardError('bad_archive') }
  })
  unzip.register(UnzipInflate)
  // bounded compressed feeding: stop pushing the moment anything failed
  for (let offset = 0; offset < data.length && !failure; offset += PUSH_CHUNK_BYTES) {
    const end = Math.min(offset + PUSH_CHUNK_BYTES, data.length)
    unzip.push(data.subarray(offset, end), end === data.length)
  }
  if (failure) throw failure
  return files
}

export function parseXlsxWorkbook(input: ArrayBuffer | Uint8Array): XlsxParseResult {
  let archive: Record<string, Uint8Array>
  try {
    archive = boundedUnzip(input instanceof Uint8Array ? input : new Uint8Array(input))
  } catch (error) {
    if (error instanceof XlsxGuardError) {
      return { ok: false, reason: error.reason === 'bad_archive' ? 'bad_archive' : error.reason }
    }
    return { ok: false, reason: 'bad_archive' }
  }

  const workbookXml = archive['xl/workbook.xml'] ? strFromU8(archive['xl/workbook.xml']) : null
  if (!workbookXml) return { ok: false, reason: 'not_xlsx' }
  const relsXml = archive['xl/_rels/workbook.xml.rels'] ? strFromU8(archive['xl/_rels/workbook.xml.rels']) : null
  const sharedRaw = archive['xl/sharedStrings.xml'] ? strFromU8(archive['xl/sharedStrings.xml']) : ''
  const shared = sharedRaw ? parseSharedStrings(sharedRaw) : []
  if (shared === null) return { ok: false, reason: 'too_many_shared_strings' }

  const declared = parseWorkbookSheets(workbookXml, relsXml)
  const worksheetNames = Object.keys(archive).filter((name) => WORKSHEET_RE.test(name)).sort(
    (a, b) => Number(/sheet(\d+)/.exec(a)?.[1] ?? 0) - Number(/sheet(\d+)/.exec(b)?.[1] ?? 0),
  )
  // declared relationships are authoritative: a missing target is reported as missing, NEVER
  // silently remapped to another worksheet part — a relabeled sheet corrupts provenance.
  const sheetEntries = declared.length
    ? declared.map((sheet) => ({ name: sheet.name, xmlName: sheet.target && archive[sheet.target] ? sheet.target : '' }))
    : worksheetNames.map((xmlName, index) => ({ name: `Sheet${index + 1}`, xmlName }))
  if (!sheetEntries.length) return { ok: false, reason: 'not_xlsx' }

  const issues: XlsxParseIssue[] = []
  const sheets: XlsxSheet[] = []
  let totalRows = 0
  for (const entry of sheetEntries) {
    const xmlBytes = entry.xmlName ? archive[entry.xmlName] : undefined
    if (!xmlBytes) { issues.push({ code: 'sheet_part_missing', sheet: entry.name }); continue }
    const xml = strFromU8(xmlBytes)
    const rows: XlsxRow[] = []
    for (const rowMatch of xml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= MAX_ROWS_PER_SHEET) return { ok: false, reason: 'sheet_rows_over_limit', detail: entry.name }
      totalRows += 1
      if (totalRows > MAX_ROWS_TOTAL) return { ok: false, reason: 'workbook_rows_over_limit' }
      const rowIndex = Number(rowMatch[1])
      const cells: Record<string, XlsxCell> = {}
      for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cellMatch[1]
        const inner = cellMatch[2] ?? ''
        const ref = /\br="([A-Z]+)(\d+)"/.exec(attrs)
        if (!ref) continue
        const column = ref[1]
        const type = /\bt="([a-zA-Z]+)"/.exec(attrs)?.[1] ?? ''
        const hasFormula = /<f[\s>]/.test(inner)
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]
        // inline rich text concatenates ALL runs, exactly like sharedStrings <si> handling
        let inline: string | undefined
        const inlineBlock = /<is>([\s\S]*?)<\/is>/.exec(inner)?.[1]
        if (inlineBlock !== undefined) {
          inline = ''
          for (const t of inlineBlock.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) inline += t[1]
        }
        if (hasFormula && v === undefined) {
          // a formula with no cached value cannot contribute a number without EXECUTING it
          issues.push({ code: 'formula_without_cached_value', sheet: entry.name, rowIndex, cellRef: `${column}${rowIndex}` })
          continue
        }
        if (type === 'e') {
          issues.push({ code: 'error_cell', sheet: entry.name, rowIndex, cellRef: `${column}${rowIndex}` })
          cells[column] = { value: decodeXmlEntities(v ?? ''), kind: 'error' }
          continue
        }
        if (type === 's') {
          const index = Number(v)
          cells[column] = { value: Number.isInteger(index) && shared[index] !== undefined ? shared[index] : '', kind: 'shared' }
        } else if (type === 'inlineStr') {
          cells[column] = { value: decodeXmlEntities(inline ?? ''), kind: 'inline' }
        } else if (type === 'str') {
          cells[column] = { value: decodeXmlEntities(v ?? ''), kind: hasFormula ? 'formula-cached' : 'string' }
        } else if (type === 'b') {
          cells[column] = { value: v === '1' ? 'TRUE' : 'FALSE', kind: 'boolean' }
        } else if (v !== undefined) {
          cells[column] = { value: decodeXmlEntities(v), kind: hasFormula ? 'formula-cached' : 'number' }
        }
      }
      if (Object.keys(cells).length) rows.push({ rowIndex, cells })
    }
    sheets.push({ name: entry.name, rows })
  }
  return { ok: true, sheets, issues, sharedStringCount: shared.length }
}
