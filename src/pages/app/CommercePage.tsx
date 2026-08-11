import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Database, RefreshCw, Search, Upload, Wand2 } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { CommerceSkuTable, type CommerceSku } from '../../components/platform/CommerceSkuTable'
import { CommerceListingAgent, type CategoryChoice, type ListingDraft, type ManualFees } from '../../components/platform/CommerceListingAgent'
import { type CategoryLabel } from '../../lib/categoryLabel'
import { PaywallDialog } from '../../components/ui/PaywallDialog'
import { payloadOf, paywallFrom, type Paywall } from '../../lib/paywall'
import { CommerceFindings, type Finding } from '../../components/platform/CommerceFindings'
import { extractText } from '../../lib/extractText'
import { isSupabaseEnabled, supabase } from '../../lib/supabase'
import { useI18n } from '../../i18n'

type Catalog = { id: string; name: string; source: string; external_shop_id: string | null; status: string; last_synced_at: string | null; last_sync_error: string | null }
type Pilot = { status: string; started_at: string | null; expires_at: string | null; read_only_at: string | null }
type Proposal = { id: string; source: string; sku_id: string | null; catalog_id: string | null; unit_cost_tiyin: number | null; lead_time_days: number | null; min_margin_percent: number | null; commission_percent: number | null; fulfillment_tiyin: number | null; returns_reserve_percent: number | null; commerce_skus?: { title: string; external_sku: string } | null }
type Batch = { id: string; status: string; total_rows: number; valid_rows: number; unmatched_rows: number; error_rows: number; created_at: string }

const headers = ['external_sku', 'unit_cost_uzs', 'commission_percent', 'fulfillment_uzs', 'returns_reserve_percent', 'lead_time_days', 'moq', 'safety_stock', 'min_margin_percent'] as const

function parseDelimited(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += char; i++ } else quoted = !quoted
    } else if (!quoted && char === ',') { row.push(cell.trim()); cell = ''
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[i + 1] === '\n') i++
      row.push(cell.trim()); cell = ''
      if (row.some(Boolean)) rows.push(row)
      row = []
    } else cell += char
  }
  row.push(cell.trim())
  if (row.some(Boolean)) rows.push(row)
  return rows
}

function toTiyin(value: string): number | string {
  const normalized = value.replace(/[\s\u00a0]/g, '').replace(',', '.')
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return value
  return Math.round(Number(normalized) * 100)
}

async function hashFile(file: File) {
  const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export default function CommercePage() {
  const { t } = useI18n()
  const [pilot, setPilot] = useState<Pilot | null>(null)
  const [catalogs, setCatalogs] = useState<Catalog[]>([])
  const [catalogId, setCatalogId] = useState('')
  const [batches, setBatches] = useState<Batch[]>([])
  const [loading, setLoading] = useState(isSupabaseEnabled)
  const [telegramConnected, setTelegramConnected] = useState(false)
  // Какой бот обслуживает этот магазин. Связь жила только в базе: имя агента ей вдобавок врало —
  // «Создай AI-команду для управления магазином» звучит как нужный бот и им не является.
  const [notifyBot, setNotifyBot] = useState<string | null>(null)
  const [telegramLink, setTelegramLink] = useState<string | null>(null)
  const [skus, setSkus] = useState<CommerceSku[]>([])
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [drafts, setDrafts] = useState<ListingDraft[]>([])
  const [findings, setFindings] = useState<Finding[]>([])
  const [categories, setCategories] = useState<CategoryChoice[]>([])
  const [categoryLabels, setCategoryLabels] = useState<Record<string, CategoryLabel>>({})
  const [paywall, setPaywall] = useState<Paywall | null>(null)
  const [marginInput, setMarginInput] = useState('20')
  const [busy, setBusy] = useState<'start' | 'discover' | 'stage' | 'autofill' | 'connect' | 'fees' | 'margin' | 'sync' | 'proposal' | 'onboard' | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  // Одиннадцать карточек подряд — это не страница, а лента. Разложены по четырём вкладкам, но с
  // одним правилом: вкладка ПРЯЧЕТ, а тревожное прятать нельзя. Поэтому выводы и сбои синка
  // остаются в «Обзоре», а то, что ждёт решения на других вкладках, помечено счётчиком на
  // корешке. Иначе получится ровно тот дефект, который мы ловили весь день: существует, а дойти
  // нельзя.
  const [tab, setTab] = useState<'overview' | 'costs' | 'listing' | 'settings'>('overview')

  const loadSkus = useCallback(async (selectedCatalogId: string) => {
    if (!supabase || !selectedCatalogId) { setSkus([]); return }
    const { data } = await supabase.functions.invoke('commerce-control', { body: { action: 'list_skus', catalog_id: selectedCatalogId } })
    const result = data as { ok?: boolean; skus?: CommerceSku[] } | null
    setSkus(result?.ok ? result.skus ?? [] : [])
  }, [])

  const loadProposals = useCallback(async () => {
    if (!supabase) { setProposals([]); return }
    const { data } = await supabase.functions.invoke('commerce-control', { body: { action: 'list_proposals' } })
    const result = data as { ok?: boolean; proposals?: Proposal[] } | null
    setProposals(result?.ok ? result.proposals ?? [] : [])
  }, [])

  // Принятое помечается локально, а не перезагрузкой списка: list_findings отдаёт только открытые,
  // и принятая находка исчезла бы из-под пальца — владелец не увидел бы подтверждения тому, что
  // сделал. Список обновится сам при следующем заходе.
  const [acceptedFindings, setAcceptedFindings] = useState<Set<string>>(new Set())
  const [acceptingFinding, setAcceptingFinding] = useState<string | null>(null)

  const acceptFinding = useCallback(async (recommendationId: string) => {
    if (!supabase) return
    setAcceptingFinding(recommendationId)
    const { data } = await supabase.functions.invoke('commerce-control', {
      body: { action: 'accept_finding', recommendation_id: recommendationId },
    })
    const result = data as { ok?: boolean } | null
    if (result?.ok) setAcceptedFindings((current) => new Set(current).add(recommendationId))
    setAcceptingFinding(null)
  }, [])

  const loadFindings = useCallback(async () => {
    if (!supabase) { setFindings([]); return }
    const { data } = await supabase.functions.invoke('commerce-control', { body: { action: 'list_findings' } })
    const result = data as { ok?: boolean; findings?: Finding[] } | null
    setFindings(result?.ok ? result.findings ?? [] : [])
  }, [])

  const loadDrafts = useCallback(async () => {
    if (!supabase) { setDrafts([]); return }
    const { data } = await supabase.functions.invoke('commerce-control', { body: { action: 'list_listing_drafts' } })
    const result = data as { ok?: boolean; drafts?: ListingDraft[]; categories?: CategoryChoice[]; category_labels?: Record<string, CategoryLabel> } | null
    setDrafts(result?.ok ? result.drafts ?? [] : [])
    // Полки приезжают со списком черновиков: черновик без категории переживает перезагрузку
    // страницы, а список из ответа на генерацию — нет.
    setCategories(result?.ok ? result.categories ?? [] : [])
    setCategoryLabels(result?.ok ? result.category_labels ?? {} : {})
  }, [])

  const load = useCallback(async (selectedCatalogId = catalogId) => {
    if (!supabase) { setLoading(false); return }
    const [statusResult, listResult] = await Promise.all([
      supabase.functions.invoke('commerce-control', { body: { action: 'status' } }),
      supabase.functions.invoke('commerce-control', { body: { action: 'list', ...(selectedCatalogId ? { catalog_id: selectedCatalogId } : {}) } }),
      loadSkus(selectedCatalogId),
      loadProposals(),
      loadDrafts(),
      loadFindings(),
    ])
    const status = statusResult.data as { ok?: boolean; pilot?: Pilot | null; catalogs?: Catalog[]; telegram_connected?: boolean; notify_bot?: string | null; error?: string } | null
    const list = listResult.data as { ok?: boolean; batches?: Batch[]; error?: string } | null
    if (statusResult.error || !status?.ok) setMessage({ ok: false, text: status?.error ?? statusResult.error?.message ?? t('commerce.errStatus') })
    else {
      const nextCatalogs = status.catalogs ?? []
       setPilot(status.pilot ?? null); setCatalogs(nextCatalogs); setTelegramConnected(Boolean(status.telegram_connected))
       setNotifyBot(status.notify_bot ?? null)
      if (!selectedCatalogId && nextCatalogs[0]) setCatalogId(nextCatalogs[0].id)
    }
    if (listResult.error || !list?.ok) setMessage({ ok: false, text: list?.error ?? listResult.error?.message ?? t('commerce.errImports') })
    else setBatches(list.batches ?? [])
    setLoading(false)
  }, [catalogId, loadSkus, loadProposals, loadDrafts, loadFindings])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const onboard = async () => {
    if (!supabase || busy) return
    setBusy('onboard'); setMessage(null)
    const { data, error } = await supabase.functions.invoke('commerce-control', { body: { action: 'onboard' } })
    const result = data as { ok?: boolean; shops?: number; queued?: number; error?: string } | null
    if (error || !result?.ok) {
      setMessage({ ok: false, text: result?.error ?? error?.message ?? t('commerce.onboard.err') })
      await load()
      setBusy(null)
      return
    }
    setMessage({ ok: true, text: t('commerce.onboard.ok').replace('{shops}', String(result.shops ?? 0)) })

    // The first sync runs in the background, so the page has to come back for the answer. Without
    // this the seller is told "results in a few minutes" by a screen that then never changes, and
    // the only way to find out is to guess when to reload. The button stays in its loading state
    // throughout, because work really is still happening.
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise((resolve) => window.setTimeout(resolve, 10_000))
      const { data: statusData } = await supabase.functions.invoke('commerce-control', { body: { action: 'status' } })
      const status = statusData as { ok?: boolean; catalogs?: Catalog[] } | null
      // Every catalogue has either finished a sync or reported why it could not.
      const settled = (status?.catalogs ?? []).filter((catalog) => catalog.status === 'active')
      if (settled.length && settled.every((catalog) => catalog.last_synced_at || catalog.last_sync_error)) break
    }
    await load()
    setBusy(null)
  }

  const draftListing = async (sourceText: string, category: string | null) => {
    if (!supabase) return false
    setMessage(null)
    const { data, error } = await supabase.functions.invoke('commerce-control', {
      body: { action: 'draft_listing', source_text: sourceText, ...(category ? { uzum_category: category } : {}), ...(catalogId ? { catalog_id: catalogId } : {}) },
    })
    // Тело отказа лежит НЕ в `data`: на любой не-2xx invoke возвращает FunctionsHttpError, а
    // исходный Response прячет в error.context. Без этого 402 выглядел бы как «не удалось
    // собрать черновик», и владелец не узнал бы, что дело в подписке.
    const payload = await payloadOf(error, data)
    const locked = paywallFrom(payload)
    if (locked) { setPaywall(locked); return false }
    const result = payload as { ok?: boolean; copy_available?: boolean; error?: string } | null
    if (error || !result?.ok) { setMessage({ ok: false, text: result?.error ?? error?.message ?? t('commerce.listing.errCreate') }); return false }
    // Список полок больше не приезжает сюда: он живёт на самой карточке черновика, где выбор
    // сразу пересчитывает комиссию. Здесь он относился к следующей генерации и вводил в
    // заблуждение ровно в тот момент, когда владелец смотрел на текущую.
    if (result.copy_available === false) setMessage({ ok: true, text: t('commerce.listing.okNoCopy') })
    await loadDrafts()
    return true
  }

  // Выбор полки для уже написанного черновика. Генерация не повторяется: категория меняет
  // комиссию, резерв и минимальную цену — текст она не трогает, и терять его незачем.
  const setDraftCategory = async (draftId: string, category: string, manual?: ManualFees) => {
    if (!supabase) return false
    setMessage(null)
    const { data, error } = await supabase.functions.invoke('commerce-control', {
      body: {
        action: 'set_listing_category',
        draft_id: draftId,
        uzum_category: category,
        // Комиссия едет только когда полки нет среди своих: для своей она факт, прочитанный у
        // Uzum, и присланное сюда число могло бы его молча заменить.
        ...(manual ? { commission_percent: manual.commission_percent, returns_reserve_percent: manual.returns_reserve_percent } : {}),
      },
    })
    const result = data as { ok?: boolean; error?: string } | null
    if (error || !result?.ok) { setMessage({ ok: false, text: result?.error ?? error?.message ?? t('commerce.listing.errCategory') }); return false }
    await loadDrafts()
    return true
  }

  const decideDraft = async (draftId: string, action: 'approve_listing_draft' | 'discard_listing_draft') => {
    if (!supabase) return false
    setMessage(null)
    const { data, error } = await supabase.functions.invoke('commerce-control', { body: { action, draft_id: draftId } })
    const result = data as { ok?: boolean; error?: string } | null
    if (error || !result?.ok) { setMessage({ ok: false, text: result?.error ?? error?.message ?? t('commerce.listing.errDecide') }); return false }
    await loadDrafts()
    return true
  }

  const discover = async () => {
    if (!supabase || busy) return
    setBusy('discover'); setMessage(null)
    const { data, error } = await supabase.functions.invoke('commerce-control', { body: { action: 'discover_uzum' } })
    const result = data as { ok?: boolean; catalogs?: Catalog[]; error?: string } | null
    if (error || !result?.ok) setMessage({ ok: false, text: result?.error ?? error?.message ?? t('commerce.errDiscover') })
    else { setMessage({ ok: true, text: t('commerce.okDiscover', { count: result.catalogs?.length ?? 0 }) }); await load() }
    setBusy(null)
  }

  const startPilot = async () => {
    if (!supabase || busy) return
    setBusy('start'); setMessage(null)
    const { data, error } = await supabase.functions.invoke('commerce-control', { body: { action: 'start_pilot' } })
    const result = data as { ok?: boolean; error?: string } | null
    if (error || !result?.ok) setMessage({ ok: false, text: result?.error ?? error?.message ?? t('commerce.errStartPilot') })
    else { setMessage({ ok: true, text: t('commerce.okStartPilot') }); await load() }
    setBusy(null)
  }

  const autofill = async () => {
    // No catalogue guard any more: the action covers every catalogue on the account, so a
    // seller with four shops presses this once.
    if (!supabase || busy) return
    setBusy('autofill'); setMessage(null)
    const { data, error } = await supabase.functions.invoke('commerce-control', { body: { action: 'autofill_economics' } })
    const result = data as { ok?: boolean; result?: { cost_estimated: number; supply_estimated: number }; error?: string } | null
    if (error || !result?.ok) setMessage({ ok: false, text: result?.error ?? error?.message ?? t('commerce.errAutofill') })
    else {
      setMessage({ ok: true, text: t('commerce.okAutofill', { cost: result.result?.cost_estimated ?? 0, supply: result.result?.supply_estimated ?? 0 }) })
      await loadSkus(catalogId)
    }
    setBusy(null)
  }

  const saveSku = async (skuId: string, payload: Record<string, number | string>) => {
    if (!supabase) return false
    const { data, error } = await supabase.functions.invoke('commerce-control', { body: { action: 'update_sku_economics', sku_id: skuId, ...payload } })
    const result = data as { ok?: boolean; error?: string } | null
    if (error || !result?.ok) { setMessage({ ok: false, text: result?.error ?? error?.message ?? t('commerce.errSaveSku') }); return false }
    await loadSkus(catalogId)
    return true
  }

  const proposeFees = async () => {
    if (!supabase || !catalogId || busy) return
    setBusy('fees'); setMessage(null)
    const { data, error } = await supabase.functions.invoke('commerce-control', { body: { action: 'propose_fees', catalog_id: catalogId } })
    const result = data as { ok?: boolean; evidence?: string[]; error?: string } | null
    if (error || !result?.ok) {
      const key = result?.error === 'no recent seller-cabinet observation' ? 'commerce.feesNoObs' : 'commerce.feesNone'
      setMessage({ ok: false, text: t(key) })
    } else {
      // Echo the exact lines the numbers were read from: the owner is confirming a scrape,
      // and cannot judge it without seeing what was actually on the page.
      setMessage({ ok: true, text: (result.evidence ?? []).join(' · ') })
      await loadProposals()
    }
    setBusy(null)
  }

  const syncNow = async () => {
    if (!supabase || busy) return
    setBusy('sync'); setMessage(null)
    const { data, error } = await supabase.functions.invoke('commerce-control', { body: { action: 'sync_now' } })
    const result = data as { ok?: boolean; completed?: number; failed?: number; issues?: Array<{ name: string; last_sync_error: string }>; retry_after_seconds?: number; error?: string } | null
    if (result?.error === 'cooldown') {
      setMessage({ ok: false, text: t('commerce.syncCooldown', { minutes: Math.ceil((result.retry_after_seconds ?? 600) / 60) }) })
    } else if (error || !result?.ok) {
      setMessage({ ok: false, text: result?.error ?? error?.message ?? t('commerce.errSync') })
    } else {
      // A shop that failed says so by name: "synced" while two shops are silently broken is
      // exactly the report that hid this problem for a day.
      const issues = result.issues ?? []
      setMessage({
        ok: issues.length === 0,
        text: issues.length
          ? `${t('commerce.okSync', { count: result.completed ?? 0 })} ${issues.map((i) => i.name).join(', ')}`
          : t('commerce.okSync', { count: result.completed ?? 0 }),
      })
      await load(catalogId)
    }
    setBusy(null)
  }

  const proposeMargin = async () => {
    if (!supabase || !catalogId || busy) return
    setBusy('margin'); setMessage(null)
    const { data, error } = await supabase.functions.invoke('commerce-control', { body: { action: 'propose_min_margin', catalog_id: catalogId, min_margin_percent: marginInput.trim() } })
    const result = data as { ok?: boolean; affected?: number; error?: string } | null
    if (error || !result?.ok) setMessage({ ok: false, text: result?.error ?? error?.message ?? t('commerce.errMargin') })
    else {
      // The confirmation names how many SKUs are actually blank, not the catalogue size:
      // products that already carry a margin keep it.
      setMessage({ ok: true, text: t('commerce.okMargin', { count: result.affected ?? 0 }) })
      await loadProposals()
    }
    setBusy(null)
  }

  const decideProposal = async (proposalId: string, action: 'apply_proposal' | 'reject_proposal') => {
    if (!supabase || busy) return
    setBusy('proposal'); setMessage(null)
    const { data, error } = await supabase.functions.invoke('commerce-control', { body: { action, proposal_id: proposalId } })
    const result = data as { ok?: boolean; result?: { skus_touched?: number }; error?: string } | null
    if (error || !result?.ok) setMessage({ ok: false, text: result?.error ?? error?.message ?? t('commerce.errSaveSku') })
    else setMessage({ ok: true, text: action === 'apply_proposal' ? t('commerce.proposalApplied', { count: result.result?.skus_touched ?? 0 }) : t('commerce.proposalRejected') })
    await Promise.all([loadProposals(), loadSkus(catalogId)])
    setBusy(null)
  }

  const describeProposal = (proposal: Proposal) => [
    proposal.commission_percent != null ? `${t('commerce.commission')} ${proposal.commission_percent}%` : null,
    proposal.fulfillment_tiyin != null ? `${t('commerce.fulfillment')} ${(proposal.fulfillment_tiyin / 100).toLocaleString('ru-RU')}` : null,
    proposal.returns_reserve_percent != null ? `${t('commerce.returns')} ${proposal.returns_reserve_percent}%` : null,
    proposal.unit_cost_tiyin != null ? `${t('commerce.sku.cost')} ${(proposal.unit_cost_tiyin / 100).toLocaleString('ru-RU')}` : null,
    proposal.lead_time_days != null ? `${t('commerce.sku.lead')} ${proposal.lead_time_days}` : null,
    proposal.min_margin_percent != null ? `${t('commerce.sku.margin')} ${proposal.min_margin_percent}%` : null,
  ].filter(Boolean).join(' · ')

  const connectTelegram = async () => {
    // Without claiming `busy` a double click minted several one-time links in the same second.
    if (!supabase || busy) return
    setBusy('connect'); setMessage(null)
    const { data, error } = await supabase.functions.invoke('commerce-control', { body: { action: 'create_telegram_link' } })
    if (error || !data?.ok) setMessage({ ok: false, text: data?.error ?? error?.message ?? t('commerce.errTgLink') })
    else setTelegramLink(data.url)
    setBusy(null)
  }

  const stageFile = async (file: File) => {
    if (!supabase || !catalogId || busy) return
    setBusy('stage'); setMessage(null)
    try {
      const text = await extractText(file)
      const matrix = file.name.toLowerCase().endsWith('.xlsx')
        ? text.split(/\r?\n/).filter(Boolean).map((line) => line.split('\t').map((cell) => cell.trim()))
        : parseDelimited(text)
      const sourceHeaders = (matrix[0] ?? []).map((header) => header.trim().toLowerCase())
      const missing = headers.filter((header) => !sourceHeaders.includes(header))
      if (missing.length) throw new Error(t('commerce.errMissingCols', { cols: missing.join(', ') }))
      const rows = matrix.slice(1).filter((row) => row.some((cell) => cell.trim())).map((row) => {
        const source = Object.fromEntries(sourceHeaders.map((header, index) => [header, row[index] ?? '']))
        return {
          external_sku: source.external_sku,
          unit_cost_tiyin: toTiyin(source.unit_cost_uzs),
          commission_percent: source.commission_percent,
          fulfillment_tiyin: toTiyin(source.fulfillment_uzs),
          returns_reserve_percent: source.returns_reserve_percent,
          lead_time_days: source.lead_time_days,
          moq: source.moq,
          safety_stock: source.safety_stock,
          min_margin_percent: source.min_margin_percent,
        }
      })
      if (!rows.length) throw new Error(t('commerce.errNoRows'))
      if (rows.length > 500) throw new Error(t('commerce.errTooManyRows'))
      const { data, error } = await supabase.functions.invoke('commerce-control', { body: { action: 'stage_import', catalog_id: catalogId, file_name: file.name, file_sha256: await hashFile(file), rows } })
      const result = data as { ok?: boolean; batch?: Batch; error?: string } | null
      if (error || !result?.ok) setMessage({ ok: false, text: result?.error ?? error?.message ?? t('commerce.errStage') })
      else {
        const batch = result.batch!
        setMessage({ ok: true, text: t('commerce.okStage', { total: batch.total_rows, valid: batch.valid_rows, unmatched: batch.unmatched_rows, invalid: batch.error_rows }) })
        await load(catalogId)
      }
    } catch (error) { setMessage({ ok: false, text: error instanceof Error ? error.message : t('commerce.errReadFile') }) }
    setBusy(null)
  }

  const staged = batches.filter((batch) => batch.status === 'staged')
  const selectedCatalog = catalogs.find((catalog) => catalog.id === catalogId)
  const syncIssues = catalogs.filter((catalog) => catalog.last_sync_error)

  return (
    <div className="container-page max-w-5xl py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-indigo/15 text-accent-indigo"><Database size={20} /></span><div><h1 className="text-2xl font-semibold tracking-tight text-text">{t('commerce.title')}</h1><p className="text-sm text-muted">{t('commerce.subtitle')}</p></div></div>
        {/* Магазин выбирается здесь, у названия модуля: он меняет данные на всех вкладках сразу,
            и место такого переключателя — над ними, а не между ними.
            Обновление — иконкой рядом. Три равновеликие кнопки в шапке дважды приводили к тому,
            что нажималась соседняя; из них осталась одна, и та без слов. */}
        {catalogs.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {catalogs.length > 1 && (
              <select
                value={catalogId}
                onChange={(event) => { setCatalogId(event.target.value); void load(event.target.value) }}
                aria-label={t('commerce.catalog')}
                className="rounded-xl border border-ice/12 bg-bg/60 px-3 py-2 text-sm text-text outline-none focus:border-accent-cyan/60"
              >
                {catalogs.map((catalog) => <option key={catalog.id} value={catalog.id} className="bg-panel">{catalog.name}</option>)}
              </select>
            )}
            <Button
              variant="outline" size="icon" onClick={syncNow} loading={busy === 'sync'}
              disabled={!isSupabaseEnabled || pilot?.status !== 'active'}
              title={t('commerce.syncNow')} aria-label={t('commerce.syncNow')}
            >
              <RefreshCw size={15} />
            </Button>
          </div>
        )}
      </div>

      {message && <div className={`mt-5 flex items-start gap-2 rounded-xl px-3 py-2 text-sm ${message.ok ? 'bg-teal/10 text-teal border border-teal/20' : 'bg-danger/10 text-danger'}`}><>{message.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <AlertCircle size={16} className="mt-0.5 shrink-0" />}</><span>{message.text}{!message.ok && /owner|владел|egasi/i.test(message.text) && t('commerce.ownerHint')}</span></div>}

      {catalogs.length > 0 && (
        <nav className="mt-5 flex flex-wrap gap-1 border-b border-ice/10" role="tablist">
          {/* «Обзор 1» рядом с видимыми 78 находками читается как ошибка счёта, и это
              справедливо: число на корешке обещает пересчитать содержимое вкладки, а считало
              только сбои синка. Поломка помечается точкой — она говорит «здесь сломано», а не
              «одна штука». Числом помечается только то, что ждёт решения и спрятано. */}
          {([
            ['overview', t('commerce.tabs.overview'), 0, syncIssues.length > 0],
            ['costs', t('commerce.tabs.costs'), proposals.length, false],
            ['listing', t('commerce.tabs.listing'), 0, false],
            ['settings', t('commerce.tabs.settings'), 0, false],
          ] as const).map(([key, label, waiting, broken]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`-mb-px flex items-center gap-1.5 rounded-t-xl border-b-2 px-4 py-2.5 text-sm transition ${
                tab === key ? 'border-accent-cyan text-text' : 'border-transparent text-muted hover:text-text'}`}
            >
              {label}
              {/* Счётчик на корешке: то, что ждёт решения, не должно исчезать вместе со вкладкой. */}
              {waiting > 0 && <span className="rounded-full bg-amber/15 px-1.5 text-[11px] font-semibold text-amber">{waiting}</span>}
              {broken && <span className="h-1.5 w-1.5 rounded-full bg-danger" title={t('commerce.syncIssuesTitle')} />}
            </button>
          ))}
        </nav>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" padding="md"><p className="text-xs font-medium uppercase tracking-wide text-muted">{t('commerce.pilotStatus')}</p><p className="mt-2 text-lg font-semibold text-text">{loading ? t('common.loading') : pilot?.status ?? t('commerce.notStarted')}</p><p className="mt-1 text-xs text-muted">{pilot?.expires_at ? t('commerce.expires', { date: new Date(pilot.expires_at).toLocaleDateString() }) : t('commerce.noPilot')}</p></Card>
        <Card padding="md"><p className="text-xs font-medium uppercase tracking-wide text-muted">{t('commerce.catalogs')}</p><p className="mt-2 text-lg font-semibold text-text">{catalogs.length}</p><p className="mt-1 text-xs text-muted">{selectedCatalog ? `${selectedCatalog.name} · ${selectedCatalog.status}` : t('commerce.discoverFirst')}</p></Card>
      </div>

      {/* Shown only while there is nothing to look at yet. A seller who has already connected
          does not need the connect card taking the top of their screen every day. */}
      {!loading && !catalogs.length && (
        <Card className="mt-4" padding="md">
          <p className="text-sm font-semibold text-text">{t('commerce.onboard.title')}</p>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">{t('commerce.onboard.hint')}</p>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button onClick={() => void onboard()} loading={busy === 'onboard'} leftIcon={<Database size={15} />}>
              {t('commerce.onboard.action')}
            </Button>
            <p className="text-xs text-muted">{t('commerce.onboard.needsKey')}</p>
          </div>
        </Card>
      )}

      {/* ── Обзор ──────────────────────────────────────────────────────────────────────────
          Выводы и сбои синка остаются здесь всегда: это единственное, что требует внимания
          сегодня, и прятать его за корешком было бы возвратом к «существует, но не видно». */}
      {(tab === 'overview' || !catalogs.length) && (<>
      {/* The conclusions, first. Everything below this card is an input to them. */}
      <Card className="mt-4" padding="md">
        <div>
          <p className="text-sm font-semibold text-text">{t('commerce.findings.title')}</p>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">{t('commerce.findings.hint')}</p>
          {/* Что делает кнопка под каждой находкой. Без этой строки «Беру в работу» — чёрный
              ящик: непонятно, поменяет ли Nemo цену на Uzum, создаст задачу или просто скроет
              строку. Сказано прямо, потому что обещание read-only напечатано под каждой сводкой. */}
          <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted">{t('commerce.acceptHint')}</p>
        </div>
        <div className="mt-4">
          <CommerceFindings
            findings={findings}
            loading={loading}
            acceptedIds={acceptedFindings}
            busyId={acceptingFinding}
            onAccept={acceptFinding}
          />
        </div>
      </Card>

      {syncIssues.length > 0 && (
        <Card className="mt-4" padding="md">
          <p className="text-sm font-semibold text-text">{t('commerce.syncIssuesTitle')}</p>
          <p className="mt-1 text-xs text-muted">{t('commerce.syncIssuesHint')}</p>
          <div className="mt-3 space-y-2">
            {catalogs.filter((catalog) => catalog.last_sync_error).map((catalog) => (
              <div key={catalog.id} className="rounded-xl border border-amber/25 bg-amber/[0.06] px-3 py-2">
                <p className="text-sm text-text">{catalog.name} <span className="text-xs text-muted">#{catalog.external_shop_id}</span></p>
                <p className="mt-0.5 text-xs text-amber">{catalog.last_sync_error}</p>
              </div>
            ))}
          </div>
        </Card>
      )}
      </>)}

      {/* ── Себестоимость и каталог ─────────────────────────────────────────────────────── */}
      {tab === 'costs' && catalogs.length > 0 && (<>
      {proposals.length > 0 && (
        <Card className="mt-4" padding="md">
          <p className="text-sm font-semibold text-text">{t('commerce.proposalsTitle')}</p>
          <p className="mt-1 text-xs text-muted">{t('commerce.proposalsHint')}</p>
          <div className="mt-4 space-y-2">
            {proposals.map((proposal) => (
              <div key={proposal.id} className="flex flex-col gap-2 rounded-xl border border-ice/10 bg-panel/60 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm text-text">
                    {proposal.commerce_skus?.title ?? t('commerce.proposalCatalog')}
                    {proposal.commerce_skus?.external_sku && <span className="ml-2 text-xs text-muted">{proposal.commerce_skus.external_sku}</span>}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">{describeProposal(proposal)}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" onClick={() => void decideProposal(proposal.id, 'apply_proposal')} disabled={busy === 'proposal'}>{t('commerce.proposalApply')}</Button>
                  <Button size="sm" variant="outline" onClick={() => void decideProposal(proposal.id, 'reject_proposal')} disabled={busy === 'proposal'}>{t('commerce.proposalReject')}</Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="mt-4" padding="md">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-text">{t('commerce.economicsTitle')}</p>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">{t('commerce.economicsHint')}</p>
          </div>
          <Button variant="outline" onClick={autofill} loading={busy === 'autofill'} disabled={!catalogs.length} leftIcon={<Wand2 size={15} />}>{t('commerce.autofill')}</Button>
        </div>
        <div className="mt-4">{loading ? <p className="text-sm text-muted">{t('commerce.loadingSkus')}</p> : <CommerceSkuTable skus={skus} onSave={saveSku} />}</div>
      </Card>

      {/* Загрузка файла стоит сразу под таблицей: 128 позиций диктовать незачем, и путь к
          массовому вводу должен быть виден там же, где виден масштаб задачи. */}
      <Card className="mt-4" padding="md">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted">{t('commerce.economicsFile')}</span>
          <span className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-accent-indigo/40 bg-accent-indigo/[0.05] px-3 py-3 text-sm text-accent-indigo hover:bg-accent-indigo/[0.1]">
            <Upload size={15} />{busy === 'stage' ? t('commerce.staging') : t('commerce.chooseFile')}
            <input className="sr-only" type="file" accept=".csv,.xlsx" disabled={!catalogId || busy === 'stage'} onChange={(event) => { const file = event.target.files?.[0]; if (file) void stageFile(file); event.currentTarget.value = '' }} />
          </span>
        </label>
        <p className="mt-3 text-xs leading-relaxed text-muted">{t('commerce.bulkHint')} <code className="text-fog">{headers.join(', ')}</code>. <code className="text-fog">unit_cost_uzs</code> and <code className="text-fog">fulfillment_uzs</code> {t('commerce.bulkHintTail')}</p>
        {!catalogId && <p className="mt-2 text-xs text-amber">{t('commerce.selectCatalog')}</p>}
      </Card>

      <Card className="mt-4" padding="md"><div className="flex items-center justify-between gap-3"><div><p className="text-sm font-semibold text-text">{t('commerce.stagedTitle')}</p><p className="text-xs text-muted">{t('commerce.stagedCount', { count: staged.length })}</p></div><span className="rounded-full bg-accent-indigo/10 px-3 py-1 text-sm font-semibold text-accent-indigo border border-accent-indigo/20">{t('commerce.rowsCount', { count: staged.reduce((sum, batch) => sum + batch.total_rows, 0) })}</span></div>{staged.length > 0 && <div className="mt-4 space-y-2">{staged.map((batch) => <div key={batch.id} className="flex flex-col gap-1 rounded-xl border border-ice/10 bg-panel/60 px-3 py-2 text-xs text-muted sm:flex-row sm:items-center sm:justify-between"><span>{new Date(batch.created_at).toLocaleString()}</span><span>{batch.total_rows} rows · {batch.valid_rows} valid · {batch.unmatched_rows} unmatched · {batch.error_rows} invalid</span></div>)}</div>}</Card>
      </>)}

      {/* ── Генератор листингов ─────────────────────────────────────────────────────────── */}
      {tab === 'listing' && catalogs.length > 0 && (
      <Card className="mt-4" padding="md">
        <div>
          <p className="text-sm font-semibold text-text">{t('commerce.listing.title')}</p>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">{t('commerce.listing.hint')}</p>
        </div>
        <div className="mt-4">
          <CommerceListingAgent
            drafts={drafts}
            categories={categories}
            categoryLabels={categoryLabels}
            onDraft={draftListing}
            onCategory={setDraftCategory}
            onApprove={(draftId) => decideDraft(draftId, 'approve_listing_draft')}
            onDiscard={(draftId) => decideDraft(draftId, 'discard_listing_draft')}
          />
        </div>
      </Card>
      )}

      {/* ── Настройки интеграции ────────────────────────────────────────────────────────── */}
      {tab === 'settings' && catalogs.length > 0 && (<>
      {/* Редкие действия переехали сюда из шапки. «Начать пилот» при активном пилоте не показан
          вовсе, а не выключен: оранжевая кнопка «Начать» рядом со статусом «active» заставляет
          гадать, начат он или нет, и выключенность этого не объясняет. */}
      <Card className="mt-4" padding="md">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-text">{t('commerce.setupTitle')}</p>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">{t('commerce.setupHint')}</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {pilot?.status !== 'active' && (
              <Button variant="outline" onClick={startPilot} loading={busy === 'start'} disabled={!isSupabaseEnabled}>{t('commerce.startPilot')}</Button>
            )}
            <Button variant="outline" onClick={discover} loading={busy === 'discover'} disabled={!isSupabaseEnabled || pilot?.status !== 'active'} leftIcon={<Search size={15} />}>{t('commerce.discover')}</Button>
          </div>
        </div>
      </Card>

      <Card className="mt-4" padding="md">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div><p className="text-sm font-semibold text-text">{t('commerce.feesTitle')}</p><p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">{t('commerce.feesHint')}</p></div>
          <Button variant="outline" onClick={proposeFees} loading={busy === 'fees'} disabled={!catalogId}>{t('commerce.feesRead')}</Button>
        </div>
      </Card>

      <Card className="mt-4" padding="md">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div><p className="text-sm font-semibold text-text">{t('commerce.marginTitle')}</p><p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">{t('commerce.marginHint')}</p></div>
          <div className="flex shrink-0 items-center gap-2">
            <input
              className="w-20 rounded-xl border border-ice/12 bg-bg/60 px-3 py-2 text-sm text-text outline-none focus:border-accent-cyan/60"
              inputMode="decimal"
              value={marginInput}
              onChange={(event) => setMarginInput(event.target.value)}
              aria-label={t('commerce.marginTitle')}
            />
            <span className="text-sm text-muted">%</span>
            <Button variant="outline" onClick={proposeMargin} loading={busy === 'margin'} disabled={!catalogId || !marginInput.trim()}>{t('commerce.marginSet')}</Button>
          </div>
        </div>
      </Card>

      <Card className="mt-4" padding="md"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-semibold text-text">{t('commerce.tgTitle')}</p><p className="mt-1 text-xs text-muted">{t('commerce.tgSubtitle')}</p></div>{telegramConnected ? <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-teal/10 px-3 py-1.5 text-xs font-medium text-teal"><CheckCircle2 size={14} /> {t('commerce.tgConnected')}</span> : <Button onClick={connectTelegram}>{t('commerce.tgConnect')}</Button>}</div>{/* Имя бота, а не «в вашем Telegram»: у аккаунта их несколько, и назвать нужный можно только
    по привязке. Ссылка ведёт прямо в тот чат, куда приходят сводки и где ждут /costs. */}
{notifyBot && <p className="mt-3 text-xs text-muted">{t('commerce.tgBot')} <a href={`https://t.me/${notifyBot}`} target="_blank" rel="noreferrer" className="font-medium text-accent-cyan underline">@{notifyBot}</a></p>}{telegramLink && <a href={telegramLink} target="_blank" rel="noreferrer" className="mt-3 inline-flex text-sm font-medium text-accent-cyan underline">{t('commerce.tgOpen')}</a>}{!telegramConnected && !telegramLink && <p className="mt-3 text-xs text-amber">{t('commerce.tgHint')}</p>}</Card>

      </>)}

      {/* Замок живёт на уровне страницы, а не вкладки: закрыв его, владелец остаётся там, где
          был, и видит свои данные — они никуда не делись, и это половина всего сообщения. */}
      <PaywallDialog paywall={paywall} onClose={() => setPaywall(null)} />
    </div>
  )
}
