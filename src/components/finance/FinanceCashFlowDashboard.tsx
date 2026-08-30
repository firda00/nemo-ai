import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import {
  ArrowDownLeft,
  ArrowUpRight,
  BadgeDollarSign,
  BanknoteArrowDown,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  Download,
  FileJson,
  FileSpreadsheet,
  Landmark,
  Link2,
  Loader2,
  ReceiptText,
  RotateCcw,
  Sparkles,
  UploadCloud,
  X,
} from 'lucide-react'
import { useI18n } from '../../i18n'
import type { Lang } from '../../types'
import { cn } from '../../lib/cn'
import { getAccessToken, isSupabaseEnabled } from '../../lib/supabase'
import { useAgentStore } from '../../store/useAgentStore'
import { buildPrintableDocument } from '../../lib/docExport'
import { CashFlowAnalyticsOutputSchema, type CashFlowAnalyticsOutput } from '../../../supabase/functions/_shared/financeCashFlow'

type FinanceSource = {
  source_id: string
  imported_at: string
  default_currency: string
  amount_scale: number
  default_account_id: string
} & ({ format: 'csv'; content: string } | { format: 'excel_json'; sheets: Array<{ name: string; rows: Record<string, unknown>[] }> } | { format: 'pdf_json'; pages: Array<{ page: number; text?: string; tables?: Record<string, unknown>[][] }> })

type DisplayTransaction = {
  id: string
  date: string
  description: string
  counterparty: string
  category: string
  group: string
  direction: 'inflow' | 'outflow'
  amountMinor: number
  sourceId: string
  locator: string
}

type DraftDecision = 'pending' | 'approved' | 'rejected'
type OrderDraft = { id: string; type: string; title: string; subject: string; effectiveDate: string; source: string; clauses: string[] }

const MAX_BYTES = 8 * 1024 * 1024
const MAX_ROWS = 10_000
const PREVIEW_TRANSACTIONS: DisplayTransaction[] = [
  { id: 'tr-1001', date: '2026-08-02', description: 'Оплата годового тарифа Pro', counterparty: 'Atlas Learning', category: 'Выручка', group: 'revenue', direction: 'inflow', amountMinor: 48_600_000, sourceId: 'august-bank', locator: 'CSV · строка 18' },
  { id: 'tr-1002', date: '2026-08-05', description: 'Облачные GPU и хранение', counterparty: 'Compute Region', category: 'Серверы', group: 'infrastructure', direction: 'outflow', amountMinor: 11_840_000, sourceId: 'august-bank', locator: 'CSV · строка 31' },
  { id: 'tr-1003', date: '2026-08-08', description: 'Performance campaign', counterparty: 'Meta Ads', category: 'Маркетинг', group: 'marketing', direction: 'outflow', amountMinor: 8_275_000, sourceId: 'marketing-sheet', locator: 'Excel · Media spend · строка 42' },
  { id: 'tr-1004', date: '2026-08-12', description: 'Командные SaaS-подписки', counterparty: 'Productivity stack', category: 'Подписки', group: 'software_subscription', direction: 'outflow', amountMinor: 3_190_000, sourceId: 'august-bank', locator: 'CSV · строка 67' },
  { id: 'tr-1005', date: '2026-08-17', description: 'Оплата внедрения', counterparty: 'Mirzo Retail', category: 'Выручка', group: 'revenue', direction: 'inflow', amountMinor: 34_900_000, sourceId: 'august-bank', locator: 'CSV · строка 88' },
  { id: 'tr-1006', date: '2026-08-21', description: 'Зарплата продуктовой команды', counterparty: 'Payroll batch 08', category: 'ФОТ', group: 'payroll', direction: 'outflow', amountMinor: 31_450_000, sourceId: 'payroll-register', locator: 'PDF · страница 3' },
]

const evidence = (source_id: string, source_kind: 'csv' | 'xlsx' | 'pdf', locator: { row?: number; page?: number; sheet?: string }) => ({ source_id, source_kind, locator })
const PREVIEW_ANALYSIS: CashFlowAnalyticsOutput = {
  period: { from: '2026-08-01T00:00:00+05:00', to: '2026-09-01T00:00:00+05:00' },
  currency: 'UZS',
  summary: { opening_balance_minor: 86_000_000, inflow_minor: 83_500_000, outflow_minor: 54_755_000, net_cash_flow_minor: 28_745_000, closing_balance_minor: 114_745_000, transfer_volume_minor: 0 },
  category_breakdown: [
    { category_id: 'revenue', category_name: 'Выручка', direction: 'inflow', amount_minor: 83_500_000, share_of_direction: 1, transaction_count: 2 },
    { category_id: 'payroll', category_name: 'ФОТ', direction: 'outflow', amount_minor: 31_450_000, share_of_direction: 0.5744, transaction_count: 1 },
    { category_id: 'infrastructure', category_name: 'Серверы', direction: 'outflow', amount_minor: 11_840_000, share_of_direction: 0.2162, transaction_count: 1 },
    { category_id: 'marketing', category_name: 'Маркетинг', direction: 'outflow', amount_minor: 8_275_000, share_of_direction: 0.1511, transaction_count: 1 },
    { category_id: 'software', category_name: 'Подписки', direction: 'outflow', amount_minor: 3_190_000, share_of_direction: 0.0583, transaction_count: 1 },
  ],
  impact_assessments: [{ title: 'Приток перекрывает операционные расходы', explanation: 'Две подтверждённые оплаты сформировали положительный денежный поток периода.', confidence: 0.96, evidence: [evidence('august-bank', 'csv', { row: 18 }), evidence('august-bank', 'csv', { row: 88 })], category_id: 'revenue', spend_minor: 0, impact_status: 'positive', roi_ratio: null, attribution_quality: 'measured', metric_changes: [] }],
  inefficiencies: [{ title: 'Подписки требуют инвентаризации', explanation: 'В выписке есть единый платёж за набор SaaS-инструментов, но нет данных об активных пользователях.', confidence: 0.82, evidence: [evidence('august-bank', 'csv', { row: 67 })], severity: 'medium', affected_transaction_ids: ['tr-1004'], avoidable_amount_minor: null, reason_code: 'unused_subscription' }],
  recommendations: [{ title: 'Проверить состав SaaS-пакета', explanation: 'Сопоставьте оплаченные лицензии с активными пользователями до следующего списания.', confidence: 0.9, evidence: [evidence('august-bank', 'csv', { row: 67 })], action: 'investigate', estimated_saving_minor: null, owner_role: 'Finance owner', priority: 'high', requires_human_approval: true }],
  data_quality: { completeness_score: 0.86, uncategorized_transaction_ids: [], missing_evidence_transaction_ids: ['tr-1005'], warnings: ['Для расчёта ROI маркетинга не хватает подтверждённой выручки по кампании.'] },
}

const PREVIEW_ORDERS: OrderDraft[] = [
  { id: 'ord-bonus-08', type: 'Премия', title: 'Проект приказа о премировании', subject: 'Команда продаж · август 2026', effectiveDate: '2026-08-31', source: 'payroll-register · PDF стр. 3', clauses: ['Начислить премию после проверки KPI.', 'Передать расчёт бухгалтеру до 31 августа.'] },
  { id: 'ord-writeoff-14', type: 'Списание ТМЦ', title: 'Проект приказа о списании оборудования', subject: 'Инвентарная группа DEV-14', effectiveDate: '2026-09-02', source: 'inventory-register · Excel строка 114', clauses: ['Создать комиссию по проверке состояния.', 'Зафиксировать результат актом списания.'] },
]

const COPY: Record<Lang, Record<string, string>> = {
  ru: { eyebrow: 'Finance & Accounting Swarm', title: 'Денежный поток и влияние расходов', subtitle: 'Сведите выписки, проверьте источники и примите кадровые решения — без автоматического исполнения.', demo: 'Демо-данные · не банковский отчёт', live: 'Проверено backend', inflow: 'Приток', outflow: 'Расход', net: 'Чистый поток', burn: 'Burn rate / runway', perMonth: 'в месяц', months: 'мес.', cfo: 'AI CFO Summary', cfoHint: 'Только выводы с привязанными источниками.', quality: 'Полнота данных', breakdown: 'Операции и источники', breakdownHint: 'Нажмите на источник, чтобы открыть grounding.', all: 'Все', income: 'Доходы', expenses: 'Расходы', date: 'Дата', operation: 'Операция', category: 'Категория', amount: 'Сумма', source: 'Источник', ingestion: 'Загрузить финансовые данные', ingestionHint: 'CSV или безопасный JSON dump из Excel/PDF. Бинарные XLSX/PDF на сервер не отправляются.', drop: 'Перетащите файлы сюда', choose: 'или выберите на компьютере', limits: 'До 10 000 строк · 8 МБ на файл', analyze: 'Проанализировать', analyzing: 'Анализируем', noFiles: 'Добавьте хотя бы один источник.', badFile: 'Файл не принят. Используйте CSV или корректный Excel/PDF JSON dump.', tooLarge: 'Файл превышает лимит 8 МБ.', tooMany: 'В источнике больше 10 000 строк.', backendOnly: 'Живой анализ доступен после подключения backend.', analysisError: 'Анализ не выполнен. Проверьте формат данных и доступ к OpenRouter.', grounding: 'Grounding', groundingHint: 'Источник выбранного вывода или операции.', orders: 'HR и хозяйственные приказы', ordersHint: 'Черновики не вступают в силу без решения человека.', approve: 'Approve', reject: 'Reject', export: 'Export PDF', pending: 'Ожидает решения', approved: 'Подтверждено', rejected: 'Отклонено', gate: 'Human approval обязателен', draftNote: 'UI фиксирует решение по черновику; внешнее исполнение не запускается.', noRows: 'Нет операций для выбранного фильтра.' },
  uz: { eyebrow: 'Finance & Accounting Swarm', title: 'Pul oqimi va xarajatlar taʼsiri', subtitle: 'Hisobotlarni birlashtiring, manbalarni tekshiring va kadrlar qarorlarini avtomatik ijrosiz qabul qiling.', demo: 'Demo maʼlumotlari · bank hisoboti emas', live: 'Backend tekshirgan', inflow: 'Kirim', outflow: 'Chiqim', net: 'Sof pul oqimi', burn: 'Burn rate / runway', perMonth: 'oyiga', months: 'oy', cfo: 'AI CFO xulosasi', cfoHint: 'Faqat manbaga bog‘langan xulosalar.', quality: 'Maʼlumotlar to‘liqligi', breakdown: 'Operatsiyalar va manbalar', breakdownHint: 'Groundingni ochish uchun manbani bosing.', all: 'Barchasi', income: 'Kirimlar', expenses: 'Chiqimlar', date: 'Sana', operation: 'Operatsiya', category: 'Kategoriya', amount: 'Summa', source: 'Manba', ingestion: 'Moliyaviy maʼlumotlarni yuklash', ingestionHint: 'CSV yoki Excel/PDF xavfsiz JSON dump. Binar XLSX/PDF serverga yuborilmaydi.', drop: 'Fayllarni shu yerga tashlang', choose: 'yoki kompyuterdan tanlang', limits: '10 000 qatorgacha · har fayl 8 MB', analyze: 'Tahlil qilish', analyzing: 'Tahlil qilinmoqda', noFiles: 'Kamida bitta manba qo‘shing.', badFile: 'Fayl qabul qilinmadi. CSV yoki to‘g‘ri Excel/PDF JSON dump ishlating.', tooLarge: 'Fayl 8 MB limitdan katta.', tooMany: 'Manbada 10 000 dan ortiq qator bor.', backendOnly: 'Jonli tahlil backend ulangandan keyin ishlaydi.', analysisError: 'Tahlil bajarilmadi. Format va OpenRouter ulanishini tekshiring.', grounding: 'Grounding', groundingHint: 'Tanlangan xulosa yoki operatsiya manbasi.', orders: 'HR va xo‘jalik buyruqlari', ordersHint: 'Inson qarorisiz qoralamalar kuchga kirmaydi.', approve: 'Approve', reject: 'Reject', export: 'Export PDF', pending: 'Qaror kutilmoqda', approved: 'Tasdiqlangan', rejected: 'Rad etilgan', gate: 'Human approval majburiy', draftNote: 'UI qoralama qarorini qayd etadi; tashqi ijro boshlanmaydi.', noRows: 'Tanlangan filtrda operatsiya yo‘q.' },
  en: { eyebrow: 'Finance & Accounting Swarm', title: 'Cash flow and spend impact', subtitle: 'Reconcile statements, inspect evidence, and review operational orders without automatic execution.', demo: 'Demo data · not a bank report', live: 'Backend verified', inflow: 'Inflow', outflow: 'Outflow', net: 'Net cash flow', burn: 'Burn rate / runway', perMonth: 'per month', months: 'mo.', cfo: 'AI CFO Summary', cfoHint: 'Evidence-linked findings only.', quality: 'Data completeness', breakdown: 'Transactions and sources', breakdownHint: 'Select a source to inspect its grounding.', all: 'All', income: 'Income', expenses: 'Expenses', date: 'Date', operation: 'Transaction', category: 'Category', amount: 'Amount', source: 'Source', ingestion: 'Upload financial data', ingestionHint: 'CSV or a safe Excel/PDF JSON dump. Binary XLSX/PDF files are never sent to the server.', drop: 'Drop files here', choose: 'or choose from your computer', limits: 'Up to 10,000 rows · 8 MB per file', analyze: 'Analyze cash flow', analyzing: 'Analyzing', noFiles: 'Add at least one source.', badFile: 'File rejected. Use CSV or a valid Excel/PDF JSON dump.', tooLarge: 'File exceeds the 8 MB limit.', tooMany: 'Source contains more than 10,000 rows.', backendOnly: 'Live analysis is available after connecting the backend.', analysisError: 'Analysis failed. Check the data format and OpenRouter connection.', grounding: 'Grounding', groundingHint: 'Evidence for the selected finding or transaction.', orders: 'HR and operational orders', ordersHint: 'Drafts never take effect without a human decision.', approve: 'Approve', reject: 'Reject', export: 'Export PDF', pending: 'Awaiting decision', approved: 'Approved', rejected: 'Rejected', gate: 'Human approval required', draftNote: 'The UI records the draft decision; no external execution starts.', noRows: 'No transactions match this filter.' },
}

function sourceId(name: string, index: number) { return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'finance-source'}-${index + 1}` }
function csvRows(content: string) { const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim()); if (lines.length < 2) return []; const delimiter = [',', ';', '\t'].sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0]; const headers = lines[0].split(delimiter).map((item) => item.trim().toLowerCase()); return lines.slice(1, MAX_ROWS + 1).map((line) => Object.fromEntries(line.split(delimiter).map((value, i) => [headers[i] ?? `field_${i}`, value.trim().replace(/^"|"$/g, '')]))) }
function displayRowsFromCsv(content: string, id: string): DisplayTransaction[] { return csvRows(content).map((row, index) => { const find = (...keys: string[]) => String(Object.entries(row).find(([key]) => keys.some((candidate) => key.replace(/[^a-zа-я0-9]/giu, '').includes(candidate)))?.[1] ?? ''); const category = find('category', 'категор', 'статья') || 'Без категории'; const rawType = `${find('type', 'тип')} ${category}`.toLowerCase(); const direction = /income|inflow|доход|kirim/.test(rawType) ? 'inflow' : 'outflow'; const amount = Number(find('amount', 'сумма').replace(/[\s,]/g, '')) || 0; return { id: `${id}-${index + 2}`, date: find('date', 'дата', 'sana') || '—', description: find('description', 'назначение', 'comment') || 'Операция', counterparty: find('counterparty', 'контрагент') || '—', category, group: category.toLowerCase(), direction, amountMinor: Math.round(Math.abs(amount) * 100), sourceId: id, locator: `CSV · строка ${index + 2}` } }) }
function formatMoney(value: number, currency: string) { return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value / 100) }
function evidenceLabel(item: { source_id: string; locator: { row?: number; page?: number; sheet?: string; timestamp_seconds?: number; transaction_reference?: string } }) { const parts = [item.source_id, item.locator.sheet && `лист ${item.locator.sheet}`, item.locator.page && `стр. ${item.locator.page}`, item.locator.row && `строка ${item.locator.row}`, item.locator.timestamp_seconds != null && `${item.locator.timestamp_seconds}s`, item.locator.transaction_reference].filter(Boolean); return parts.join(' · ') }

export function FinanceCashFlowDashboard() {
  const { lang } = useI18n(); const c = COPY[lang]
  const ensureAccountId = useAgentStore((state) => state.ensureAccountId)
  const inputRef = useRef<HTMLInputElement>(null)
  const [analysis, setAnalysis] = useState<CashFlowAnalyticsOutput>(PREVIEW_ANALYSIS)
  const [rows, setRows] = useState<DisplayTransaction[]>(PREVIEW_TRANSACTIONS)
  const [sources, setSources] = useState<FinanceSource[]>([])
  const [fileNames, setFileNames] = useState<string[]>([])
  const [filter, setFilter] = useState<'all' | 'inflow' | 'outflow'>('all')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [isPreview, setIsPreview] = useState(true)
  const [selectedEvidence, setSelectedEvidence] = useState('august-bank · CSV · строка 18')
  const [decisions, setDecisions] = useState<Record<string, DraftDecision>>({})
  const [openingBalance, setOpeningBalance] = useState('0')
  const [period, setPeriod] = useState('2026-08')
  const filteredRows = useMemo(() => filter === 'all' ? rows : rows.filter((row) => row.direction === filter), [filter, rows])
  const periodDays = Math.max(1, Math.round((Date.parse(analysis.period.to) - Date.parse(analysis.period.from)) / 86_400_000))
  const monthlyBurn = Math.round((analysis.summary.outflow_minor / periodDays) * 30)
  const runway = monthlyBurn > 0 ? analysis.summary.closing_balance_minor / monthlyBurn : 0
  const findings = [...analysis.impact_assessments, ...analysis.inefficiencies, ...analysis.recommendations]

  async function acceptFiles(files: FileList | File[]) {
    setError(''); const nextSources: FinanceSource[] = []; const nextNames: string[] = []; const nextRows: DisplayTransaction[] = []
    for (const [index, file] of Array.from(files).entries()) {
      if (file.size > MAX_BYTES) { setError(c.tooLarge); continue }
      const id = sourceId(file.name, sources.length + index); const imported_at = new Date().toISOString(); const base = { source_id: id, imported_at, default_currency: 'UZS', amount_scale: 100, default_account_id: 'operating' }
      try {
        const text = await file.text()
        if (file.name.toLowerCase().endsWith('.csv')) {
          const parsedRows = csvRows(text); if (parsedRows.length > MAX_ROWS) throw new Error('too_many')
          nextSources.push({ ...base, format: 'csv', content: text }); nextRows.push(...displayRowsFromCsv(text, id))
        } else if (file.name.toLowerCase().endsWith('.json')) {
          const parsed = JSON.parse(text) as Record<string, unknown>; const format = parsed.format
          if (format !== 'excel_json' && format !== 'pdf_json') throw new Error('invalid')
          const count = format === 'excel_json' ? ((parsed.sheets as Array<{ rows?: unknown[] }> | undefined) ?? []).reduce((sum, sheet) => sum + (sheet.rows?.length ?? 0), 0) : ((parsed.pages as Array<{ tables?: unknown[][] }> | undefined) ?? []).reduce((sum, page) => sum + (page.tables ?? []).reduce((inner, table) => inner + table.length, 0), 0)
          if (count > MAX_ROWS) throw new Error('too_many')
          nextSources.push({ ...base, ...parsed, source_id: id, imported_at } as FinanceSource)
        } else throw new Error('invalid')
        nextNames.push(file.name)
      } catch (fileError) { setError(fileError instanceof Error && fileError.message === 'too_many' ? c.tooMany : c.badFile) }
    }
    setSources((current) => [...current, ...nextSources]); setFileNames((current) => [...current, ...nextNames]); if (nextRows.length) setRows(nextRows)
  }

  async function analyze() {
    if (!sources.length) { setError(c.noFiles); return }
    if (!isSupabaseEnabled) { setError(c.backendOnly); return }
    setLoading(true); setError('')
    try {
      const [accountId, token] = await Promise.all([ensureAccountId(), getAccessToken()]); if (!accountId || !token) throw new Error('auth')
      const from = `${period}-01T00:00:00+05:00`; const toDate = new Date(`${period}-01T00:00:00+05:00`); toDate.setMonth(toDate.getMonth() + 1)
      const response = await fetch('/api/finance/analyze-cashflow', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id: accountId, period: { from, to: toDate.toISOString() }, base_currency: 'UZS', opening_balance_minor: Math.round((Number(openingBalance) || 0) * 100), transactions: [], sources, business_objectives: [] }) })
      const body = await response.json().catch(() => null); const checked = CashFlowAnalyticsOutputSchema.safeParse(body?.analysis)
      if (!response.ok || !checked.success) throw new Error(body?.code || 'invalid_response')
      setAnalysis(checked.data); setIsPreview(false)
      const firstFinding = [...checked.data.impact_assessments, ...checked.data.inefficiencies, ...checked.data.recommendations][0]
      if (firstFinding?.evidence[0]) setSelectedEvidence(evidenceLabel(firstFinding.evidence[0]))
    } catch { setError(c.analysisError) } finally { setLoading(false) }
  }

  function removeFile(index: number) { setSources((current) => current.filter((_, i) => i !== index)); setFileNames((current) => current.filter((_, i) => i !== index)) }
  function decide(id: string, decision: DraftDecision) { setDecisions((current) => ({ ...current, [id]: decision })) }
  function exportDraft(draft: OrderDraft) { const markdown = `# ${draft.title}\n\n**Тип:** ${draft.type}\n\n**Основание:** ${draft.source}\n\n**Дата вступления:** ${draft.effectiveDate}\n\n${draft.clauses.map((clause, index) => `${index + 1}. ${clause}`).join('\n')}\n\nСтатус: ${decisions[draft.id] ?? 'pending'}\n`; const popup = window.open('', '_blank', 'noopener,noreferrer'); if (popup) { popup.document.write(buildPrintableDocument(markdown, draft.title)); popup.document.close() } }

  return <section className="space-y-7">
    <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between"><div><p className="text-[10px] font-semibold tracking-[0.18em] text-accent-cyan">{c.eyebrow}</p><h1 className="mt-2 max-w-4xl text-3xl font-extrabold tracking-[-0.035em] text-text sm:text-4xl">{c.title}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{c.subtitle}</p></div><span className={cn('inline-flex w-fit items-center gap-2 rounded-lg border px-3 py-2 text-[10px] font-semibold', isPreview ? 'border-amber/25 bg-amber/[0.06] text-amber' : 'border-teal/25 bg-teal/[0.06] text-teal')}><span className="h-1.5 w-1.5 rounded-full bg-current" />{isPreview ? c.demo : c.live}</span></header>

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard icon={ArrowDownLeft} label={c.inflow} value={formatMoney(analysis.summary.inflow_minor, analysis.currency)} tone="teal" />
      <MetricCard icon={ArrowUpRight} label={c.outflow} value={formatMoney(analysis.summary.outflow_minor, analysis.currency)} tone="amber" />
      <MetricCard icon={BadgeDollarSign} label={c.net} value={formatMoney(analysis.summary.net_cash_flow_minor, analysis.currency)} tone={analysis.summary.net_cash_flow_minor >= 0 ? 'cyan' : 'danger'} />
      <MetricCard icon={Clock3} label={c.burn} value={formatMoney(monthlyBurn, analysis.currency)} detail={`${c.perMonth} · ${runway.toFixed(1)} ${c.months}`} tone="violet" />
    </div>

    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(300px,0.7fr)]">
      <section className="overflow-hidden rounded-3xl border border-ice/[0.08] bg-card/[0.025]" aria-labelledby="cfo-summary-title"><div className="flex items-start justify-between gap-3 border-b border-ice/[0.07] px-5 py-4"><div className="flex gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-cyan/10 text-accent-cyan"><Sparkles size={18} /></span><div><h2 id="cfo-summary-title" className="text-lg font-bold text-text">{c.cfo}</h2><p className="mt-0.5 text-xs text-muted">{c.cfoHint}</p></div></div><span className="font-mono text-[10px] text-fog">{findings.length} findings</span></div><div className="divide-y divide-ice/[0.06]">{findings.map((finding, index) => <article key={`${finding.title}-${index}`} className="px-5 py-4"><div className="flex flex-wrap items-start gap-2"><span className={cn('mt-1 h-2 w-2 rounded-full', index === 0 ? 'bg-teal' : index === 1 ? 'bg-amber' : 'bg-accent-cyan')} /><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold text-text">{finding.title}</h3><p className="mt-1 text-xs leading-5 text-muted">{finding.explanation}</p><div className="mt-2 flex flex-wrap gap-1.5">{finding.evidence.map((item, evidenceIndex) => <button key={evidenceIndex} type="button" onClick={() => setSelectedEvidence(evidenceLabel(item))} className="inline-flex items-center gap-1 rounded-md border border-ice/[0.08] bg-bg/35 px-2 py-1 font-mono text-[9px] text-fog transition hover:border-accent-cyan/25 hover:text-accent-cyan"><Link2 size={10} />{evidenceLabel(item)}</button>)}</div></div><span className="font-mono text-[10px] text-fog">{Math.round(finding.confidence * 100)}%</span></div></article>)}</div></section>
      <aside className="rounded-3xl border border-ice/[0.08] bg-panel/55 p-5"><div className="flex items-center gap-2"><CircleAlert size={17} className="text-amber" /><h2 className="text-base font-bold text-text">{c.quality}</h2></div><div className="mt-5 flex items-end justify-between"><span className="text-4xl font-extrabold tracking-tight text-text tabular-nums">{Math.round(analysis.data_quality.completeness_score * 100)}%</span><span className="text-[10px] text-fog">{analysis.data_quality.missing_evidence_transaction_ids.length} missing evidence</span></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-white/[0.05]"><div className="h-full rounded-full bg-accent-cyan transition-[width] duration-500" style={{ width: `${analysis.data_quality.completeness_score * 100}%` }} /></div><div className="mt-5 space-y-2">{analysis.data_quality.warnings.map((warning) => <p key={warning} className="rounded-xl border border-amber/15 bg-amber/[0.045] p-3 text-[11px] leading-5 text-muted">{warning}</p>)}</div><div className="mt-5 border-t border-ice/[0.07] pt-4"><p className="text-[10px] font-semibold tracking-wide text-fog">{c.grounding}</p><p className="mt-2 break-words font-mono text-[10px] leading-5 text-accent-cyan">{selectedEvidence}</p><p className="mt-2 text-[11px] leading-5 text-muted">{c.groundingHint}</p></div></aside>
    </div>

    <section className="overflow-hidden rounded-3xl border border-ice/[0.08] bg-card/[0.02]" aria-labelledby="finance-breakdown-title"><div className="flex flex-col gap-3 border-b border-ice/[0.07] px-5 py-4 sm:flex-row sm:items-end sm:justify-between"><div><h2 id="finance-breakdown-title" className="text-lg font-bold text-text">{c.breakdown}</h2><p className="mt-1 text-xs text-muted">{c.breakdownHint}</p></div><div className="flex rounded-xl border border-ice/[0.08] bg-bg/30 p-1">{(['all', 'inflow', 'outflow'] as const).map((item) => <button key={item} type="button" onClick={() => setFilter(item)} className={cn('rounded-lg px-3 py-1.5 text-[11px] font-semibold transition', filter === item ? 'bg-panel text-text shadow-soft' : 'text-fog hover:text-text')}>{item === 'all' ? c.all : item === 'inflow' ? c.income : c.expenses}</button>)}</div></div><div className="overflow-x-auto"><table className="w-full min-w-[860px] text-left"><thead><tr className="border-b border-ice/[0.06] text-[9px] uppercase tracking-[0.12em] text-fog"><th className="px-5 py-3">{c.date}</th><th className="px-3 py-3">{c.operation}</th><th className="px-3 py-3">{c.category}</th><th className="px-3 py-3 text-right">{c.amount}</th><th className="px-5 py-3">{c.source}</th></tr></thead><tbody>{filteredRows.map((row) => <tr key={row.id} className="border-b border-ice/[0.05] last:border-0"><td className="px-5 py-3.5 font-mono text-[10px] text-fog">{row.date}</td><td className="px-3 py-3.5"><p className="text-xs font-semibold text-text">{row.description}</p><p className="mt-0.5 text-[10px] text-fog">{row.counterparty}</p></td><td className="px-3 py-3.5"><span className="rounded-md border border-ice/[0.07] bg-bg/35 px-2 py-1 text-[10px] text-muted">{row.category}</span></td><td className={cn('px-3 py-3.5 text-right font-mono text-xs font-semibold tabular-nums', row.direction === 'inflow' ? 'text-teal' : 'text-text')}>{row.direction === 'inflow' ? '+' : '−'}{formatMoney(row.amountMinor, analysis.currency)}</td><td className="px-5 py-3.5"><button type="button" onClick={() => setSelectedEvidence(`${row.sourceId} · ${row.locator}`)} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 font-mono text-[9px] text-accent-cyan transition hover:bg-accent-cyan/[0.06]"><Link2 size={10} />{row.locator}</button></td></tr>)}</tbody></table>{!filteredRows.length && <p className="px-5 py-12 text-center text-sm text-muted">{c.noRows}</p>}</div></section>

    <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.55fr)]" aria-labelledby="finance-ingestion-title"><div className="rounded-3xl border border-ice/[0.08] bg-panel/40 p-5"><div className="flex items-start gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-indigo/10 text-accent-indigo"><UploadCloud size={18} /></span><div><h2 id="finance-ingestion-title" className="text-lg font-bold text-text">{c.ingestion}</h2><p className="mt-1 max-w-2xl text-xs leading-5 text-muted">{c.ingestionHint}</p></div></div><button type="button" onClick={() => inputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event: DragEvent<HTMLButtonElement>) => { event.preventDefault(); void acceptFiles(event.dataTransfer.files) }} className="group mt-5 flex w-full flex-col items-center justify-center rounded-2xl border border-dashed border-ice/[0.14] bg-bg/30 px-5 py-9 text-center transition hover:border-accent-cyan/35 hover:bg-accent-cyan/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/35"><UploadCloud size={28} className="text-ice/30 transition group-hover:-translate-y-0.5 group-hover:text-accent-cyan" /><span className="mt-3 text-sm font-semibold text-text">{c.drop}</span><span className="mt-1 text-xs text-muted">{c.choose}</span><span className="mt-3 font-mono text-[9px] text-fog">{c.limits}</span></button><input ref={inputRef} type="file" multiple accept=".csv,.json,text/csv,application/json" className="hidden" onChange={(event: ChangeEvent<HTMLInputElement>) => { if (event.target.files) void acceptFiles(event.target.files); event.target.value = '' }} /><div className="mt-3 space-y-2">{fileNames.map((name, index) => <div key={`${name}-${index}`} className="flex items-center gap-2 rounded-xl border border-ice/[0.07] bg-bg/25 px-3 py-2"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-cyan/[0.07] text-accent-cyan">{name.endsWith('.csv') ? <FileSpreadsheet size={14} /> : <FileJson size={14} />}</span><span className="min-w-0 flex-1 truncate text-xs text-text">{name}</span><Check size={13} className="text-teal" /><button type="button" onClick={() => removeFile(index)} className="rounded-md p-1 text-fog hover:bg-danger/[0.07] hover:text-danger" aria-label={`Remove ${name}`}><X size={13} /></button></div>)}</div>{error && <p role="alert" className="mt-3 rounded-xl border border-danger/20 bg-danger/[0.06] px-3 py-2 text-xs text-danger">{error}</p>}</div><aside className="rounded-3xl border border-ice/[0.08] bg-card/[0.025] p-5"><div className="flex items-center gap-2"><Landmark size={17} className="text-accent-cyan" /><h3 className="font-bold text-text">Analysis scope</h3></div><label className="mt-5 block text-[10px] font-semibold tracking-wide text-fog">Period<input type="month" value={period} onChange={(event) => setPeriod(event.target.value)} className="mt-1.5 w-full rounded-xl border border-ice/[0.09] bg-bg/45 px-3 py-2.5 text-sm text-text outline-none focus:border-accent-cyan/35" /></label><label className="mt-4 block text-[10px] font-semibold tracking-wide text-fog">Opening balance, UZS<input inputMode="decimal" value={openingBalance} onChange={(event) => setOpeningBalance(event.target.value.replace(/[^0-9.]/g, ''))} className="mt-1.5 w-full rounded-xl border border-ice/[0.09] bg-bg/45 px-3 py-2.5 font-mono text-sm text-text outline-none focus:border-accent-cyan/35" /></label><button type="button" onClick={() => void analyze()} disabled={loading || !sources.length} className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-accent-cyan px-4 py-3 text-sm font-bold text-bg transition hover:brightness-105 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45">{loading ? <Loader2 size={16} className="animate-spin" /> : <BanknoteArrowDown size={16} />}{loading ? c.analyzing : c.analyze}</button><button type="button" onClick={() => { setAnalysis(PREVIEW_ANALYSIS); setRows(PREVIEW_TRANSACTIONS); setSources([]); setFileNames([]); setIsPreview(true); setError('') }} className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2 text-xs text-muted transition hover:bg-white/[0.04] hover:text-text"><RotateCcw size={13} />Reset demo</button></aside></section>

    <section aria-labelledby="finance-orders-title"><div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between"><div><h2 id="finance-orders-title" className="text-xl font-bold tracking-tight text-text">{c.orders}</h2><p className="mt-1 text-sm text-muted">{c.ordersHint}</p></div><span className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-amber/20 bg-amber/[0.05] px-2.5 py-1.5 text-[10px] font-semibold text-amber"><ReceiptText size={12} />{c.gate}</span></div><div className="mt-4 grid gap-4 lg:grid-cols-2">{PREVIEW_ORDERS.map((draft) => { const decision = decisions[draft.id] ?? 'pending'; return <article key={draft.id} className="rounded-2xl border border-ice/[0.08] bg-card/[0.025] p-5"><div className="flex items-start justify-between gap-3"><div><span className="text-[9px] font-bold uppercase tracking-[0.12em] text-accent-cyan">{draft.type}</span><h3 className="mt-2 text-base font-bold text-text">{draft.title}</h3><p className="mt-1 text-xs text-muted">{draft.subject} · {draft.effectiveDate}</p></div><span className={cn('shrink-0 rounded-md border px-2 py-1 text-[9px] font-semibold', decision === 'approved' ? 'border-teal/20 bg-teal/[0.07] text-teal' : decision === 'rejected' ? 'border-danger/20 bg-danger/[0.07] text-danger' : 'border-amber/20 bg-amber/[0.06] text-amber')}>{c[decision]}</span></div><ol className="mt-4 space-y-2">{draft.clauses.map((clause, index) => <li key={clause} className="flex gap-2 text-xs leading-5 text-muted"><span className="font-mono text-[10px] text-fog">0{index + 1}</span><span>{clause}</span></li>)}</ol><button type="button" onClick={() => setSelectedEvidence(draft.source)} className="mt-4 inline-flex items-center gap-1.5 font-mono text-[9px] text-accent-cyan"><Link2 size={10} />{draft.source}</button><p className="mt-4 border-t border-ice/[0.06] pt-3 text-[10px] leading-4 text-fog">{c.draftNote}</p><div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => decide(draft.id, 'approved')} className="inline-flex items-center gap-1.5 rounded-lg border border-teal/20 bg-teal/[0.06] px-3 py-2 text-[11px] font-semibold text-teal transition hover:bg-teal/[0.11]"><Check size={13} />{c.approve}</button><button type="button" onClick={() => decide(draft.id, 'rejected')} className="inline-flex items-center gap-1.5 rounded-lg border border-danger/20 bg-danger/[0.05] px-3 py-2 text-[11px] font-semibold text-danger transition hover:bg-danger/[0.1]"><X size={13} />{c.reject}</button><button type="button" onClick={() => exportDraft(draft)} className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-ice/[0.09] px-3 py-2 text-[11px] font-semibold text-muted transition hover:bg-white/[0.04] hover:text-text"><Download size={13} />{c.export}</button></div></article> })}</div></section>
  </section>
}

function MetricCard({ icon: Icon, label, value, detail, tone }: { icon: typeof Landmark; label: string; value: string; detail?: string; tone: 'teal' | 'amber' | 'cyan' | 'violet' | 'danger' }) {
  const tones = { teal: 'bg-teal/10 text-teal', amber: 'bg-amber/10 text-amber', cyan: 'bg-accent-cyan/10 text-accent-cyan', violet: 'bg-violet/10 text-violet', danger: 'bg-danger/10 text-danger' }
  return <article className="rounded-2xl border border-ice/[0.08] bg-card/[0.025] p-4 transition hover:-translate-y-0.5 hover:border-ice/[0.14]"><div className="flex items-start justify-between"><span className={cn('flex h-9 w-9 items-center justify-center rounded-xl', tones[tone])}><Icon size={16} /></span><ChevronDown size={13} className="text-ice/20" /></div><p className="mt-5 text-[10px] font-semibold tracking-wide text-fog">{label}</p><p className="mt-1 truncate text-xl font-extrabold tracking-tight text-text tabular-nums" title={value}>{value}</p>{detail && <p className="mt-1 font-mono text-[9px] text-muted">{detail}</p>}</article>
}
