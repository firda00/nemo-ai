import { computeProductMargin, type MarginReport } from '../../supabase/functions/_shared/productMargin'
import { copySourceText, type DocumentSourceSnapshot } from './documentSources'
import type { SourceDocumentOptions } from './documentJobs'
import { DocumentPeriodSchema } from './documentPeriod'
import { filterSourcePeriod, type PeriodIssue, type PeriodRowEvidence } from './documentPeriodFilter'

const PERIOD_LABELS = {
  ru: { scope: 'Период по календарным датам источника, обе границы включены. Время суток в числовых датах Excel отбрасывается; часовой пояс не пересчитывается. Каждый файл рассчитан отдельно; дубликаты не удалены. Это маржа товаров, полнота бухгалтерского учёта не проверена.', audit: 'Отбор по датам', empty: 'В этом файле нет распознанных товарных строк внутри периода.', dateSystem: 'Система дат Excel', included: 'В расчёте', outside_period: 'Вне периода', summary: 'Итоговая строка, не учитывается', unrecognized_sheet: 'Лист не распознан, не учитывается' },
  uz: { scope: 'Manbaning kalendar sanalari bo‘yicha davr, ikkala chegara ham kiritilgan. Excel raqamli sanalarining vaqt qismi olinmaydi; vaqt mintaqasi o‘zgartirilmaydi. Har bir fayl alohida hisoblandi; takrorlar o‘chirilmadi. Bu mahsulot marjasi; buxgalteriya to‘liqligi tekshirilmagan.', audit: 'Sana bo‘yicha tanlash', empty: 'Bu faylda davr ichida aniqlangan mahsulot satrlari yo‘q.', dateSystem: 'Excel sana tizimi', included: 'Hisobga kiritilgan', outside_period: 'Davrdan tashqari', summary: 'Jami satr, hisobga olinmaydi', unrecognized_sheet: 'Varaq aniqlanmagan, hisobga olinmaydi' },
  en: { scope: 'Period uses source calendar dates, both boundaries inclusive. The time part of numeric Excel dates is discarded; no time zone conversion. Each file is calculated separately; duplicates remain. Product margin only; accounting completeness has not been verified.', audit: 'Date selection', empty: 'This file has no recognized product rows within the period.', dateSystem: 'Excel date system', included: 'Included', outside_period: 'Outside period', summary: 'Summary row, excluded', unrecognized_sheet: 'Unrecognized sheet, excluded' },
}

const LABELS = {
  ru: { title: 'Маржа по загруженным данным', scope: 'Расчёт по всем строкам каждого файла отдельно. Фильтр дат не применялся; дубликаты не удалялись. Это маржа товаров, без проверки полноты бухгалтерского учёта.',
    revenue: 'Выручка распознанных строк', cost: 'Себестоимость строк с данными', margin: 'Маржа строк с данными', rows: 'Строки с себестоимостью / распознанные строки',
    complete: 'Себестоимость покрывает все распознанные строки.', partial: 'ЧАСТИЧНЫЙ РАСЧЁТ. Итоговая прибыль по всему бизнесу не установлена.',
    causes: 'Причины неполноты', details: 'Расчёт и координаты строк', mapping: 'Сопоставление колонок', excluded: 'Исключённые итоговые строки', skipped: 'Пропущенные листы',
    duplicate: 'Есть одинаковые строки данных: возможное повторение записей, проверьте источники. Строки сохранены в расчёте.', sources: 'Извлечённый текст источников', cached: 'Значения формул взяты из сохранённого кэша Excel; формулы не пересчитывались.' },
  uz: { title: 'Yuklangan ma’lumotlar bo‘yicha marja', scope: 'Har bir faylning barcha satrlari alohida hisoblandi. Sana filtri qo‘llanilmadi; takroriy satrlar o‘chirilmadi. Bu mahsulot marjasi; buxgalteriya hisobi to‘liqligi tekshirilmagan.',
    revenue: 'Aniqlangan satrlar tushumi', cost: 'Ma’lumotli satrlar tannarxi', margin: 'Ma’lumotli satrlar marjasi', rows: 'Tannarxli / aniqlangan satrlar',
    complete: 'Barcha aniqlangan satrlarda tannarx mavjud.', partial: 'QISMAN HISOB. Butun biznesning yakuniy foydasi aniqlanmagan.',
    causes: 'To‘liqsizlik sabablari', details: 'Hisob va satr manzillari', mapping: 'Ustunlar mosligi', excluded: 'Chiqarilgan jami satrlar', skipped: 'O‘tkazib yuborilgan varaqlar',
    duplicate: 'Bir xil ma’lumot satrlari bor: yozuvlar takrorlangan bo‘lishi mumkin. Manbalarni tekshiring. Satrlar hisobda saqlangan.', sources: 'Manbalardan olingan matn', cached: 'Formulalar Excel keshidan olindi; qayta hisoblanmadi.' },
  en: { title: 'Product margin from uploaded data', scope: 'All rows of each file calculated separately. No date filtering or deduplication. Product margin only; accounting completeness has not been verified.',
    revenue: 'Revenue of recognized rows', cost: 'Cost of covered rows', margin: 'Margin of covered rows', rows: 'Rows with cost / recognized rows',
    complete: 'Costs cover all recognized rows.', partial: 'PARTIAL CALCULATION. Total business profit has not been established.',
    causes: 'Reasons for incomplete coverage', details: 'Calculation and row locations', mapping: 'Column mapping', excluded: 'Excluded summary rows', skipped: 'Skipped sheets',
    duplicate: 'Identical data rows found: possible duplicate records; check the sources. These rows remain in the calculation.', sources: 'Extracted source text', cached: 'Formula values use the saved Excel cache; formulas were not recalculated.' },
}
export function hasPeriodRequest(brief: string): boolean {
  return /\b\d|период|месяц|недел|квартал|январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр|сегодня|вчера|год|лет|день|дня|дней|суток|последн|прошл|текущ|только|period|month|week|quarter|year|day|today|yesterday|last|past|previous|current|since|between|before|after|only|january|february|march|april|may|june|july|august|september|october|november|december|yanvar|fevral|mart|aprel|iyun|iyul|avgust|sentabr|oktabr|noyabr|dekabr|chorak|hafta|bugun|kecha|\byil|\bkun|faqat/i.test(brief)
}
export function moneyFromCents(value: number): string {
  const absolute = BigInt(Math.abs(value))
  return `${value < 0 ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`
}
export function buildSourceMarginReport(snapshot: DocumentSourceSnapshot, brief: string, options: SourceDocumentOptions):
  { ok: true; title: string; text: string; reports: MarginReport[]; periodAudit: Array<{ sourceId: string; rows: PeriodRowEvidence[] }> } | { ok: false; reason: string; issues?: PeriodIssue[] } {
  const files = snapshot.sources.filter((s) => s.data.format === 'xlsx')
  if (!files.length) return { ok: false, reason: 'needs_xlsx' }
  if (options.period && (!DocumentPeriodSchema.safeParse(options.period).success || options.wholeWorkbook)) return { ok: false, reason: 'needs_period' }
  if (hasPeriodRequest(brief) && !options.wholeWorkbook && !options.period) return { ok: false, reason: 'needs_period' }
  if (new Set(files.map((s) => s.sha256)).size !== files.length) return { ok: false, reason: 'duplicate_files' }
  const codes = [...new Set(brief.toUpperCase().match(/\b(?:UZS|USD|RUB|EUR)\b/g) ?? [])]
  const currency = options.currency ?? (codes.length === 1 ? codes[0] : null)
  const copy = LABELS[options.language]
  const dates = PERIOD_LABELS[options.language]
  const sections = [options.period ? `${options.period.from} — ${options.period.to}\n${dates.scope}` : copy.scope]
  const reports: MarginReport[] = []
  const periodAudit: Array<{ sourceId: string; rows: PeriodRowEvidence[] }> = []
  for (const source of files) {
    if (source.data.format !== 'xlsx') continue
    const selected = options.period ? filterSourcePeriod(source, options.period) : null
    if (selected?.issues.length) return { ok: false, reason: 'needs_source_dates', issues: selected.issues }
    if (selected) {
      periodAudit.push({ sourceId: source.id, rows: selected.audit })
      sections.push(`${source.id} · ${source.name}\n${dates.dateSystem}: ${source.data.dateSystem ?? 'unknown'}\n${dates.audit}\n` + selected.audit.map((row) =>
        `[${source.id}/${JSON.stringify(row.sheet)}${row.row === undefined ? '' : `/row:${row.row}`}] ${dates[row.decision]}${row.column ? `; ${row.column}=${JSON.stringify(row.raw)} → ${row.date}` : ''}`).join('\n'))
      if (!selected.mapped) return { ok: false, reason: 'no_recognized_sheets' }
      if (!selected.included) { sections.push(dates.empty); continue }
    }
    const result = computeProductMargin({ sheets: selected?.sheets ?? source.data.sheets, issues: [] }, { currency, fileName: source.name, fileSha256: source.sha256, now: () => new Date(0) })
    if (!result.ok) return { ok: false, reason: result.reason }
    reports.push(result)
    const money = (n: number | null) => n === null ? '—' : `${moneyFromCents(n)} ${result.currency}`
    const signatures = new Set<string>()
    const countedRows = new Set(result.rows.map((r) => JSON.stringify([r.sheet, r.rowIndex])))
    let duplicate = false
    for (const sheet of source.data.sheets) for (const row of sheet.rows) {
      if (!countedRows.has(JSON.stringify([sheet.name, row.rowIndex]))) continue
      const key = JSON.stringify(Object.entries(row.cells).sort(([a], [b]) => a.localeCompare(b)).map(([col, c]) => [col, c.value]))
      if (signatures.has(key)) duplicate = true
      signatures.add(key)
    }
    sections.push(`${source.id} · ${source.name}\nSHA-256: ${source.sha256}\n${result.totalsComplete ? copy.complete : copy.partial}`,
      `${copy.rows}: ${result.totals.rowsComplete} / ${result.totals.rowsTotal}\n${copy.revenue}: ${money(result.totals.revenueCents)}\n${copy.cost}: ${money(result.totals.costCentsComplete)}\n${copy.margin}: ${money(result.totals.marginCentsComplete)}`,
      `${copy.causes}: ${JSON.stringify(result.completenessReasons)}`,
      `${copy.mapping}: ${JSON.stringify(result.mapping)}`,
      `${copy.excluded}: ${JSON.stringify(result.excludedSummaryRows)}\n${copy.skipped}: ${JSON.stringify(result.skippedSheets)}`,
      `${copy.details}\n${result.rows.map((r) => `[${source.id}/${JSON.stringify(r.sheet)}/row:${r.rowIndex}] ${r.name}: ${copy.revenue}=${money(r.revenueCents)}; ${copy.cost}=${money(r.costCents)}; ${copy.margin}=${money(r.marginCents)}; ${JSON.stringify(r.issues)}`).join('\n')}`)
    if (duplicate) sections.push(copy.duplicate)
    if (source.data.sheets.some((s) => s.rows.some((r) => Object.values(r.cells).some((c) => c.kind === 'formula-cached')))) sections.push(copy.cached)
  }
  if (options.period && !reports.length) return { ok: false, reason: 'no_rows_period' }
  sections.push(copy.sources, copySourceText(snapshot))
  return { ok: true, title: copy.title, text: sections.join('\n\n'), reports, periodAudit }
}
