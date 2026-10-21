// Product-margin report exports: CSV, a REAL .xlsx workbook, and a printable HTML document.
// Audit rules: every export carries the meta (file, sha256, generated-at), the FULL header
// mapping, every named completeness reason, per-row provenance, the product rankings, and the
// gaps/issues lists — a downloadable claim must be checkable against its source.
//
//   • cells are TYPED: validated numbers stay numeric (so returns like -100 still sum in
//     Excel/WPS); only untrusted strings get the formula-injection guard (leading = + - @ …);
//   • the XLSX is a genuine OOXML package (three sheets: Margin, Products, Gaps) built with
//     zipSync — openable in Excel/WPS, not a print-only substitute;
//   • nothing here recomputes: exports render the SAME report object the engine produced.
import { zipSync, strToU8 } from 'fflate'
import { escapeXml } from './xlsxIngest.ts'
import { formatCents, type MarginReport } from './productMargin.ts'
import { DocumentSourceError } from './documentSourceError.ts'

type Cell = { t: 'n'; v: number | null } | { t: 's'; v: string }
const n = (value: number | null): Cell => ({ t: 'n', v: value })
const s = (value: string): Cell => ({ t: 's', v: value })
const money = (cents: number | null): Cell => n(cents === null ? null : Number(formatCents(cents)))

const csvCell = (cell: Cell): string => {
  if (cell.t === 'n') return cell.v === null ? '' : String(cell.v)
  let text = cell.v
  // formula-injection guard for UNTRUSTED STRINGS only — validated numerics must keep summing
  if (/^[=+@\t\r]|^-[^0-9.]/.test(text) || text.startsWith('-')) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}
const csvLine = (cells: Cell[]): string => cells.map(csvCell).join(',')

const ROW_HEADER = ['sheet', 'row', 'name', 'qty', 'revenue', 'cost', 'margin', 'margin_%', 'kind', 'issues'].map(s)
const PRODUCT_HEADER = ['product', 'rows', 'rows_complete', 'qty', 'revenue', 'covered_revenue', 'covered_cost', 'covered_margin', 'covered_margin_%', 'complete', 'sources'].map(s)
const MAPPING_HEADER = ['sheet', 'header_row', 'cost_semantics', 'ambiguous_cost_header', 'field', 'column', 'header'].map(s)
const GAP_HEADER = ['kind', 'sheet', 'row', 'name', 'detail'].map(s)

function metaLines(report: MarginReport): Cell[][] {
  return [
    [s(`Product margin report (${report.currency})`)],
    [s('file'), s(report.meta.fileName), s('sha256'), s(report.meta.fileSha256), s('generated_at'), s(report.meta.generatedAt)],
    [s('totals_complete'), s(report.totalsComplete ? 'yes' : 'no'), s('reasons'), s(report.completenessReasons.join('; ') || '—')],
  ]
}

function mappingLines(report: MarginReport): Cell[][] {
  const lines: Cell[][] = [MAPPING_HEADER]
  for (const map of report.mapping) {
    const fields = Object.entries(map.columns)
    if (!fields.length) lines.push([s(map.sheet), n(map.headerRowIndex), s(map.costSemantics), s(map.ambiguousCostHeader?.header ?? ''), s(''), s(''), s('')])
    for (const [field, ref] of fields) {
      lines.push([s(map.sheet), n(map.headerRowIndex), s(map.costSemantics), s(map.ambiguousCostHeader?.header ?? ''), s(field), s(ref.column), s(ref.header)])
    }
  }
  return lines
}

function rowLines(report: MarginReport): Cell[][] {
  return report.rows.map((row) => [
    s(row.sheet), n(row.rowIndex), s(row.name), n(row.qty),
    money(row.revenueCents), money(row.costCents), money(row.marginCents), n(row.marginPct),
    s(row.kind), s(row.issues.join('; ')),
  ])
}

function productLines(report: MarginReport): Cell[][] {
  return report.products.map((product) => [
    s(product.name), n(product.rowsCount), n(product.rowsComplete), n(product.qty),
    money(product.revenueCents), money(product.coveredRevenueCents), money(product.coveredCostCents), money(product.coveredMarginCents),
    n(product.coveredMarginPct), s(product.complete ? 'yes' : 'no'),
    s(product.provenance.slice(0, 20).map((source) => `${source.sheet}:${source.rowIndex}`).join('; ') + (product.provenance.length > 20 ? ` (+${product.provenance.length - 20})` : '')),
  ])
}

function gapLines(report: MarginReport): Cell[][] {
  return [
    GAP_HEADER,
    ...report.costGaps.map((gap) => [s('cost_gap'), s(gap.sheet), n(gap.rowIndex), s(gap.name), s(gap.reason)]),
    ...report.excludedSummaryRows.map((row) => [s('summary_excluded'), s(row.sheet), n(row.rowIndex), s(row.name), s('')]),
    ...report.skippedSheets.map((sheet) => [s('sheet_skipped'), s(sheet.sheet), n(null), s(''), s(sheet.reason)]),
    ...report.parseIssues.map((issue) => [s('parse_issue'), s(issue.sheet ?? ''), n(issue.rowIndex ?? null), s(issue.cellRef ?? ''), s(issue.code)]),
    ...report.rows.filter((row) => row.issues.length).map((row) => [s('row_issue'), s(row.sheet), n(row.rowIndex), s(row.name), s(row.issues.join('; '))]),
  ]
}

const totalsLine = (report: MarginReport): Cell[] => [
  s('totals'), s(''), s(''), s(''),
  money(report.totals.revenueCents), money(report.totals.costCentsComplete), money(report.totals.marginCentsComplete), n(report.totals.marginPctComplete),
  s(`complete rows ${report.totals.rowsComplete}/${report.totals.rowsTotal}`), s(`returns ${report.totals.returnsCount} (${formatCents(report.totals.returnsRevenueCents)})`),
]

export function marginReportToCsv(report: MarginReport): string {
  const lines: string[] = []
  for (const line of metaLines(report)) lines.push(csvLine(line))
  lines.push('', csvLine([s('MAPPING')]))
  for (const line of mappingLines(report)) lines.push(csvLine(line))
  lines.push('', csvLine([s('ROWS')]), csvLine(ROW_HEADER))
  for (const line of rowLines(report)) lines.push(csvLine(line))
  lines.push(csvLine(totalsLine(report)))
  lines.push('', csvLine([s('PRODUCTS')]), csvLine(PRODUCT_HEADER))
  for (const line of productLines(report)) lines.push(csvLine(line))
  lines.push('', csvLine([s('GAPS_AND_ISSUES')]))
  for (const line of gapLines(report)) lines.push(csvLine(line))
  return lines.join('\r\n')
}

// ── real XLSX assembly (minimal OOXML, inline strings + native numbers) ─────────────────────────

function columnName(index: number): string {
  let name = ''
  let value = index
  while (value > 0) {
    const rem = (value - 1) % 26
    name = String.fromCharCode(65 + rem) + name
    value = Math.floor((value - 1) / 26)
  }
  return name
}

function sheetXml(rows: Cell[][], widths: number[] = []): string {
  const body = rows.map((cells, rowIdx) => {
    const cellsXml = cells.map((cell, colIdx) => {
      const ref = `${columnName(colIdx + 1)}${rowIdx + 1}`
      if (cell.t === 'n') return cell.v === null ? '' : `<c r="${ref}"><v>${cell.v}</v></c>`
      if (!cell.v) return ''
      if (cell.v.length > 32767) throw new DocumentSourceError('too_large')
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.v).replace(/\r/g, '&#13;')}</t></is></c>`
    }).join('')
    return `<row r="${rowIdx + 1}">${cellsXml}</row>`
  }).join('')
  const columns = widths.length ? `<cols>${widths.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>` : ''
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${columns}<sheetData>${body}</sheetData></worksheet>`
}

export interface MarginExtraSheet { name: string; rows: Array<Array<string | number | null>> }
export function marginReportToXlsx(report: MarginReport, extraMetaLines: string[][] = [], extraSheets: MarginExtraSheet[] = []): Uint8Array {
  // extraMetaLines carry caller-frozen provenance (e.g. the monthly report's declared period,
  // as-of and source snapshot) INSIDE the workbook — a rename or registry redeclaration after
  // the fact cannot change what this document says about itself
  const marginRows: Cell[][] = [
    ...metaLines(report),
    ...extraMetaLines.map((line) => line.map((value) => s(value))),
    [],
    [s('MAPPING')],
    ...mappingLines(report),
    [],
    ROW_HEADER,
    ...rowLines(report),
    totalsLine(report),
  ]
  const productRows: Cell[][] = [PRODUCT_HEADER, ...productLines(report)]
  const gapRows: Cell[][] = gapLines(report)
  const sheets = [ { name: 'Margin', rows: marginRows }, { name: 'Products', rows: productRows }, { name: 'Gaps', rows: gapRows },
    ...extraSheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows.map((row) => row.map((value) => typeof value === 'string' ? s(value) : n(value))) })) ]
  if (sheets.length > 8 || new Set(sheets.map((sheet) => sheet.name)).size !== sheets.length || sheets.some((sheet) => !sheet.name || sheet.name.length > 31 || /[\\/?*[\]:]/.test(sheet.name))) throw new DocumentSourceError('incomplete')
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Margin" sheetId="1" r:id="rId1"/><sheet name="Products" sheetId="2" r:id="rId2"/><sheet name="Gaps" sheetId="3" r:id="rId3"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml(marginRows)),
    'xl/worksheets/sheet2.xml': strToU8(sheetXml(productRows)),
    'xl/worksheets/sheet3.xml': strToU8(sheetXml(gapRows)),
  }
  // Preserve the existing three-sheet package; extend all OOXML relationships together.
  const decode = new TextDecoder()
  files['[Content_Types].xml'] = strToU8(decode.decode(files['[Content_Types].xml']).replace('</Types>', extraSheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 4}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>'))
  files['xl/workbook.xml'] = strToU8(decode.decode(files['xl/workbook.xml']).replace('</sheets>', extraSheets.map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 4}" r:id="rId${i + 4}"/>`).join('') + '</sheets>'))
  files['xl/_rels/workbook.xml.rels'] = strToU8(decode.decode(files['xl/_rels/workbook.xml.rels']).replace('</Relationships>', extraSheets.map((_, i) => `<Relationship Id="rId${i + 4}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 4}.xml"/>`).join('') + '</Relationships>'))
  for (let i = 3; i < sheets.length; i++) files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(sheets[i].rows, sheets[i].name === 'Source data' ? [24, 9, 9, 9, 26, 80] : [24, 9, 12, 24, 24, 24]))
  return zipSync(files, { level: 6 })
}

// ── printable HTML (standalone, inline styles) ──────────────────────────────────────────────────

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function marginReportToHtml(report: MarginReport): string {
  const t = report.totals
  const reasonItems = report.completenessReasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')
  const mappingRows = report.mapping.flatMap((map) => Object.entries(map.columns).map(([field, ref]) =>
    `<tr><td>${escapeHtml(map.sheet)}</td><td>${map.headerRowIndex}</td><td>${escapeHtml(field)}</td><td>${escapeHtml(ref.column)}</td><td>${escapeHtml(ref.header)}</td><td>${escapeHtml(map.costSemantics)}${map.ambiguousCostHeader ? ` (неподтверждён: ${escapeHtml(map.ambiguousCostHeader.header)})` : ''}</td></tr>`)).join('')
  const productRows = report.products.slice(0, 10).map((product) =>
    `<tr><td>${escapeHtml(product.name)}</td><td class="n">${product.qty ?? '—'}</td><td class="n">${formatCents(product.revenueCents)}</td><td class="n">${formatCents(product.coveredMarginCents)}</td><td class="n">${product.coveredMarginPct === null ? '—' : `${product.coveredMarginPct}%`}</td><td>${product.complete ? '' : '⚠️ частично'}</td></tr>`).join('')
  const rows = report.rows.map((row) => `<tr${row.kind === 'return' ? ' class="ret"' : ''}><td>${escapeHtml(row.sheet)}</td><td>${row.rowIndex}</td><td>${escapeHtml(row.name)}</td><td class="n">${row.qty ?? ''}</td><td class="n">${row.revenueCents === null ? '—' : formatCents(row.revenueCents)}</td><td class="n">${row.costCents === null ? '—' : formatCents(row.costCents)}</td><td class="n">${row.marginCents === null ? '—' : formatCents(row.marginCents)}</td><td class="n">${row.marginPct === null ? '—' : `${row.marginPct}%`}</td><td>${escapeHtml(row.issues.join('; '))}</td></tr>`).join('')
  const listItems = (items: string[]) => items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')
  const gaps = listItems(report.costGaps.map((gap) => `${gap.sheet} · строка ${gap.rowIndex} · ${gap.name} — ${gap.reason}`))
  const summaries = listItems(report.excludedSummaryRows.map((row) => `${row.sheet} · строка ${row.rowIndex} · ${row.name}`))
  const skipped = listItems(report.skippedSheets.map((sheet) => `${sheet.sheet} — ${sheet.reason}`))
  const parseIssues = listItems(report.parseIssues.map((issue) => `${issue.sheet ?? ''} ${issue.cellRef ?? ''} — ${issue.code}`))
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Отчёт по марже</title>
<style>body{font:13px/1.5 system-ui;margin:24px;color:#111}table{border-collapse:collapse;width:100%;margin:8px 0 16px}th,td{border:1px solid #ccc;padding:4px 8px;text-align:left}td.n{text-align:right;font-variant-numeric:tabular-nums}tr.ret td{color:#a33}h1{font-size:18px}h2{font-size:14px}.meta{color:#555;font-size:11px}.warn{background:#fff4d6;padding:8px 12px;border:1px solid #e5c76b;border-radius:6px}</style></head><body>
<h1>Отчёт по марже товаров (${escapeHtml(report.currency)})</h1>
<p class="meta">Файл: ${escapeHtml(report.meta.fileName)} · SHA-256: ${escapeHtml(report.meta.fileSha256)} · Сформирован: ${escapeHtml(report.meta.generatedAt)}</p>
${report.totalsComplete ? '' : `<div class="warn"><b>Итоги НЕПОЛНЫЕ.</b> Причины:<ul>${reasonItems}</ul>Маржа посчитана только по строкам с полными данными (${t.rowsComplete} из ${t.rowsTotal}).</div>`}
<p>Выручка: <b>${formatCents(t.revenueCents)}</b> · Себестоимость (полные строки): <b>${formatCents(t.costCentsComplete)}</b> · Маржа (полные строки): <b>${formatCents(t.marginCentsComplete)}</b>${t.marginPctComplete === null ? '' : ` (<b>${t.marginPctComplete}%</b>)`} · Возвраты: ${t.returnsCount} (${formatCents(t.returnsRevenueCents)})</p>
<h2>Топ товаров по марже (покрытой)</h2>
<table><thead><tr><th>Товар</th><th>Кол-во</th><th>Выручка</th><th>Маржа</th><th>Маржа %</th><th></th></tr></thead><tbody>${productRows}</tbody></table>
<h2>Сопоставление колонок</h2>
<table><thead><tr><th>Лист</th><th>Строка шапки</th><th>Поле</th><th>Колонка</th><th>Заголовок</th><th>Себестоимость</th></tr></thead><tbody>${mappingRows}</tbody></table>
<h2>Строки</h2>
<table><thead><tr><th>Лист</th><th>Строка</th><th>Наименование</th><th>Кол-во</th><th>Выручка</th><th>Себестоимость</th><th>Маржа</th><th>Маржа %</th><th>Замечания</th></tr></thead><tbody>${rows}</tbody></table>
${gaps ? `<h2>Пропуски себестоимости</h2><ul>${gaps}</ul>` : ''}
${summaries ? `<h2>Исключённые итоговые строки</h2><ul>${summaries}</ul>` : ''}
${skipped ? `<h2>Листы без распознанной шапки</h2><ul>${skipped}</ul>` : ''}
${parseIssues ? `<h2>Замечания разбора файла</h2><ul>${parseIssues}</ul>` : ''}
</body></html>`
}
