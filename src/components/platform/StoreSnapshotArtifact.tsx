import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Boxes, CheckCircle2, Lightbulb, PackageOpen, RefreshCw, ShoppingBag, TrendingUp } from 'lucide-react'
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
    eyebrow: 'JONLI ARTEFAKT', title: 'Uzum do‘konlari holati', weeklyTitle: 'Uzum bo‘yicha haftalik hisobot', stores: 'do‘kon', products: 'Mahsulotlar', sales: '7 kunlik sotuv', stock: 'Jami qoldiq', revenue: 'Taxminiy tushum', risks: 'E’tibor kerak', top: 'Sotuv yetakchilari', improve: 'Nimani yaxshilash kerak', empty: 'Uzum ma’lumotlari hali sinxronlanmagan.', retry: 'Yangilash', source: 'Manba: Uzum server sinxronizatsiyasi', noSales: 'Sotuv ma’lumoti yo‘q', stockout: 'qoldiqsiz SKU', stale: 'Sinxronlashda xato', healthy: 'Asosiy ko‘rsatkichlar yuklandi', replenish: 'Sotilayotgan, ammo zaxirasi 14 kundan kam mahsulotlarni to‘ldiring.', fixStockouts: 'Avval qoldiqsiz SKUlarni tekshiring va mavjudligini tiklang.', reviewIdle: 'Qoldig‘i bor, ammo haftalik savdosi yo‘q kartalarni, narxlarni va kontentni tekshiring.', connectSales: 'Savdo dinamikasi va aniq tavsiyalar uchun buyurtmalar sinxronizatsiyasini ulang.', keepWatching: 'Kritik xavf topilmadi — yetakchilar va qoldiqni kuzatishda davom eting.',
  } : lang === 'en' ? {
    eyebrow: 'LIVE ARTIFACT', title: 'Uzum store health', weeklyTitle: 'Uzum weekly report', stores: 'stores', products: 'Products', sales: '7-day sales', stock: 'Total stock', revenue: 'Est. revenue', risks: 'Needs attention', top: 'Sales leaders', improve: 'What to improve', empty: 'Uzum data has not been synchronized yet.', retry: 'Refresh', source: 'Source: server-side Uzum sync', noSales: 'No sales data', stockout: 'out-of-stock SKUs', stale: 'Sync error', healthy: 'Core metrics loaded', replenish: 'Restock selling products with less than 14 days of cover.', fixStockouts: 'Check out-of-stock SKUs first and restore availability.', reviewIdle: 'Review listings, prices and content for stocked products with no weekly sales.', connectSales: 'Connect order sync to see sales dynamics and receive precise recommendations.', keepWatching: 'No critical risk detected — keep watching leaders and stock cover.',
  } : {
    eyebrow: 'ЖИВОЙ АРТЕФАКТ', title: 'Состояние магазинов Uzum', weeklyTitle: 'Недельный отчёт по Uzum', stores: 'магазинов', products: 'Товаров', sales: 'Продано за 7 дней', stock: 'Общий остаток', revenue: 'Оценка выручки', risks: 'Требует внимания', top: 'Лидеры продаж', improve: 'Что улучшить', empty: 'Данные Uzum ещё не синхронизированы.', retry: 'Обновить', source: 'Источник: серверная синхронизация Uzum', noSales: 'Нет данных о продажах', stockout: 'SKU без остатка', stale: 'Ошибка синхронизации', healthy: 'Основные показатели загружены', replenish: 'Пополните продающиеся товары, запаса которых осталось менее чем на 14 дней.', fixStockouts: 'В первую очередь проверьте SKU без остатка и восстановите наличие.', reviewIdle: 'Проверьте карточки, цены и контент товаров с остатком, но без недельных продаж.', connectSales: 'Подключите синхронизацию заказов для динамики продаж и точных рекомендаций.', keepWatching: 'Критичных рисков нет — продолжайте следить за лидерами и запасом.',
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
    const lowCover = skus.filter((sku) => {
      const sold7d = sku.snapshot?.sold_units_7d ?? 0
      const stockTotal = sku.snapshot?.stock_total ?? 0
      return sold7d > 0 && stockTotal > 0 && stockTotal / (sold7d / 7) < 14
    }).length
    const idle = skus.filter((sku) => (sku.snapshot?.stock_total ?? 0) > 0 && sku.snapshot?.sold_units_7d === 0).length
    return { products: skus.length, sold, stock, revenue, stockouts, lowCover, idle, hasSales: productsWithSales.length > 0, top, maxSold }
  }, [state])

  const recommendations = [
    metrics.stockouts > 0 ? copy.fixStockouts : '',
    metrics.lowCover > 0 ? copy.replenish : '',
    metrics.idle > 0 ? copy.reviewIdle : '',
    !metrics.hasSales ? copy.connectSales : '',
  ].filter(Boolean)
  if (!recommendations.length) recommendations.push(copy.keepWatching)
  const artifactTitle = task && /недел|weekly|hafta/i.test(task) ? copy.weeklyTitle : copy.title

  if (loading) return (
    <section className="store-artifact-in overflow-hidden rounded-3xl border border-cyan/20 bg-gradient-to-br from-cyan/[0.07] via-card/[0.04] to-violet/[0.06] p-4 sm:p-5" role="status" aria-label={artifactTitle}>
      <div className="flex items-center gap-3"><span className="relative grid h-10 w-10 place-items-center rounded-2xl bg-cyan/10 text-cyan"><ShoppingBag size={18} /><span className="absolute inset-0 animate-ping rounded-2xl border border-cyan/30" /></span><div><p className="text-[10px] font-bold tracking-[0.18em] text-cyan">{copy.eyebrow}</p><h3 className="mt-1 text-sm font-bold text-text">{artifactTitle}</h3></div></div>
      <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">{[0, 1, 2, 3].map((item) => <div key={item} className="h-20 animate-pulse rounded-2xl bg-white/[0.045]" />)}</div>
      <div className="mt-3 h-24 animate-pulse rounded-2xl bg-white/[0.035]" />
    </section>
  )

  if (error || !state) return <section className="store-artifact-in rounded-3xl border border-amber/20 bg-amber/[0.05] p-5"><div className="flex items-start gap-3"><AlertTriangle size={19} className="mt-0.5 shrink-0 text-amber" /><div className="min-w-0 flex-1"><h3 className="text-sm font-bold text-text">{artifactTitle}</h3><p className="mt-1 text-xs leading-5 text-muted">{error || copy.empty}</p></div><button type="button" onClick={() => void load()} className="inline-flex items-center gap-1.5 rounded-xl border border-ice/10 px-3 py-2 text-xs text-text transition hover:bg-white/5"><RefreshCw size={13} />{copy.retry}</button></div></section>

  const cards = [
    { label: copy.products, value: compact(metrics.products), icon: Boxes, tone: 'text-cyan bg-cyan/10' },
    { label: copy.sales, value: metrics.hasSales ? compact(metrics.sold) : '—', icon: TrendingUp, tone: 'text-teal bg-teal/10' },
    { label: copy.stock, value: compact(metrics.stock), icon: PackageOpen, tone: 'text-violet bg-violet/10' },
    { label: copy.revenue, value: metrics.hasSales ? money(metrics.revenue) : '—', icon: ShoppingBag, tone: 'text-amber bg-amber/10' },
  ]

  return (
    <section className="store-artifact-in overflow-hidden rounded-3xl border border-cyan/20 bg-gradient-to-br from-cyan/[0.065] via-card/[0.035] to-violet/[0.055] p-4 shadow-[0_18px_55px_rgba(34,211,238,0.06)] sm:p-5" aria-label={artifactTitle}>
      <div className="flex flex-wrap items-start gap-3"><span className="grid h-10 w-10 place-items-center rounded-2xl bg-cyan/10 text-cyan"><ShoppingBag size={18} /></span><div className="min-w-0 flex-1"><p className="text-[10px] font-bold tracking-[0.18em] text-cyan">{copy.eyebrow}</p><h3 className="mt-1 truncate text-base font-bold text-text">{artifactTitle}</h3><p className="mt-0.5 truncate text-[11px] text-muted">{state.catalogs.length} {copy.stores} · {state.catalogs.map((catalog) => catalog.name).join(', ')}</p></div><span className="inline-flex items-center gap-1.5 rounded-full bg-teal/[0.09] px-2.5 py-1 text-[10px] font-semibold text-teal"><CheckCircle2 size={11} />{copy.healthy}</span></div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">{cards.map((card) => <div key={card.label} className="rounded-2xl border border-ice/[0.07] bg-bg/35 p-3"><span className={`grid h-7 w-7 place-items-center rounded-xl ${card.tone}`}><card.icon size={14} /></span><p className="mt-3 text-lg font-extrabold tracking-tight text-text">{card.value}</p><p className="mt-0.5 text-[10px] leading-4 text-muted">{card.label}</p></div>)}</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
        <div className="rounded-2xl border border-ice/[0.07] bg-bg/30 p-3.5"><p className="text-[11px] font-bold text-text">{copy.top}</p>{metrics.top.length ? <div className="mt-3 space-y-2.5">{metrics.top.map((sku) => <div key={sku.id}><div className="flex min-w-0 items-center gap-2 text-[10px]"><span className="min-w-0 flex-1 truncate text-muted">{sku.title}</span><strong className="text-text">{sku.snapshot?.sold_units_7d ?? 0}</strong></div><div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.05]"><div className="h-full rounded-full bg-gradient-to-r from-cyan to-violet transition-[width] duration-700" style={{ width: `${Math.max(8, ((sku.snapshot?.sold_units_7d ?? 0) / metrics.maxSold) * 100)}%` }} /></div></div>)}</div> : <p className="mt-3 text-xs text-muted">{copy.noSales}</p>}</div>
        <div className="rounded-2xl border border-ice/[0.07] bg-bg/30 p-3.5"><p className="text-[11px] font-bold text-text">{copy.risks}</p><div className="mt-3 flex items-end gap-2"><strong className={metrics.stockouts ? 'text-2xl text-amber' : 'text-2xl text-teal'}>{metrics.stockouts}</strong><span className="pb-0.5 text-[10px] leading-4 text-muted">{copy.stockout}</span></div>{state.catalogs.find((catalog) => catalog.last_sync_error) && <p className="mt-3 rounded-lg bg-danger/[0.07] p-2 text-[10px] leading-4 text-danger">{copy.stale}: {state.catalogs.find((catalog) => catalog.last_sync_error)?.last_sync_error}</p>}</div>
      </div>
      <div className="mt-3 rounded-2xl border border-amber/[0.13] bg-amber/[0.035] p-3.5"><p className="flex items-center gap-2 text-[11px] font-bold text-text"><Lightbulb size={13} className="text-amber" />{copy.improve}</p><ol className="mt-3 grid gap-2 sm:grid-cols-2">{recommendations.slice(0, 4).map((item, index) => <li key={item} className="flex gap-2 text-[11px] leading-5 text-muted"><span className="grid h-5 w-5 shrink-0 place-items-center rounded-lg bg-amber/10 text-[10px] font-bold text-amber">{index + 1}</span><span>{item}</span></li>)}</ol></div>
      <footer className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-ice/[0.06] pt-3 text-[9px] text-fog"><span>{copy.source}</span>{state.catalogs[0]?.observedAt && <time dateTime={state.catalogs[0].observedAt}>{new Date(state.catalogs[0].observedAt).toLocaleString(lang === 'uz' ? 'uz-UZ' : lang === 'en' ? 'en-US' : 'ru-RU')}</time>}<button type="button" onClick={() => void load()} className="ml-auto inline-flex items-center gap-1 text-cyan transition hover:text-text"><RefreshCw size={10} />{copy.retry}</button></footer>
    </section>
  )
}
