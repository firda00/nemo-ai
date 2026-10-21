// Streaming, namespace-aware XLSX text values. Shared by chat and scheduled reports.
// No DOM tree, formula execution, relationships fetch, or truncation on a limit.
import { SaxesParser, type SaxesTagNS } from 'saxes'
import { boundedOfficeParts } from './officeSourceZip.ts'
import { DocumentSourceError } from './documentSourceError.ts'
import type { XlsxCell, XlsxSheet } from './xlsxIngest.ts'

export interface XlsxSourceLimits {
  entryBytes: number; totalBytes: number; rows: number; rowsPerSheet: number
  sharedStrings: number; textBytes: number; cells: number; xmlElements: number
}
export const CHAT_XLSX_LIMITS: XlsxSourceLimits = { entryBytes: 8 * 1024 * 1024, totalBytes: 16 * 1024 * 1024, rows: 2000, rowsPerSheet: 2000, sharedStrings: 20000, textBytes: 80 * 1024, cells: 32000, xmlElements: 100000 }
export const MONTHLY_XLSX_LIMITS: XlsxSourceLimits = { entryBytes: 20 * 1024 * 1024, totalBytes: 40 * 1024 * 1024, rows: 60000, rowsPerSheet: 20000, sharedStrings: 200000, textBytes: 16 * 1024 * 1024, cells: 400000, xmlElements: 2000000 }
export interface XlsxSourceData { format: 'xlsx'; dateSystem: '1900' | '1904'; sheets: XlsxSheet[] }
const NS = ['http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main']
const REL_NS = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships']
const PACKAGE_NS = ['http://schemas.openxmlformats.org/package/2006/relationships', 'http://purl.oclc.org/ooxml/package/relationships']
const VALUE_CHILDREN: Record<string, readonly string[]> = {
  c: ['f', 'v', 'is'], is: ['t', 'r', 'phoneticPr'], si: ['t', 'r', 'phoneticPr'],
  r: ['rPr', 't'], sst: ['si'],
  rPr: ['rFont', 'charset', 'family', 'b', 'i', 'strike', 'outline', 'shadow', 'condense', 'extend', 'color', 'sz', 'u', 'vertAlign', 'scheme'],
}
const fail = (code: 'incomplete' | 'too_large' | 'unreadable' = 'incomplete'): never => { throw new DocumentSourceError(code) }
const attr = (tag: SaxesTagNS, name: string): string | undefined => Object.values(tag.attributes).find((a) => a.local === name && a.uri === '')?.value
const positive = (s: string | undefined, max: number): number => { if (!s || !/^[1-9]\d*$/.test(s) || Number(s) > max) fail(); return Number(s) }

function xml(bytes: Uint8Array | undefined, root: string, namespaces: string[], limits: XlsxSourceLimits, handlers: {
  open?: (tag: SaxesTagNS, path: string) => void
  text?: (value: string, path: string) => void
  close?: (tag: SaxesTagNS, path: string) => void
}): void {
  if (!bytes?.length) fail()
  const parser = new SaxesParser({ xmlns: true })
  const path: string[] = []
  const children: Array<Map<string, number>> = []
  let namespace = ''
  let elements = 0
  parser.on('error', () => fail('unreadable'))
  parser.on('doctype', () => fail('unreadable'))
  parser.on('opentag', (tag) => {
    if (!path.length) { if (tag.local !== root || !namespaces.includes(tag.uri)) fail(); namespace = tag.uri }
    if (tag.uri !== namespace) fail()
    if (['AlternateContent', 'drawing', 'legacyDrawing', 'oleObjects', 'hyperlinks', 'rPh', 'extLst'].includes(tag.local)) fail()
    const parent = path.at(-1)
    // Values and formatting properties are leaves: hidden children cannot be discarded.
    if (parent && (['v', 't', 'f', 'phoneticPr'].includes(parent) || path.at(-2) === 'rPr')) fail()
    if (parent && VALUE_CHILDREN[parent]) {
      if (!VALUE_CHILDREN[parent].includes(tag.local)) fail()
      const counts = children.at(-1)!
      const count = (counts.get(tag.local) ?? 0) + 1
      counts.set(tag.local, count)
      if (tag.local !== 'r' && tag.local !== 'si' && count > 1) fail()
      if (['is', 'si'].includes(parent) && counts.has('t') && counts.has('r')) fail()
    }
    if (tag.local === 't' && !['is', 'si', 'r'].includes(parent ?? '')) fail()
    if (tag.local === 'r' && !['is', 'si'].includes(parent ?? '')) fail()
    if (tag.local === 'rPr' && parent !== 'r') fail()
    path.push(tag.local)
    children.push(new Map())
    if (++elements > limits.xmlElements || path.length > 64) fail('too_large')
    handlers.open?.(tag, path.join('/'))
  })
  const text = (value: string) => {
    if ((['c', 'is', 'si', 'r', 'rPr', 'phoneticPr', 'sst', 'row', 'sheetData'].includes(path.at(-1) ?? '') || path.at(-2) === 'rPr') && value.trim()) fail()
    handlers.text?.(value, path.join('/'))
  }
  parser.on('text', text); parser.on('cdata', text)
  parser.on('closetag', (tag) => {
    if (tag.local === 'r' && children.at(-1)?.get('t') !== 1) fail()
    handlers.close?.(tag, path.join('/')); path.pop(); children.pop()
  })
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    for (let i = 0; i < bytes!.length; i += 4096) parser.write(decoder.decode(bytes!.subarray(i, i + 4096), { stream: true }))
    parser.write(decoder.decode()).close()
  } catch (error) { if (error instanceof DocumentSourceError) throw error; fail('unreadable') }
}

export function parseSourceXlsx(bytes: Uint8Array, limits = CHAT_XLSX_LIMITS): XlsxSourceData {
  if (bytes.byteLength > 20 * 1024 * 1024) fail('too_large')
  const parts = boundedOfficeParts(bytes, 'xlsx', limits)
  let dateSystem: '1900' | '1904' = '1900'
  let propertySeen = false
  let sheetsSeen = false
  const declared: Array<{ name: string; rel: string }> = []
  xml(parts['xl/workbook.xml'], 'workbook', NS, limits, { open(tag, path) {
    if (tag.local === 'workbookPr') {
      if (path !== 'workbook/workbookPr' || propertySeen) fail()
      propertySeen = true
      const flag = attr(tag, 'date1904')
      if (flag !== undefined && !['0', '1', 'false', 'true'].includes(flag)) fail()
      dateSystem = flag === '1' || flag === 'true' ? '1904' : '1900'
    }
    if (tag.local === 'sheets') { if (path !== 'workbook/sheets' || sheetsSeen) fail(); sheetsSeen = true }
    if (tag.local === 'sheet') {
      if (path !== 'workbook/sheets/sheet' || declared.length >= 64) fail()
      const name = attr(tag, 'name')
      const rels = Object.values(tag.attributes).filter((a) => a.local === 'id' && REL_NS.includes(a.uri))
      if (!name || name.length > 300 || rels.length !== 1 || declared.some((s) => s.name === name || s.rel === rels[0].value)) fail()
      declared.push({ name: name!, rel: rels[0].value })
    }
  } })
  if (!declared.length) fail()
  const targets = new Map<string, string>()
  xml(parts['xl/_rels/workbook.xml.rels'], 'Relationships', PACKAGE_NS, limits, { open(tag, path) {
    if (tag.local !== 'Relationship') return
    if (path !== 'Relationships/Relationship') fail()
    const id = attr(tag, 'Id'), target = attr(tag, 'Target')
    if (!id || targets.has(id) || !target || target.includes('..') || target.includes('\\') || attr(tag, 'TargetMode') === 'External') fail()
    targets.set(id!, target!.startsWith('/') ? target!.slice(1) : `xl/${target}`)
  } })
  const shared: string[] = []
  let sharedValue = '', sharedBytes = 0
  if (parts['xl/sharedStrings.xml']) xml(parts['xl/sharedStrings.xml'], 'sst', NS, limits, {
    open(tag, path) { if (tag.local === 'si') { if (path !== 'sst/si' || shared.length >= limits.sharedStrings) fail('too_large'); sharedValue = '' } },
    text(value, path) { if (path === 'sst/si/t' || path === 'sst/si/r/t') { sharedBytes += new TextEncoder().encode(value).length; if (sharedBytes > limits.textBytes) fail('too_large'); sharedValue += value } },
    close(tag, path) { if (tag.local === 'si' && path === 'sst/si') shared.push(sharedValue) },
  })
  const sheets: XlsxSheet[] = []
  const usedTargets = new Set<string>()
  let totalRows = 0, totalCells = 0, textBytes = 0
  for (const declaration of declared) {
    const target = targets.get(declaration.rel)
    if (!target || usedTargets.has(target) || !/^xl\/worksheets\/[^/]+\.xml$/.test(target)) fail()
    usedTargets.add(target!)
    const sheet: XlsxSheet = { name: declaration.name, rows: [] }
    const rowIds = new Set<number>()
    let row: XlsxSheet['rows'][number] | null = null
    let cell: { column: string; type: string; value: string; inline: string; values: number; inlineCount: number; formula: boolean } | null = null
    let dataSeen = false
    const refs = new Set<string>()
    xml(parts[target!], 'worksheet', NS, limits, {
      open(tag, path) {
        if (tag.local === 'sheetData') { if (path !== 'worksheet/sheetData' || dataSeen) fail(); dataSeen = true }
        if (tag.local === 'row') {
          if (path !== 'worksheet/sheetData/row' || row) fail()
          const index = positive(attr(tag, 'r'), 1048576)
          if (rowIds.has(index)) fail()
          rowIds.add(index); refs.clear()
          if (++totalRows > limits.rows || rowIds.size > limits.rowsPerSheet) fail('too_large')
          row = { rowIndex: index, cells: {} }
        }
        if (tag.local === 'c') {
          if (path !== 'worksheet/sheetData/row/c' || !row || cell) fail()
          const ref = /^([A-Z]{1,3})([1-9]\d*)$/.exec(attr(tag, 'r') ?? '')
          if (!ref || Number(ref[2]) !== row!.rowIndex || refs.has(ref[1]) || [...ref[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) > 16384) fail()
          refs.add(ref![1])
          if (++totalCells > limits.cells) fail('too_large')
          cell = { column: ref![1], type: attr(tag, 't') || 'n', value: '', inline: '', values: 0, inlineCount: 0, formula: false }
        }
        if (tag.local === 'v') { if (!cell || path !== 'worksheet/sheetData/row/c/v' || ++cell.values > 1) fail() }
        if (tag.local === 'f') { if (!cell || path !== 'worksheet/sheetData/row/c/f' || cell.formula) fail(); cell!.formula = true }
        if (tag.local === 'is') { if (!cell || path !== 'worksheet/sheetData/row/c/is' || ++cell.inlineCount > 1) fail() }
      },
      text(value, path) {
        if (!cell) return
        if (path === 'worksheet/sheetData/row/c/v') cell.value += value
        else if (path === 'worksheet/sheetData/row/c/is/t' || path === 'worksheet/sheetData/row/c/is/r/t') cell.inline += value
        if (cell.value.length + cell.inline.length > limits.textBytes) fail('too_large')
      },
      close(tag) {
        if (tag.local === 'c') {
          if (!row || !cell) fail()
          const current = cell!
          let value = current.value
          let kind: XlsxCell['kind']
          if (current.type === 'e' || (current.formula && !current.values)) fail()
          if (current.type !== 'inlineStr' && current.inlineCount) fail()
          if (current.type === 's') { if (!/^\d+$/.test(value) || shared[Number(value)] === undefined) fail(); value = shared[Number(value)]; kind = 'shared' }
          else if (current.type === 'inlineStr') { if (current.values || current.formula) fail(); value = current.inline; kind = 'inline' }
          else if (current.type === 'b') { if (!['0', '1'].includes(value)) fail(); value = value === '1' ? 'TRUE' : 'FALSE'; kind = 'boolean' }
          else if (['n', 'str', 'd'].includes(current.type)) kind = current.type === 'n' ? 'number' : 'string'
          else fail()
          textBytes += new TextEncoder().encode(value).length
          if (textBytes > limits.textBytes) fail('too_large')
          if (value || current.formula) row!.cells[current.column] = { value, kind: current.formula ? 'formula-cached' : kind!, ...(current.formula ? { cachedType: kind! === 'number' ? 'number' as const : kind! === 'boolean' ? 'boolean' as const : 'text' as const } : {}) }
          cell = null
        }
        if (tag.local === 'row') { if (!row) fail(); if (Object.keys(row!.cells).length) sheet.rows.push(row!); row = null }
      },
    })
    if (!dataSeen) fail()
    sheets.push(sheet)
  }
  if (!sheets.some((s) => s.rows.length)) fail('unreadable')
  return { format: 'xlsx', dateSystem, sheets }
}
