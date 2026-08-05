import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Database, Search, Upload, Wand2 } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { CommerceSkuTable, type CommerceSku } from '../../components/platform/CommerceSkuTable'
import { extractText } from '../../lib/extractText'
import { isSupabaseEnabled, supabase } from '../../lib/supabase'

type Catalog = { id: string; name: string; source: string; external_shop_id: string | null; status: string; last_synced_at: string | null; last_sync_error: string | null }
type Pilot = { status: string; started_at: string | null; expires_at: string | null; read_only_at: string | null }
type Batch = { id: string; status: string; total_rows: number; valid_rows: number; unmatched_rows: number; error_rows: number; created_at: string }

const headers = ['external_sku', 'unit_cost_uzs', 'commission_percent', 'fulfillment_uzs', 'returns_reserve_percent', 'lead_time_days', 'moq', 'safety_stock', 'min_margin_percent'] as const
const inputClass = 'w-full rounded-xl border border-ice/10 bg-black/20 px-3 py-2 text-sm text-text outline-none focus:border-violet/50'

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
  const [pilot, setPilot] = useState<Pilot | null>(null)
  const [catalogs, setCatalogs] = useState<Catalog[]>([])
  const [catalogId, setCatalogId] = useState('')
  const [batches, setBatches] = useState<Batch[]>([])
  const [loading, setLoading] = useState(isSupabaseEnabled)
  const [telegramConnected, setTelegramConnected] = useState(false)
  const [telegramLink, setTelegramLink] = useState<string | null>(null)
  const [skus, setSkus] = useState<CommerceSku[]>([])
  const [busy, setBusy] = useState<'start' | 'discover' | 'stage' | 'autofill' | 'connect' | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const loadSkus = useCallback(async (selectedCatalogId: string) => {
    if (!supabase || !selectedCatalogId) { setSkus([]); return }
    const { data } = await supabase.functions.invoke('commerce-control', { body: { action: 'list_skus', catalog_id: selectedCatalogId } })
    const result = data as { ok?: boolean; skus?: CommerceSku[] } | null
    setSkus(result?.ok ? result.skus ?? [] : [])
  }, [])

  const load = useCallback(async (selectedCatalogId = catalogId) => {
    if (!supabase) { setLoading(false); return }
    const [statusResult, listResult] = await Promise.all([
      supabase.functions.invoke('commerce-control', { body: { action: 'status' } }),
      supabase.functions.invoke('commerce-control', { body: { action: 'list', ...(selectedCatalogId ? { catalog_id: selectedCatalogId } : {}) } }),
      loadSkus(selectedCatalogId),
    ])
    const status = statusResult.data as { ok?: boolean; pilot?: Pilot | null; catalogs?: Catalog[]; telegram_connected?: boolean; error?: string } | null
    const list = listResult.data as { ok?: boolean; batches?: Batch[]; error?: string } | null
    if (statusResult.error || !status?.ok) setMessage({ ok: false, text: status?.error ?? statusResult.error?.message ?? 'Could not load commerce status.' })
    else {
      const nextCatalogs = status.catalogs ?? []
       setPilot(status.pilot ?? null); setCatalogs(nextCatalogs); setTelegramConnected(Boolean(status.telegram_connected))
      if (!selectedCatalogId && nextCatalogs[0]) setCatalogId(nextCatalogs[0].id)
    }
    if (listResult.error || !list?.ok) setMessage({ ok: false, text: list?.error ?? listResult.error?.message ?? 'Could not load staged imports.' })
    else setBatches(list.batches ?? [])
    setLoading(false)
  }, [catalogId, loadSkus])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const discover = async () => {
    if (!supabase || busy) return
    setBusy('discover'); setMessage(null)
    const { data, error } = await supabase.functions.invoke('commerce-control', { body: { action: 'discover_uzum' } })
    const result = data as { ok?: boolean; catalogs?: Catalog[]; error?: string } | null
    if (error || !result?.ok) setMessage({ ok: false, text: result?.error ?? error?.message ?? 'Could not discover Uzum shops.' })
    else { setMessage({ ok: true, text: `${result.catalogs?.length ?? 0} Uzum shop(s) discovered.` }); await load() }
    setBusy(null)
  }

  const startPilot = async () => {
    if (!supabase || busy) return
    setBusy('start'); setMessage(null)
    const { data, error } = await supabase.functions.invoke('commerce-control', { body: { action: 'start_pilot' } })
    const result = data as { ok?: boolean; error?: string } | null
    if (error || !result?.ok) setMessage({ ok: false, text: result?.error ?? error?.message ?? 'Could not start the commerce pilot.' })
    else { setMessage({ ok: true, text: 'Your 14-day commerce pilot has started.' }); await load() }
    setBusy(null)
  }

  const autofill = async () => {
    if (!supabase || !catalogId || busy) return
    setBusy('autofill'); setMessage(null)
    const { data, error } = await supabase.functions.invoke('commerce-control', { body: { action: 'autofill_economics', catalog_id: catalogId } })
    const result = data as { ok?: boolean; result?: { cost_estimated: number; supply_estimated: number }; error?: string } | null
    if (error || !result?.ok) setMessage({ ok: false, text: result?.error ?? error?.message ?? 'Could not auto-fill estimates.' })
    else {
      setMessage({ ok: true, text: `Estimated cost for ${result.result?.cost_estimated ?? 0} SKU(s) and delivery terms for ${result.result?.supply_estimated ?? 0}. These are estimates — correct your bestsellers below.` })
      await loadSkus(catalogId)
    }
    setBusy(null)
  }

  const saveSku = async (skuId: string, payload: Record<string, number | string>) => {
    if (!supabase) return false
    const { data, error } = await supabase.functions.invoke('commerce-control', { body: { action: 'update_sku_economics', sku_id: skuId, ...payload } })
    const result = data as { ok?: boolean; error?: string } | null
    if (error || !result?.ok) { setMessage({ ok: false, text: result?.error ?? error?.message ?? 'Could not save SKU economics.' }); return false }
    await loadSkus(catalogId)
    return true
  }

  const connectTelegram = async () => {
    // Without claiming `busy` a double click minted several one-time links in the same second.
    if (!supabase || busy) return
    setBusy('connect'); setMessage(null)
    const { data, error } = await supabase.functions.invoke('commerce-control', { body: { action: 'create_telegram_link' } })
    if (error || !data?.ok) setMessage({ ok: false, text: data?.error ?? error?.message ?? 'Could not create Telegram link.' })
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
      if (missing.length) throw new Error(`Missing canonical columns: ${missing.join(', ')}`)
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
      if (!rows.length) throw new Error('The file has no data rows.')
      if (rows.length > 500) throw new Error('Imports are limited to 500 rows.')
      const { data, error } = await supabase.functions.invoke('commerce-control', { body: { action: 'stage_import', catalog_id: catalogId, file_name: file.name, file_sha256: await hashFile(file), rows } })
      const result = data as { ok?: boolean; batch?: Batch; error?: string } | null
      if (error || !result?.ok) setMessage({ ok: false, text: result?.error ?? error?.message ?? 'Could not stage import.' })
      else {
        const batch = result.batch!
        setMessage({ ok: true, text: `Staged ${batch.total_rows} rows: ${batch.valid_rows} valid, ${batch.unmatched_rows} unmatched, ${batch.error_rows} invalid.` })
        await load(catalogId)
      }
    } catch (error) { setMessage({ ok: false, text: error instanceof Error ? error.message : 'Could not read import file.' }) }
    setBusy(null)
  }

  const staged = batches.filter((batch) => batch.status === 'staged')
  const selectedCatalog = catalogs.find((catalog) => catalog.id === catalogId)

  return (
    <div className="container-page max-w-5xl py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet/15 text-violet"><Database size={20} /></span><div><h1 className="text-2xl font-semibold tracking-tight text-text">Commerce</h1><p className="text-sm text-muted">Uzum catalog discovery and economics imports.</p></div></div>
        <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={startPilot} loading={busy === 'start'} disabled={!isSupabaseEnabled || pilot?.status === 'active'}>Start 14-day pilot</Button><Button variant="outline" onClick={discover} loading={busy === 'discover'} disabled={!isSupabaseEnabled || pilot?.status !== 'active'} leftIcon={<Search size={15} />}>Discover Uzum shops</Button></div>
      </div>

      {message && <div className={`mt-5 flex items-start gap-2 rounded-xl px-3 py-2 text-sm ${message.ok ? 'bg-teal/10 text-teal' : 'bg-danger/10 text-danger'}`}><>{message.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <AlertCircle size={16} className="mt-0.5 shrink-0" />}</><span>{message.text}{!message.ok && ' Discovery and import staging require an owner role; the API enforces this restriction.'}</span></div>}

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" padding="md"><p className="text-xs font-medium uppercase tracking-wide text-muted">Pilot status</p><p className="mt-2 text-lg font-semibold text-text">{loading ? 'Loading...' : pilot?.status ?? 'Not started'}</p><p className="mt-1 text-xs text-muted">{pilot?.expires_at ? `Expires ${new Date(pilot.expires_at).toLocaleDateString()}` : 'No pilot record is available for this account.'}</p></Card>
        <Card padding="md"><p className="text-xs font-medium uppercase tracking-wide text-muted">Catalogs</p><p className="mt-2 text-lg font-semibold text-text">{catalogs.length}</p><p className="mt-1 text-xs text-muted">{selectedCatalog ? `${selectedCatalog.name} · ${selectedCatalog.status}` : 'Discover a shop to begin.'}</p></Card>
      </div>

      <Card className="mt-4" padding="md"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-semibold text-text">Telegram notifications</p><p className="mt-1 text-xs text-muted">Daily digest at 09:00 Tashkent time and immediate critical stock alerts.</p></div>{telegramConnected ? <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-teal/10 px-3 py-1.5 text-xs font-medium text-teal"><CheckCircle2 size={14} /> Connected</span> : <Button onClick={connectTelegram}>Connect Telegram notifications</Button>}</div>{telegramLink && <a href={telegramLink} target="_blank" rel="noreferrer" className="mt-3 inline-flex text-sm font-medium text-violet underline">Open Telegram and press Start</a>}{!telegramConnected && !telegramLink && <p className="mt-3 text-xs text-amber">Connect a Telegram bot in AI Teams first. Nemo will never change Uzum prices or create orders automatically.</p>}</Card>

      <Card className="mt-4" padding="md">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-text">Unit economics</p>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">Nemo pulls titles, prices, stock and sales from Uzum automatically. Only your supplier cost and delivery time are missing — auto-fill rough estimates, then correct your top sellers. Rows marked <span className="font-semibold text-amber">≈</span> are estimates: they power planning but never trigger critical alerts until you confirm them.</p>
          </div>
          <Button variant="outline" onClick={autofill} loading={busy === 'autofill'} disabled={!catalogId || !skus.length} leftIcon={<Wand2 size={15} />}>Auto-fill estimates</Button>
        </div>
        <div className="mt-4">{loading ? <p className="text-sm text-muted">Loading SKUs...</p> : <CommerceSkuTable skus={skus} onSave={saveSku} />}</div>
      </Card>

      <Card className="mt-4" padding="md">
        <div className="grid gap-4 sm:grid-cols-2 sm:items-end"><label className="space-y-1.5"><span className="block text-xs font-medium uppercase tracking-wide text-muted">Catalog</span><select value={catalogId} onChange={(event) => { setCatalogId(event.target.value); void load(event.target.value) }} className={inputClass} disabled={!catalogs.length}><option value="">Select a catalog</option>{catalogs.map((catalog) => <option key={catalog.id} value={catalog.id} className="bg-panel">{catalog.name} ({catalog.source})</option>)}</select></label><label className="block"><span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted">Economics file</span><span className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-violet/35 bg-violet/[0.04] px-3 py-2 text-sm text-violet hover:bg-violet/[0.08]"><Upload size={15} />{busy === 'stage' ? 'Staging import...' : 'Choose CSV or XLSX'}<input className="sr-only" type="file" accept=".csv,.xlsx" disabled={!catalogId || busy === 'stage'} onChange={(event) => { const file = event.target.files?.[0]; if (file) void stageFile(file); event.currentTarget.value = '' }} /></span></label></div>
        <p className="mt-3 text-xs leading-relaxed text-muted">Bulk alternative to the table above — optional. Required canonical headers: <code className="text-fog">{headers.join(', ')}</code>. <code className="text-fog">unit_cost_uzs</code> and <code className="text-fog">fulfillment_uzs</code> are converted to integer tiyin before staging.</p>
      </Card>

      <Card className="mt-4" padding="md"><div className="flex items-center justify-between gap-3"><div><p className="text-sm font-semibold text-text">Staged imports</p><p className="text-xs text-muted">{staged.length} staged batch{staged.length === 1 ? '' : 'es'} in this catalog.</p></div><span className="rounded-full bg-violet/10 px-3 py-1 text-sm font-semibold text-violet">{staged.reduce((sum, batch) => sum + batch.total_rows, 0)} rows</span></div>{staged.length > 0 && <div className="mt-4 space-y-2">{staged.map((batch) => <div key={batch.id} className="flex flex-col gap-1 rounded-xl border border-white/7 bg-white/[0.02] px-3 py-2 text-xs text-muted sm:flex-row sm:items-center sm:justify-between"><span>{new Date(batch.created_at).toLocaleString()}</span><span>{batch.total_rows} rows · {batch.valid_rows} valid · {batch.unmatched_rows} unmatched · {batch.error_rows} invalid</span></div>)}</div>}</Card>
    </div>
  )
}
