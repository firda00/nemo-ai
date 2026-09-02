import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Boxes, CheckCircle2, PackageOpen, RefreshCw, ShoppingBag, TrendingUp } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import type { CommerceSku } from './CommerceSkuTable'

type Catalog = {
  id: string
  name: string
  status: string
  last_synced_at: string | null
  last_sync_error: string | null
}

type SnapshotState = {
  catalogs: Array<Catalog & { skus: CommerceSku[]; observedAt: string | null }>
}

const compact = (value: number) => new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
const money = (value: number) => `${new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(value)} сум`

export function StoreSnapshotArtifact({ lang, departmentId, task, runRef, onSettled, onSaved }: { lang: 'ru' | 'uz' | 'en'; departmentId?: string; task?: string; runRef?: string; onSettled?: (ok: boolean) => void; onSaved?: () => void | Promise<void> }) {
  const [state, setState] = useState<SnapshotState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const onSettledRef = useRef(onSettled)
  const onSavedRef = useRef(onSaved)

  useEffect(() => {
    onSettledRef.current = onSettled
    onSavedRef.current = onSaved
  }, [onSaved, onSettled])

  const copy = useMemo(() => lang === 'uz' ? {
    eyebrow: 'JONLI ARTEFAKT', title: 'Uzum do‘konlari holati', stores: 'do‘kon', products: 'Mahsulotlar', sales: '7 kunlik sotuv', stock: 'Jami qoldiq', revenue: 'Taxminiy tushum', risks: 'E’tibor kerak', top: 'Sotuv yetakchilari', empty: 'Uzum ma’lumotlari hali sinxronlanmagan.', retry: 'Yangilash', source: 'Manba: Uzum server sinxronizatsiyasi', noSales: 'Sotuv ma’lumoti yo‘q', stockout: 'qoldiqsiz SKU', stale: 'Sinxronlashda xato', healthy: 'Asosiy ko‘rsatkichlar yuklandi',
  } : lang === 'en' ? {
    eyebrow: 'LIVE ARTIFACT', title: 'Uzum store health', stores: 'stores', products: 'Products', sales: '7-day sales', stock: 'Total stock', revenue: 'Est. revenue', risks: 'Needs attention', top: 'Sales leaders', empty: 'Uzum data has not been synchronized yet.', retry: 'Refresh', source: 'Source: server-side Uzum sync', noSales: 'No sales data', stockout: 'out-of-stock SKUs', stale: 'Sync error', healthy: 'Core metrics loaded',
  } : {
    eyebrow: 'ЖИВОЙ АРТЕФАКТ', title: 'Состояние магазинов Uzum', stores: 'магазинов', products: 'Товаров', sales: 'Продано за 7 дней', stock: 'Общий остаток', revenue: 'Оценка выручки', risks: 'Требует внимания', top: 'Лидеры продаж', empty: 'Данные Uzum ещё не синхронизированы.', retry: 'Обновить', source: 'Источник: серверная синхронизация Uzum', noSales: 'Нет данных о продажах', stockout: 'SKU без остатка', stale: 'Ошибка синхронизации', healthy: 'Основные показатели загружены',
  }, [lang])

  const load = useCallback(async () => {
    if (!supabase) {
      setError(copy.empty)
      setLoading(false)
      onSettledRef.current?.(false)
      return
    }
    const client = supabase
    setLoading(true)
    setError('')
    const { data: statusData, error: statusError } = await client.functions.invoke('commerce-control', { body: { action: 'status' } })
    const status = statusData as { ok?: boolean; catalogs?: Catalog[]; error?: string } | null
    const catalogs = status?.catalogs?.filter((item) => item.status === 'active') ?? []
    if (statusError || !status?.ok || !catalogs.length) {
      setError(status?.error ?? statusError?.message ?? copy.empty)
      setLoading(false)
      onSettledRef.current?.(false)
      return
    }
    const results = await Promise.all(catalogs.slice(0, 12).map(async (catalog) => {
      const { data, error: skuError } = await client.functions.invoke('commerce-control', { body: { action: 'list_skus', catalog_id: catalog.id } })
      const result = data as { ok?: boolean; observed_at?: string | null; skus?: CommerceSku[]; error?: string } | null
      return { catalog, result, error: skuError }
    }))
    const loaded = results.filter(({ result, error: skuError }) => !skuError && result?.ok).map(({ catalog, result }) => ({ ...catalog, skus: result?.skus ?? [], observedAt: result?.observed_at ?? catalog.last_synced_at }))
    if (!loaded.length) {
      setError(results[0]?.result?.error ?? results[0]?.error?.message ?? copy.empty)
      setLoading(false)
      onSettledRef.current?.(false)
      return
    }
    setState({ catalogs: loaded })
    setLoading(false)
    onSettledRef.current?.(true)
    if (departmentId && task && runRef) {
      const allSkus = loaded.flatMap((catalog) => catalog.skus)
      const sold = allSkus.reduce((sum, sku) => sum + (sku.snapshot?.sold_units_7d ?? 0), 0)
      const stock = allSkus.reduce((sum, sku) => sum + (sku.snapshot?.stock_total ?? 0), 0)
      const stockouts = allSkus.filter((sku) => sku.snapshot?.stock_total === 0).length
      const report = `## ${copy.title}\n\n- ${copy.stores}: ${loaded.length}\n- ${copy.products}: ${allSkus.length}\n- ${copy.sales}: ${sold}\n- ${copy.stock}: ${stock}\n- ${copy.risks}: ${stockouts} ${copy.stockout}\n\n${copy.source}`
      const { data } = await client.functions.invoke('commerce-control', { body: { action: 'save_snapshot_run', department_id: departmentId, task, run_ref: runRef, report } })
      if ((data as { ok?: boolean } | null)?.ok) await onSavedRef.current?.()
    }
  }, [copy, departmentId, runRef, task])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    const daily = window.setInterval(() => void load(), 24 * 60 * 60 * 1000)
    return () => { window.clearTimeout(timer); window.clearInterval(daily) }
  }, [load])

  const metrics = useMemo(() => {
    const skus = state?.catalogs.flatMap((catalog) => catalog.skus) ?? []
    const productsWithSales = skus.filter((sku) => sku.snapshot?.sold_units_7d != null)
    const sold = productsWithSales.reduce((sum, sku) => sum + (sku.snapshot?.sold_units_7d ?? 0), 0)
    const stock = skus.reduce((sum, sku) => sum + (sku.snapshot?.stock_total ?? 0), 0)
    const revenue = skus.reduce((sum, sku) => sum + ((sku.snapshot?.price_tiyin ?? 0) / 100) * (sku.snapshot?.sold_units_7d ?? 0), 0)
    const stockouts = skus.filter((sku) => sku.snapshot?.stock_total === 0).length
    const top = [...skus].filter((sku) => (sku.snapshot?.sold_units_7d ?? 0) > 0).sort((a, b) => (b.snapshot?.sold_units_7d ?? 0) - (a.snapshot?.sold_units_7d ?? 0)).slice(0, 5)
    const maxSold = Math.max(1, ...top.map((sku) => sku.snapshot?.sold_units_7d ?? 0))
    return { products: skus.length, sold, stock, revenue, stockouts, hasSales: productsWithSales.length > 0, top, maxSold }
  }, [state])

  if (loading) return (
    <section className="store-artifact-in overflow-hidden rounded-3xl border border-cyan/20 bg-gradient-to-br from-cyan/[0.07] via-card/[0.04] to-violet/[0.06] p-4 sm:p-5" role="status" aria-label={copy.title}>
      <div className="flex items-center gap-3"><span className="relative grid h-10 w-10 place-items-center rounded-2xl bg-cyan/10 text-cyan"><ShoppingBag size={18} /><span className="absolute inset-0 animate-ping rounded-2xl border border-cyan/30" /></span><div><p className="text-[10px] font-bold tracking-[0.18em] text-cyan">{copy.eyebrow}</p><h3 className="mt-1 text-sm font-bold text-text">{copy.title}</h3></div></div>
      <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">{[0, 1, 2, 3].map((item) => <div key={item} className="h-20 animate-pulse rounded-2xl bg-white/[0.045]" />)}</div>
      <div className="mt-3 h-24 animate-pulse rounded-2xl bg-white/[0.035]" />
    </section>
  )

  if (error || !state) return <section className="store-artifact-in rounded-3xl border border-amber/20 bg-amber/[0.05] p-5"><div className="flex items-start gap-3"><AlertTriangle size={19} className="mt-0.5 shrink-0 text-amber" /><div className="min-w-0 flex-1"><h3 className="text-sm font-bold text-text">{copy.title}</h3><p className="mt-1 text-xs leading-5 text-muted">{error || copy.empty}</p></div><button type="button" onClick={() => void load()} className="inline-flex items-center gap-1.5 rounded-xl border border-ice/10 px-3 py-2 text-xs text-text transition hover:bg-white/5"><RefreshCw size={13} />{copy.retry}</button></div></section>

  const cards = [
    { label: copy.products, value: compact(metrics.products), icon: Boxes, tone: 'text-cyan bg-cyan/10' },
    { label: copy.sales, value: metrics.hasSales ? compact(metrics.sold) : '—', icon: TrendingUp, tone: 'text-teal bg-teal/10' },
    { label: copy.stock, value: compact(metrics.stock), icon: PackageOpen, tone: 'text-violet bg-violet/10' },
    { label: copy.revenue, value: metrics.hasSales ? money(metrics.revenue) : '—', icon: ShoppingBag, tone: 'text-amber bg-amber/10' },
  ]

  return (
    <section className="store-artifact-in overflow-hidden rounded-3xl border border-cyan/20 bg-gradient-to-br from-cyan/[0.065] via-card/[0.035] to-violet/[0.055] p-4 shadow-[0_18px_55px_rgba(34,211,238,0.06)] sm:p-5" aria-label={copy.title}>
      <div className="flex flex-wrap items-start gap-3"><span className="grid h-10 w-10 place-items-center rounded-2xl bg-cyan/10 text-cyan"><ShoppingBag size={18} /></span><div className="min-w-0 flex-1"><p className="text-[10px] font-bold tracking-[0.18em] text-cyan">{copy.eyebrow}</p><h3 className="mt-1 truncate text-base font-bold text-text">{copy.title}</h3><p className="mt-0.5 truncate text-[11px] text-muted">{state.catalogs.length} {copy.stores} · {state.catalogs.map((catalog) => catalog.name).join(', ')}</p></div><span className="inline-flex items-center gap-1.5 rounded-full bg-teal/[0.09] px-2.5 py-1 text-[10px] font-semibold text-teal"><CheckCircle2 size={11} />{copy.healthy}</span></div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">{cards.map((card) => <div key={card.label} className="rounded-2xl border border-ice/[0.07] bg-bg/35 p-3"><span className={`grid h-7 w-7 place-items-center rounded-xl ${card.tone}`}><card.icon size={14} /></span><p className="mt-3 text-lg font-extrabold tracking-tight text-text">{card.value}</p><p className="mt-0.5 text-[10px] leading-4 text-muted">{card.label}</p></div>)}</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
        <div className="rounded-2xl border border-ice/[0.07] bg-bg/30 p-3.5"><p className="text-[11px] font-bold text-text">{copy.top}</p>{metrics.top.length ? <div className="mt-3 space-y-2.5">{metrics.top.map((sku) => <div key={sku.id}><div className="flex min-w-0 items-center gap-2 text-[10px]"><span className="min-w-0 flex-1 truncate text-muted">{sku.title}</span><strong className="text-text">{sku.snapshot?.sold_units_7d ?? 0}</strong></div><div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.05]"><div className="h-full rounded-full bg-gradient-to-r from-cyan to-violet transition-[width] duration-700" style={{ width: `${Math.max(8, ((sku.snapshot?.sold_units_7d ?? 0) / metrics.maxSold) * 100)}%` }} /></div></div>)}</div> : <p className="mt-3 text-xs text-muted">{copy.noSales}</p>}</div>
        <div className="rounded-2xl border border-ice/[0.07] bg-bg/30 p-3.5"><p className="text-[11px] font-bold text-text">{copy.risks}</p><div className="mt-3 flex items-end gap-2"><strong className={metrics.stockouts ? 'text-2xl text-amber' : 'text-2xl text-teal'}>{metrics.stockouts}</strong><span className="pb-0.5 text-[10px] leading-4 text-muted">{copy.stockout}</span></div>{state.catalogs.find((catalog) => catalog.last_sync_error) && <p className="mt-3 rounded-lg bg-danger/[0.07] p-2 text-[10px] leading-4 text-danger">{copy.stale}: {state.catalogs.find((catalog) => catalog.last_sync_error)?.last_sync_error}</p>}</div>
      </div>
      <footer className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-ice/[0.06] pt-3 text-[9px] text-fog"><span>{copy.source}</span>{state.catalogs[0]?.observedAt && <time dateTime={state.catalogs[0].observedAt}>{new Date(state.catalogs[0].observedAt).toLocaleString(lang === 'uz' ? 'uz-UZ' : lang === 'en' ? 'en-US' : 'ru-RU')}</time>}<button type="button" onClick={() => void load()} className="ml-auto inline-flex items-center gap-1 text-cyan transition hover:text-text"><RefreshCw size={10} />{copy.retry}</button></footer>
    </section>
  )
}
