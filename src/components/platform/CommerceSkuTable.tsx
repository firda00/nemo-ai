import { useState } from 'react'
import { Check, Loader2 } from 'lucide-react'

export type CommerceSku = {
  id: string
  external_sku: string
  title: string
  unit_cost_tiyin: number | null
  commission_percent: number | null
  fulfillment_tiyin: number | null
  returns_reserve_percent: number | null
  lead_time_days: number | null
  moq: number | null
  safety_stock: number | null
  min_margin_percent: number | null
  estimated_fields: string[] | null
  snapshot: { price_tiyin: number | null; stock_total: number | null; sold_units_7d: number | null } | null
}

type EditableField = 'unit_cost_tiyin' | 'lead_time_days' | 'safety_stock' | 'min_margin_percent'

const fields: Array<{ key: EditableField; label: string; hint: string; toInput: (sku: CommerceSku) => string; toPayload: (value: string) => number | string }> = [
  { key: 'unit_cost_tiyin', label: 'Cost, UZS', hint: 'What you pay your supplier', toInput: (sku) => (sku.unit_cost_tiyin == null ? '' : String(sku.unit_cost_tiyin / 100)), toPayload: (value) => (/^\d+(?:\.\d{1,2})?$/.test(value) ? Math.round(Number(value) * 100) : value) },
  { key: 'lead_time_days', label: 'Lead time, days', hint: 'Supplier delivery time', toInput: (sku) => (sku.lead_time_days == null ? '' : String(sku.lead_time_days)), toPayload: (value) => value },
  { key: 'safety_stock', label: 'Safety stock', hint: 'Buffer units', toInput: (sku) => (sku.safety_stock == null ? '' : String(sku.safety_stock)), toPayload: (value) => value },
  { key: 'min_margin_percent', label: 'Min margin, %', hint: 'Price Guard threshold', toInput: (sku) => (sku.min_margin_percent == null ? '' : String(sku.min_margin_percent)), toPayload: (value) => value },
]

const cellClass = 'w-24 rounded-lg border border-ice/12 bg-bg/60 px-2 py-1 text-sm text-text outline-none focus:border-accent-cyan/60'
const money = (tiyin: number | null) => (tiyin == null ? '—' : `${(tiyin / 100).toLocaleString('ru-RU')} сум`)

export function CommerceSkuTable({ skus, onSave }: { skus: CommerceSku[]; onSave: (skuId: string, payload: Record<string, number | string>) => Promise<boolean> }) {
  const [drafts, setDrafts] = useState<Record<string, Partial<Record<EditableField, string>>>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const valueFor = (sku: CommerceSku, field: typeof fields[number]) => drafts[sku.id]?.[field.key] ?? field.toInput(sku)
  const isDirty = (sku: CommerceSku) => fields.some((field) => (drafts[sku.id]?.[field.key] ?? field.toInput(sku)) !== field.toInput(sku))

  const save = async (sku: CommerceSku) => {
    const draft = drafts[sku.id]
    if (!draft || saving) return
    setSaving(sku.id)
    const payload: Record<string, number | string> = {}
    for (const field of fields) {
      const value = draft[field.key]
      if (value === undefined || value === field.toInput(sku)) continue
      if (value.trim() === '') continue
      payload[field.key] = field.toPayload(value.trim())
    }
    const ok = Object.keys(payload).length ? await onSave(sku.id, payload) : true
    if (ok) {
      setDrafts((current) => { const next = { ...current }; delete next[sku.id]; return next })
      setSaved(sku.id)
      window.setTimeout(() => setSaved((current) => (current === sku.id ? null : current)), 2000)
    }
    setSaving(null)
  }

  if (!skus.length) return <p className="text-sm text-muted">No SKUs yet. Run a catalog sync first — Nemo pulls titles, prices, stock and sales from Uzum automatically.</p>

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[840px] text-left text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-muted">
            <th className="pb-2 pr-3 font-medium">Product</th>
            <th className="pb-2 pr-3 font-medium">Price / stock</th>
            {fields.map((field) => <th key={field.key} className="pb-2 pr-3 font-medium" title={field.hint}>{field.label}</th>)}
            <th className="pb-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {skus.map((sku) => {
            const estimated = sku.estimated_fields ?? []
            return (
              <tr key={sku.id} className="border-t border-ice/10 align-middle transition-colors hover:bg-panel/70">
                <td className="py-2 pr-3"><p className="max-w-[220px] truncate text-text" title={sku.title}>{sku.title}</p><p className="text-xs text-muted">{sku.external_sku}</p></td>
                <td className="py-2 pr-3 text-xs text-muted">{money(sku.snapshot?.price_tiyin ?? null)}<br />{sku.snapshot?.stock_total ?? '—'} шт · {sku.snapshot?.sold_units_7d ?? '—'}/7д</td>
                {fields.map((field) => (
                  <td key={field.key} className="py-2 pr-3">
                    <div className="flex items-center gap-1">
                      <input
                        className={cellClass}
                        inputMode="decimal"
                        value={valueFor(sku, field)}
                        onChange={(event) => setDrafts((current) => ({ ...current, [sku.id]: { ...current[sku.id], [field.key]: event.target.value } }))}
                      />
                      {estimated.includes(field.key) && <span title="Estimated by Nemo — confirm to enable critical alerts" className="text-xs font-semibold text-amber">≈</span>}
                    </div>
                  </td>
                ))}
                <td className="py-2">
                  {saved === sku.id
                    ? <span className="inline-flex items-center gap-1 text-xs text-teal"><Check size={14} /> Saved</span>
                    : <button type="button" onClick={() => void save(sku)} disabled={!isDirty(sku) || saving === sku.id} className="inline-flex items-center gap-1 rounded-lg border border-accent-indigo/30 bg-accent-indigo/10 px-2.5 py-1 text-xs font-medium text-accent-indigo disabled:opacity-40">{saving === sku.id && <Loader2 size={12} className="animate-spin" />}Save</button>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
