// Product-margin report from a RAW .xlsx — deliberately SEPARATE from the cash-flow analysis:
// different semantics (per-product margin vs cash movements), fully client-side and
// deterministic (no LLM, no backend), parsed in a worker under a hard deadline.
// The downloads are the deliverables: CSV, a REAL .xlsx and printable HTML, all carrying the
// mapping, provenance, product rankings and every completeness reason.
import { FileSpreadsheet, Download } from 'lucide-react'
import { useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import { parseXlsxInWorker } from '../../lib/xlsxParseClient'
import { runMarginPipeline } from '../../lib/marginUpload'
import { formatCents, type MarginReport } from '../../lib/productMargin'
import { marginReportToCsv, marginReportToHtml, marginReportToXlsx } from '../../lib/marginReportExport'
import type { Lang } from '../../types'

const COPY: Record<Lang, Record<string, string>> = {
  ru: {
    title: 'Маржа по товарам (XLSX)', hint: 'Загрузите исходный .xlsx (Excel/WPS) — отчёт считается локально и детерминированно, отдельно от анализа денежного потока. Файл никуда не отправляется.',
    drop: 'Выбрать .xlsx', busy: 'Разбор файла…', complete: 'Итоги полные', incomplete: 'Итоги НЕПОЛНЫЕ', reasons: 'Причины',
    revenue: 'Выручка', margin: 'Маржа (по покрытым строкам)', top: 'Топ товаров по марже', partial: 'частично',
    downloadCsv: 'CSV', downloadXlsx: 'XLSX', downloadHtml: 'HTML (печать)',
    ambiguous: 'Колонка себестоимости не подтверждена — уточните заголовок в файле (например, «Себестоимость за ед» или «Сумма себестоимости»).',
    err_bad_archive: 'Файл повреждён или не является корректным .xlsx.', err_too_big: 'Файл отклонён: превышены безопасные лимиты размера.',
    err_rows: 'Файл отклонён: слишком много строк для точного отчёта.', err_not_xlsx: 'Это не файл .xlsx.',
    err_timeout: 'Разбор файла превысил лимит времени.', err_no_sheets: 'Не найдено ни одного листа с распознаваемой шапкой.',
    currencyLabel: 'Валюта файла', err_file_empty: 'Файл пуст.',
    err_mixed_currency: 'В файле несколько валют — отчёт не построен: ',
    err_currency_mismatch: 'Валюта в файле не совпадает с выбранной: ',
  },
  uz: {
    title: 'Mahsulotlar marjasi (XLSX)', hint: 'Asl .xlsx faylni yuklang (Excel/WPS) — hisobot lokal va deterministik tarzda, pul oqimi tahlilidan alohida hisoblanadi. Fayl hech qayerga yuborilmaydi.',
    drop: '.xlsx tanlash', busy: 'Fayl tahlil qilinmoqda…', complete: 'Yakunlar to‘liq', incomplete: 'Yakunlar TO‘LIQ EMAS', reasons: 'Sabablari',
    revenue: 'Tushum', margin: 'Marja (qoplangan qatorlar bo‘yicha)', top: 'Marja bo‘yicha top mahsulotlar', partial: 'qisman',
    downloadCsv: 'CSV', downloadXlsx: 'XLSX', downloadHtml: 'HTML (chop etish)',
    ambiguous: 'Tannarx ustuni tasdiqlanmagan — fayldagi sarlavhani aniqlashtiring (masalan, «Tannarx (dona)»).',
    err_bad_archive: 'Fayl buzilgan yoki to‘g‘ri .xlsx emas.', err_too_big: 'Fayl rad etildi: xavfsiz hajm chegarasi oshib ketdi.',
    err_rows: 'Fayl rad etildi: aniq hisobot uchun qatorlar juda ko‘p.', err_not_xlsx: 'Bu .xlsx fayl emas.',
    err_timeout: 'Fayl tahlili vaqt chegarasidan oshdi.', err_no_sheets: 'Taniladigan sarlavhali birorta varaq topilmadi.',
    currencyLabel: 'Fayl valyutasi', err_file_empty: 'Fayl bo‘sh.',
    err_mixed_currency: 'Faylda bir nechta valyuta bor — hisobot tuzilmadi: ',
    err_currency_mismatch: 'Fayldagi valyuta tanlangan bilan mos emas: ',
  },
  en: {
    title: 'Product margin (XLSX)', hint: 'Upload the raw .xlsx (Excel/WPS) — the report is computed locally and deterministically, separately from the cash-flow analysis. The file never leaves your browser.',
    drop: 'Choose .xlsx', busy: 'Parsing the file…', complete: 'Totals are complete', incomplete: 'Totals are PARTIAL', reasons: 'Reasons',
    revenue: 'Revenue', margin: 'Margin (covered rows)', top: 'Top products by margin', partial: 'partial',
    downloadCsv: 'CSV', downloadXlsx: 'XLSX', downloadHtml: 'HTML (print)',
    ambiguous: 'The cost column is unconfirmed — clarify the header in the file (e.g. "unit cost" or "total cost").',
    err_bad_archive: 'The file is corrupt or not a valid .xlsx.', err_too_big: 'File rejected: safe size limits exceeded.',
    err_rows: 'File rejected: too many rows for an exact report.', err_not_xlsx: 'This is not an .xlsx file.',
    err_timeout: 'Parsing exceeded the time limit.', err_no_sheets: 'No sheet with a recognizable header was found.',
    currencyLabel: 'File currency', err_file_empty: 'The file is empty.',
    err_mixed_currency: 'The file mixes currencies — no report was built: ',
    err_currency_mismatch: 'The file currency does not match the selected one: ',
  },
}

const CURRENCIES = ['UZS', 'USD', 'RUB', 'EUR'] as const
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024 // compressed-file guard BEFORE any read
const OPERATION_DEADLINE_MS = 25_000

const REASON_KEY: Record<string, string> = {
  bad_archive: 'err_bad_archive', archive_too_large: 'err_too_big', entry_too_large: 'err_too_big',
  too_many_entries: 'err_too_big', too_many_shared_strings: 'err_too_big',
  sheet_rows_over_limit: 'err_rows', workbook_rows_over_limit: 'err_rows',
  not_xlsx: 'err_not_xlsx', parse_timeout: 'err_timeout', worker_failed: 'err_timeout',
  no_recognized_sheets: 'err_no_sheets', amount_overflow: 'err_rows',
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function download(fileName: string, mime: string, data: Uint8Array | string): void {
  const blob = data instanceof Uint8Array
    ? new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer], { type: mime })
    : new Blob([data], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function ProductMarginPanel() {
  const { lang } = useI18n()
  const c = COPY[lang]
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [currency, setCurrency] = useState<(typeof CURRENCIES)[number]>('UZS')
  const [report, setReport] = useState<MarginReport | null>(null)
  const busyRef = useRef(false)
  const opRef = useRef(0)

  const onFile = async (file: File | undefined) => {
    if (!file || busyRef.current) return
    busyRef.current = true
    const opId = ++opRef.current // suppress any late continuation from an abandoned run
    setBusy(true)
    setError('')
    setReport(null)
    try {
      // file-safety gates BEFORE any byte is read or hashed
      if (!/\.xlsx$/i.test(file.name)) { setError(c.err_not_xlsx); return }
      if (file.size === 0) { setError(c.err_file_empty); return }
      if (file.size > MAX_UPLOAD_BYTES) { setError(c.err_too_big); return }
      // the pipeline races EVERY phase (read, hash, parse) against one shared deadline —
      // a stalled read or hash resolves to a timeout instead of leaving the panel busy forever
      const result = await runMarginPipeline({
        readBuffer: () => file.arrayBuffer(),
        hash: sha256Hex,
        parse: (buffer, timeoutMs) => parseXlsxInWorker(buffer, timeoutMs),
      }, { currency, fileName: file.name, deadlineMs: OPERATION_DEADLINE_MS })
      if (opId !== opRef.current) return // an abandoned run must not touch the state
      if (!result.ok) {
        if (result.reason === 'mixed_currency') setError(c.err_mixed_currency + (result.detail ?? ''))
        else if (result.reason === 'currency_mismatch') setError(c.err_currency_mismatch + (result.detail ?? ''))
        else setError(c[REASON_KEY[result.reason] ?? 'err_bad_archive'])
        return
      }
      setReport(result.report)
    } catch {
      if (opId === opRef.current) setError(c.err_bad_archive)
    } finally {
      if (opId === opRef.current) { busyRef.current = false; setBusy(false) }
    }
  }

  const base = report ? report.meta.fileName.replace(/\.xlsx$/i, '') || 'margin' : 'margin'
  const ambiguous = report?.mapping.some((map) => map.ambiguousCostHeader && map.costSemantics === 'none')

  return <section className="card mt-5 rounded-2xl p-5 sm:p-6">
    <div className="flex items-start gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent-cyan/15 to-accent-indigo/15 text-accent-cyan"><FileSpreadsheet size={18} /></span>
      <div className="min-w-0 flex-1">
        <h2 className="font-semibold text-text">{c.title}</h2>
        <p className="mt-1 text-xs leading-5 text-muted">{c.hint}</p>
      </div>
    </div>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-ice/10 bg-black/15 px-3 py-2.5 text-sm font-semibold text-text transition hover:border-accent-cyan/40">
        <FileSpreadsheet size={15} />{busy ? c.busy : c.drop}
        <input type="file" accept=".xlsx" className="hidden" disabled={busy} onChange={(event) => { void onFile(event.target.files?.[0]); event.target.value = '' }} />
      </label>
      <label className="inline-flex items-center gap-2 text-xs text-muted">
        {c.currencyLabel}
        <select value={currency} onChange={(event) => setCurrency(event.target.value as (typeof CURRENCIES)[number])} disabled={busy} className="rounded-xl border border-ice/10 bg-black/15 px-2 py-2 text-sm text-text outline-none">
          {CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}
        </select>
      </label>
      {error && <p role="status" className="text-xs leading-5 text-amber">{error}</p>}
    </div>
    {report && <div className="mt-4 space-y-3 text-sm text-text">
      <p className={report.totalsComplete ? 'font-semibold text-teal' : 'font-semibold text-amber'}>
        {report.totalsComplete ? c.complete : `${c.incomplete} — ${c.reasons}: ${report.completenessReasons.join('; ')}`}
      </p>
      {ambiguous && <p className="rounded-xl border border-amber/30 bg-amber/10 px-3 py-2 text-xs leading-5 text-amber">{c.ambiguous}</p>}
      <p className="text-xs text-muted">
        {c.revenue}: <b className="text-text">{formatCents(report.totals.revenueCents)} {report.currency}</b> · {c.margin}: <b className="text-text">{formatCents(report.totals.marginCentsComplete)} {report.currency}</b>
        {report.totals.marginPctComplete === null ? '' : ` (${report.totals.marginPctComplete}%)`} · {report.totals.rowsComplete}/{report.totals.rowsTotal}
      </p>
      <div>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{c.top}</p>
        <ul className="space-y-1 text-xs leading-5">
          {report.products.slice(0, 5).map((product) => <li key={`${product.sku ?? ''}|${product.name}`} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate">{product.name}{product.sku ? ` · ${product.sku}` : ''}</span>
            <span className="font-variant-numeric tabular-nums">{formatCents(product.coveredMarginCents)}</span>
            <span className="text-muted">{product.coveredMarginPct === null ? '—' : `${product.coveredMarginPct}%`}</span>
            {!product.complete && <span className="text-amber">⚠ {c.partial}</span>}
          </li>)}
        </ul>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => download(`${base}-margin.csv`, 'text/csv;charset=utf-8', '\uFEFF' + marginReportToCsv(report))} className="inline-flex items-center gap-1.5 rounded-xl border border-ice/10 px-3 py-2 text-xs font-semibold text-text hover:bg-white/5"><Download size={13} />{c.downloadCsv}</button>
        <button type="button" onClick={() => download(`${base}-margin.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', marginReportToXlsx(report))} className="inline-flex items-center gap-1.5 rounded-xl border border-ice/10 px-3 py-2 text-xs font-semibold text-text hover:bg-white/5"><Download size={13} />{c.downloadXlsx}</button>
        <button type="button" onClick={() => download(`${base}-margin.html`, 'text/html;charset=utf-8', marginReportToHtml(report))} className="inline-flex items-center gap-1.5 rounded-xl border border-ice/10 px-3 py-2 text-xs font-semibold text-text hover:bg-white/5"><Download size={13} />{c.downloadHtml}</button>
      </div>
    </div>}
  </section>
}
