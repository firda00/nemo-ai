// Margin report as a CHAT artifact: the attachment the user just sent becomes a deterministic
// per-product margin report with downloads, right in the dialogue.
//
// Two transports, one card:
//   • live (Supabase session): the file goes ONCE to the margin-report edge function as raw
//     bytes; the server retains it, so the currency clarification round sends only the sha —
//     never a re-upload. Downloads are short-TTL signed URLs from the private bucket.
//   • demo (no backend): the SAME engine runs locally (worker parse under a deadline), and the
//     original File object is re-read for the clarification — again, no re-upload to anywhere.
//
// The response/summary here is aggregates + top products only; nothing row-level enters any
// model history (this flow is deterministic UI↔function, no LLM sees it).
import { Download, FileSpreadsheet, Loader2, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useI18n } from '../../i18n'
import { callBoundedFunction } from '../../lib/boundedBriefingCall'
import { createFileRunCache, createSessionScope } from '../../lib/marginRunCache'
import { isSupabaseEnabled, supabase } from '../../lib/supabase'
import { parseXlsxInWorker } from '../../lib/xlsxParseClient'
import { runMarginPipeline } from '../../lib/marginUpload'
import { formatCents, type MarginReport } from '../../lib/productMargin'
import { marginReportToCsv, marginReportToHtml, marginReportToXlsx } from '../../lib/marginReportExport'
import type { Lang } from '../../types'

const COPY: Record<Lang, Record<string, string>> = {
  ru: {
    title: 'Маржа по товарам', busy: 'Считаю отчёт…', askCurrency: 'В файле не указана валюта. В какой валюте суммы?',
    complete: 'Итоги полные', incomplete: 'Итоги НЕПОЛНЫЕ', reasons: 'Причины',
    revenue: 'Выручка', margin: 'Маржа (по покрытым строкам)', top: 'Топ товаров по марже', partial: 'частично',
    downloads: 'Отчёт для скачивания', linksExpire: 'Ссылки действуют 10 минут.', refreshLinks: 'Обновить ссылки',
    localNote: 'Отчёт посчитан локально в браузере — файл никуда не отправлялся.',
    err_generic: 'Не удалось построить отчёт по этому файлу.', err_not_xlsx: 'Для отчёта о марже нужен файл .xlsx.',
    err_file_empty: 'Файл пуст.', err_too_big: 'Файл отклонён: превышены безопасные лимиты размера.',
    err_rows: 'Файл отклонён: слишком много строк для точного отчёта.',
    err_bad_archive: 'Файл повреждён или не является корректным .xlsx.',
    err_no_sheets: 'Не найдено ни одного листа с распознаваемой шапкой (нужны колонки товара, выручки и себестоимости).',
    err_timeout: 'Расчёт превысил лимит времени. Попробуйте ещё раз.',
    err_mixed_currency: 'В файле несколько валют — отчёт не построен: ',
    err_currency_mismatch: 'Валюта в файле не совпадает с выбранной: ',
    err_unavailable: 'Сервис отчёта недоступен. Попробуйте позже.',
    err_unauthorized: 'Нужен вход в систему, чтобы построить отчёт по загруженному файлу.',
    staleIdentity: 'Сессия изменилась. Отчёт скрыт; прикрепите файл заново, чтобы построить его для текущего аккаунта.',
    registryWarn: 'Файл не попал в список источников месячных отчётов.',
    registryRetry: 'Повторить регистрацию',
  },
  uz: {
    title: 'Mahsulotlar marjasi', busy: 'Hisobot hisoblanmoqda…', askCurrency: 'Faylda valyuta ko‘rsatilmagan. Summalar qaysi valyutada?',
    complete: 'Yakunlar to‘liq', incomplete: 'Yakunlar TO‘LIQ EMAS', reasons: 'Sabablari',
    revenue: 'Tushum', margin: 'Marja (qoplangan qatorlar bo‘yicha)', top: 'Marja bo‘yicha top mahsulotlar', partial: 'qisman',
    downloads: 'Yuklab olish uchun hisobot', linksExpire: 'Havolalar 10 daqiqa amal qiladi.', refreshLinks: 'Havolalarni yangilash',
    localNote: 'Hisobot brauzerda lokal hisoblandi — fayl hech qayerga yuborilmadi.',
    err_generic: 'Bu fayl bo‘yicha hisobot tuzib bo‘lmadi.', err_not_xlsx: 'Marja hisoboti uchun .xlsx fayl kerak.',
    err_file_empty: 'Fayl bo‘sh.', err_too_big: 'Fayl rad etildi: xavfsiz hajm chegarasi oshib ketdi.',
    err_rows: 'Fayl rad etildi: aniq hisobot uchun qatorlar juda ko‘p.',
    err_bad_archive: 'Fayl buzilgan yoki to‘g‘ri .xlsx emas.',
    err_no_sheets: 'Taniladigan sarlavhali varaq topilmadi (mahsulot, tushum va tannarx ustunlari kerak).',
    err_timeout: 'Hisoblash vaqt chegarasidan oshdi. Yana urinib ko‘ring.',
    err_mixed_currency: 'Faylda bir nechta valyuta bor — hisobot tuzilmadi: ',
    err_currency_mismatch: 'Fayldagi valyuta tanlangan bilan mos emas: ',
    err_unavailable: 'Hisobot xizmati hozircha ishlamayapti. Keyinroq urinib ko‘ring.',
    err_unauthorized: 'Yuklangan fayl bo‘yicha hisobot uchun tizimga kirish kerak.',
    staleIdentity: 'Sessiya o‘zgardi. Hisobot yashirildi; joriy akkaunt uchun faylni qaytadan biriktiring.',
    registryWarn: 'Fayl oylik hisobot manbalari ro‘yxatiga tushmadi.',
    registryRetry: 'Ro‘yxatga qayta urinish',
  },
  en: {
    title: 'Product margin', busy: 'Computing the report…', askCurrency: 'The file does not declare a currency. Which currency are the amounts in?',
    complete: 'Totals are complete', incomplete: 'Totals are PARTIAL', reasons: 'Reasons',
    revenue: 'Revenue', margin: 'Margin (covered rows)', top: 'Top products by margin', partial: 'partial',
    downloads: 'Downloadable report', linksExpire: 'Links stay valid for 10 minutes.', refreshLinks: 'Refresh links',
    localNote: 'Computed locally in your browser — the file was not sent anywhere.',
    err_generic: 'Could not build a report from this file.', err_not_xlsx: 'The margin report needs an .xlsx file.',
    err_file_empty: 'The file is empty.', err_too_big: 'File rejected: safe size limits exceeded.',
    err_rows: 'File rejected: too many rows for an exact report.',
    err_bad_archive: 'The file is corrupt or not a valid .xlsx.',
    err_no_sheets: 'No sheet with a recognizable header was found (product, revenue and cost columns are required).',
    err_timeout: 'The computation exceeded its time limit. Please try again.',
    err_mixed_currency: 'The file mixes currencies — no report was built: ',
    err_currency_mismatch: 'The file currency does not match the selected one: ',
    err_unavailable: 'The report service is unavailable. Please try again later.',
    err_unauthorized: 'You need to be signed in to build a report from an uploaded file.',
    staleIdentity: 'The session changed. The report is hidden; re-attach the file to build it for the current account.',
    registryWarn: 'The file did not land in the monthly-report source list.',
    registryRetry: 'Retry registration',
  },
}

const CURRENCIES = ['UZS', 'USD', 'RUB', 'EUR'] as const
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024
const LIVE_CALL_TIMEOUT_MS = 120_000 // the server's own budget is 110s — the client waits it out
const DEMO_DEADLINE_MS = 25_000

const REASON_KEY: Record<string, string> = {
  bad_archive: 'err_bad_archive', archive_too_large: 'err_too_big', entry_too_large: 'err_too_big',
  too_many_entries: 'err_too_big', too_many_shared_strings: 'err_too_big',
  sheet_rows_over_limit: 'err_rows', workbook_rows_over_limit: 'err_rows',
  not_xlsx: 'err_not_xlsx', parse_timeout: 'err_timeout', worker_failed: 'err_timeout',
  no_recognized_sheets: 'err_no_sheets', amount_overflow: 'err_rows',
  file_too_large: 'err_too_big', empty_file: 'err_file_empty', timeout: 'err_timeout',
  unauthorized: 'err_unauthorized', owner_required: 'err_unauthorized',
}

type LiveSummary = {
  currency: string
  totalsComplete: boolean
  completenessReasons: string[]
  totals: {
    revenue: string; costComplete: string; marginComplete: string
    marginPctComplete: number | null; rowsComplete: number; rowsTotal: number; returnsCount: number
  }
  topProducts: Array<{ name: string; sku: string | null; coveredMargin: string; coveredMarginPct: number | null; complete: boolean }>
}
type LiveFiles = Record<string, { url: string; expires_in_seconds: number }>

type CardState =
  | { phase: 'busy' }
  | { phase: 'ask_currency'; fileSha256: string | null; detail: string | null; registrySaved: boolean }
  | { phase: 'live_done'; summary: LiveSummary; files: LiveFiles; fileSha256: string; currency: string; registrySaved: boolean }
  | { phase: 'demo_done'; report: MarginReport }
  | { phase: 'error'; message: string }

// React Strict Mode дважды запускает эффекты в разработке; один и тот же turn обязан отправить
// файл на сервер ровно один раз. Кэш ключуется САМИМ объектом File (WeakMap) и областью
// сессии/арендатора: чужому аккаунту и «файлу-тёзке» с тем же именем и размером попадание
// невозможно, а записи живут ровно столько, сколько сам File в состоянии чата (история
// обрезается slice(-8) на каждом сообщении, размонтирование сбрасывает её целиком).
// Область сессии — С ПОКОЛЕНИЕМ: выход и повторный вход ТЕМ ЖЕ пользователем даёт новую
// область, старые записи (в т.ч. подписанные ссылки) не воскресают.
const marginRuns = createFileRunCache<CardState>()
const marginScope = createSessionScope()

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

async function runLive(file: File, currency: string | null, fileSha256: string | null, copy: Record<string, string>): Promise<CardState> {
  if (!supabase) return { phase: 'error', message: copy.err_unavailable }
  const invoke = fileSha256
    // clarification / refresh round: only the sha travels — the server reuses the RETAINED file
    ? () => supabase!.functions.invoke('margin-report', { body: { file_sha256: fileSha256, currency } })
    : () => supabase!.functions.invoke('margin-report', {
      body: file, // Blob body → application/octet-stream; the wrapper streams it under a cap
      headers: {
        'x-file-name': encodeURIComponent(file.name),
        ...(currency ? { 'x-currency': currency } : {}),
      },
    })
  const { ok, payload } = await callBoundedFunction(invoke, LIVE_CALL_TIMEOUT_MS)
  const body = (payload ?? {}) as Record<string, unknown>
  // false ONLY when the server explicitly said so — older responses without the field stay quiet
  const registrySaved = body.registry_saved !== false
  if (body.ok === true && body.needs_currency === true) {
    return { phase: 'ask_currency', fileSha256: typeof body.file_sha256 === 'string' ? body.file_sha256 : null, detail: typeof body.detail === 'string' ? body.detail : null, registrySaved }
  }
  if (ok && body.ok === true && body.summary && body.files) {
    return {
      phase: 'live_done',
      summary: body.summary as LiveSummary,
      files: body.files as LiveFiles,
      fileSha256: String(body.file_sha256 ?? ''),
      currency: (body.summary as LiveSummary).currency,
      registrySaved,
    }
  }
  const reason = typeof body.error === 'string' ? body.error : ''
  const detail = typeof body.detail === 'string' ? body.detail : ''
  if (reason === 'mixed_currency') return { phase: 'error', message: copy.err_mixed_currency + detail }
  if (reason === 'currency_mismatch') return { phase: 'error', message: copy.err_currency_mismatch + detail }
  const key = REASON_KEY[reason]
  if (key) return { phase: 'error', message: copy[key] }
  return { phase: 'error', message: reason ? copy.err_generic : copy.err_unavailable }
}

async function runDemo(file: File, currency: string | null, copy: Record<string, string>): Promise<CardState> {
  const result = await runMarginPipeline({
    readBuffer: () => file.arrayBuffer(),
    hash: async (buffer) => {
      const digest = await crypto.subtle.digest('SHA-256', buffer)
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    },
    parse: (buffer, timeoutMs) => parseXlsxInWorker(buffer, timeoutMs),
  }, { currency, fileName: file.name, deadlineMs: DEMO_DEADLINE_MS })
  if (result.ok) return { phase: 'demo_done', report: result.report }
  if (result.reason === 'needs_currency') return { phase: 'ask_currency', fileSha256: null, detail: result.detail ?? null, registrySaved: true }
  if (result.reason === 'mixed_currency') return { phase: 'error', message: copy.err_mixed_currency + (result.detail ?? '') }
  if (result.reason === 'currency_mismatch') return { phase: 'error', message: copy.err_currency_mismatch + (result.detail ?? '') }
  return { phase: 'error', message: copy[REASON_KEY[result.reason] ?? 'err_generic'] }
}

export function MarginChatCard({ runKey, file }: { runKey: number; file: File }) {
  const { lang } = useI18n()
  const { user } = useAuth()
  const copy = COPY[lang]
  const live = isSupabaseEnabled && !!supabase
  const [state, setState] = useState<CardState>({ phase: 'busy' })
  const opRef = useRef(0)
  const aliveRef = useRef(true)
  // the scope is the tenant/SESSION identity of the cache (generation-stamped: logout + login
  // as the same user is a NEW scope). An identity change while this card is mounted:
  //   • makes every cached entry a miss and invalidates any still-in-flight callback below;
  //   • blanks the rendered card (see identityChanged): an already-shown report and its signed
  //     URLs must not stay on screen for the next user, and the old user's File is NEVER
  //     auto-uploaded to the new account — the card asks to re-attach instead.
  const scope = marginScope(user?.id ?? null)
  const [mountScope] = useState(scope)
  const identityChanged = scope !== mountScope
  const scopeRef = useRef(scope)
  useEffect(() => { scopeRef.current = scope }, [scope])

  // every state update lands in a promise callback (the mount state is already 'busy'), so
  // the mount effect performs no synchronous setState
  const begin = (currency: string | null, fileSha256: string | null, dedupe: boolean) => {
    const opId = ++opRef.current
    const scopeAtStart = scopeRef.current
    const execute = async (): Promise<CardState> => {
      // file-safety gates BEFORE any byte is read, hashed or sent
      if (!/\.xlsx$/i.test(file.name)) return { phase: 'error', message: copy.err_not_xlsx }
      if (file.size === 0) return { phase: 'error', message: copy.err_file_empty }
      if (file.size > MAX_UPLOAD_BYTES) return { phase: 'error', message: copy.err_too_big }
      return live ? runLive(file, currency, fileSha256, copy) : runDemo(file, currency, copy)
    }
    const guarded = () => execute().catch((): CardState => ({ phase: 'error', message: copy.err_generic }))
    // the initial upload is deduplicated across Strict-Mode double effects — keyed by the File
    // OBJECT and the session scope, so remounts and other tenants can never hit a stale entry;
    // interactive rounds (currency picks, link refreshes) run directly — they are user gestures
    const run = dedupe ? marginRuns.getOrRun(file, scopeAtStart, guarded) : guarded()
    void run.then((next) => {
      // a late completion must not touch state after unmount, after a newer round, or after
      // the signed-in identity changed under it
      if (aliveRef.current && opId === opRef.current && scopeRef.current === scopeAtStart) setState(next)
    })
  }

  const restart = (currency: string | null, fileSha256: string | null) => {
    setState({ phase: 'busy' })
    begin(currency, fileSha256, false)
  }

  useEffect(() => {
    aliveRef.current = true
    begin(null, null, true)
    return () => { aliveRef.current = false }
    // reacts only to the turn identity — the card runs once per chat turn
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey])

  const base = file.name.replace(/\.xlsx$/i, '') || 'margin'
  const shaFor = (s: CardState) => s.phase === 'ask_currency' ? s.fileSha256 : s.phase === 'live_done' ? s.fileSha256 : null

  return <section className="mt-3 overflow-hidden rounded-2xl border border-teal/20 bg-bg/40">
    <div className="flex items-center gap-3 border-b border-ice/[0.07] px-4 py-3">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal/10 text-teal"><FileSpreadsheet size={16} /></span>
      <div className="min-w-0 flex-1">
        <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-fog">{copy.title}</p>
        <p className="truncate text-sm font-bold text-text">{file.name}</p>
      </div>
    </div>
    <div className="space-y-3 p-4 text-sm text-text">
      {identityChanged && <p role="status" className="text-xs leading-5 text-amber">{copy.staleIdentity}</p>}
      {!identityChanged && <>
      {state.phase === 'busy' && <p className="flex items-center gap-2 text-muted"><Loader2 size={14} className="animate-spin" />{copy.busy}</p>}

      {state.phase === 'error' && <p role="status" className="text-xs leading-5 text-amber">{state.message}</p>}

      {(state.phase === 'ask_currency' || state.phase === 'live_done') && !state.registrySaved && state.fileSha256 && (
        <p role="status" className="rounded-xl border border-amber/30 bg-amber/10 px-3 py-2 text-[11px] leading-4 text-amber">
          {copy.registryWarn}{' '}
          <button type="button" onClick={() => restart(state.phase === 'live_done' ? state.currency : null, state.fileSha256)} className="font-semibold underline">{copy.registryRetry}</button>
        </p>
      )}
      {state.phase === 'ask_currency' && <div>
        <p className="text-xs leading-5 text-muted">{copy.askCurrency}{state.detail ? ` (${state.detail})` : ''}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {CURRENCIES.map((code) => <button key={code} type="button"
            onClick={() => restart(code, shaFor(state))}
            className="rounded-xl border border-ice/10 bg-black/15 px-3 py-2 text-xs font-semibold text-text transition hover:border-teal/40">{code}</button>)}
        </div>
      </div>}

      {state.phase === 'live_done' && <LiveSummaryView summary={state.summary} files={state.files} copy={copy}
        onRefresh={() => restart(state.currency, state.fileSha256)} />}

      {state.phase === 'demo_done' && <DemoReportView report={state.report} base={base} copy={copy} />}
      </>}
    </div>
  </section>
}

function SummaryHeader({ complete, reasons, copy }: { complete: boolean; reasons: string[]; copy: Record<string, string> }) {
  return <p className={complete ? 'font-semibold text-teal' : 'font-semibold text-amber'}>
    {complete ? copy.complete : `${copy.incomplete} — ${copy.reasons}: ${reasons.join('; ')}`}
  </p>
}

function LiveSummaryView({ summary, files, copy, onRefresh }: { summary: LiveSummary; files: LiveFiles; copy: Record<string, string>; onRefresh: () => void }) {
  const labels: Record<string, string> = { csv: 'CSV', xlsx: 'XLSX', html: 'HTML' }
  return <>
    <SummaryHeader complete={summary.totalsComplete} reasons={summary.completenessReasons} copy={copy} />
    <p className="text-xs text-muted">
      {copy.revenue}: <b className="text-text">{summary.totals.revenue} {summary.currency}</b> · {copy.margin}: <b className="text-text">{summary.totals.marginComplete} {summary.currency}</b>
      {summary.totals.marginPctComplete === null ? '' : ` (${summary.totals.marginPctComplete}%)`} · {summary.totals.rowsComplete}/{summary.totals.rowsTotal}
    </p>
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{copy.top}</p>
      <ul className="space-y-1 text-xs leading-5">
        {summary.topProducts.map((product) => <li key={`${product.sku ?? ''}|${product.name}`} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{product.name}{product.sku ? ` · ${product.sku}` : ''}</span>
          <span className="font-variant-numeric tabular-nums">{product.coveredMargin}</span>
          <span className="text-muted">{product.coveredMarginPct === null ? '—' : `${product.coveredMarginPct}%`}</span>
          {!product.complete && <span className="text-amber">⚠ {copy.partial}</span>}
        </li>)}
      </ul>
    </div>
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{copy.downloads}</p>
      <div className="flex flex-wrap items-center gap-2">
        {(['csv', 'xlsx', 'html'] as const).filter((key) => files[key]?.url).map((key) =>
          <a key={key} href={files[key].url} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-xl border border-ice/10 px-3 py-2 text-xs font-semibold text-text hover:bg-white/5"><Download size={13} />{labels[key]}</a>)}
        <button type="button" onClick={onRefresh} className="inline-flex items-center gap-1.5 rounded-xl border border-ice/10 px-3 py-2 text-xs font-semibold text-muted hover:bg-white/5 hover:text-text"><RefreshCw size={13} />{copy.refreshLinks}</button>
      </div>
      <p className="mt-1 text-[10px] text-fog">{copy.linksExpire}</p>
    </div>
  </>
}

function DemoReportView({ report, base, copy }: { report: MarginReport; base: string; copy: Record<string, string> }) {
  return <>
    <SummaryHeader complete={report.totalsComplete} reasons={report.completenessReasons} copy={copy} />
    <p className="text-xs text-muted">
      {copy.revenue}: <b className="text-text">{formatCents(report.totals.revenueCents)} {report.currency}</b> · {copy.margin}: <b className="text-text">{formatCents(report.totals.marginCentsComplete)} {report.currency}</b>
      {report.totals.marginPctComplete === null ? '' : ` (${report.totals.marginPctComplete}%)`} · {report.totals.rowsComplete}/{report.totals.rowsTotal}
    </p>
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{copy.top}</p>
      <ul className="space-y-1 text-xs leading-5">
        {report.products.slice(0, 3).map((product) => <li key={`${product.sku ?? ''}|${product.name}`} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{product.name}{product.sku ? ` · ${product.sku}` : ''}</span>
          <span className="font-variant-numeric tabular-nums">{formatCents(product.coveredMarginCents)}</span>
          <span className="text-muted">{product.coveredMarginPct === null ? '—' : `${product.coveredMarginPct}%`}</span>
          {!product.complete && <span className="text-amber">⚠ {copy.partial}</span>}
        </li>)}
      </ul>
    </div>
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{copy.downloads}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => download(`${base}-margin.csv`, 'text/csv;charset=utf-8', '\uFEFF' + marginReportToCsv(report))} className="inline-flex items-center gap-1.5 rounded-xl border border-ice/10 px-3 py-2 text-xs font-semibold text-text hover:bg-white/5"><Download size={13} />CSV</button>
        <button type="button" onClick={() => download(`${base}-margin.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', marginReportToXlsx(report))} className="inline-flex items-center gap-1.5 rounded-xl border border-ice/10 px-3 py-2 text-xs font-semibold text-text hover:bg-white/5"><Download size={13} />XLSX</button>
        <button type="button" onClick={() => download(`${base}-margin.html`, 'text/html;charset=utf-8', marginReportToHtml(report))} className="inline-flex items-center gap-1.5 rounded-xl border border-ice/10 px-3 py-2 text-xs font-semibold text-text hover:bg-white/5"><Download size={13} />HTML</button>
      </div>
      <p className="mt-1 text-[10px] text-fog">{copy.localNote}</p>
    </div>
  </>
}
