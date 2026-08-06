import { useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { useI18n } from '../../i18n'

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

type FieldDef = { key: EditableField; labelKey: string; hintKey: string; toInput: (sku: CommerceSku) => string; toPayload: (value: string) => number | string }
const fields: FieldDef[] = [
  { key: 'unit_cost_tiyin', labelKey: 'commerce.sku.cost', hintKey: 'commerce.sku.costHint', toInput: (sku) => (sku.unit_cost_tiyin == null ? '' : String(sku.unit_cost_tiyin / 100)), toPayload: (value) => (/^\d+(?:\.\d{1,2})?$/.test(value) ? Math.round(Number(value) * 100) : value) },
  { key: 'lead_time_days', labelKey: 'commerce.sku.lead', hintKey: 'commerce.sku.leadHint', toInput: (sku) => (sku.lead_time_days == null ? '' : String(sku.lead_time_days)), toPayload: (value) => value },
  { key: 'safety_stock', labelKey: 'commerce.sku.safety', hintKey: 'commerce.sku.safetyHint', toInput: (sku) => (sku.safety_stock == null ? '' : String(sku.safety_stock)), toPayload: (value) => value },
  { key: 'min_margin_percent', labelKey: 'commerce.sku.margin', hintKey: 'commerce.sku.marginHint', toInput: (sku) => (sku.min_margin_percent == null ? '' : String(sku.min_margin_percent)), toPayload: (value) => value },
]

const cellClass = 'w-24 rounded-lg border border-ice/12 bg-bg/60 px-2 py-1 text-sm text-text outline-none focus:border-accent-cyan/60'
const money = (tiyin: number | null, unit: string) => (tiyin == null ? '—' : `${(tiyin / 100).toLocaleString('ru-RU')} ${unit}`)

export function CommerceSkuTable({ skus, onSave }: { skus: CommerceSku[]; onSave: (skuId: string, payload: Record<string, number | string>) => Promise<boolean> }) {
  const { t } = useI18n()
  const [drafts, setDrafts] = useState<Record<string, Partial<Record<EditableField, string>>>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const valueFor = (sku: CommerceSku, field: FieldDef) => drafts[sku.id]?.[field.key] ?? field.toInput(sku)
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

  if (!skus.length) return <p className="text-sm text-muted">{t('commerce.sku.empty')}</p>

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[840px] text-left text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-muted">
            <th className="pb-2 pr-3 font-medium">{t('commerce.sku.product')}</th>
            <th className="pb-2 pr-3 font-medium">{t('commerce.sku.priceStock')}</th>
            <th className="pb-2 pr-3 font-medium" title={t('commerce.sku.uzumFeesHint')}>{t('commerce.sku.uzumFees')}</th>
            {fields.map((field) => <th key={field.key} className="pb-2 pr-3 font-medium" title={t(field.hintKey)}>{t(field.labelKey)}</th>)}
            <th className="pb-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {skus.map((sku) => {
            const estimated = sku.estimated_fields ?? []
            return (
              <tr key={sku.id} className="border-t border-ice/10 align-middle transition-colors hover:bg-panel/70">
                <td className="py-2 pr-3"><p className="max-w-[220px] truncate text-text" title={sku.title}>{sku.title}</p><p className="text-xs text-muted">{sku.external_sku}</p></td>
                <td className="py-2 pr-3 text-xs text-muted">{money(sku.snapshot?.price_tiyin ?? null, t('commerce.sku.currency'))}<br />{sku.snapshot?.stock_total ?? '—'} {t('commerce.sku.pcs')} · {sku.snapshot?.sold_units_7d ?? '—'} {t('commerce.sku.per7d')}</td>
                {/* Read-only on purpose: Uzum states the commission and the fee follows from the
                    dimensions it declares. An input here would invite editing a fact. */}
                <td className="py-2 pr-3 text-xs text-muted">
                  <span className="text-text">{sku.commission_percent == null ? '—' : `${sku.commission_percent}%`}</span>
                  {' · '}{money(sku.fulfillment_tiyin, t('commerce.sku.currency'))}
                  <br />
                  {t('commerce.sku.returnsShort')} {sku.returns_reserve_percent == null ? '—' : `${sku.returns_reserve_percent}%`}
                  {(sku.estimated_fields ?? []).includes('returns_reserve_percent') && <span title={t('commerce.sku.estimatedTitle')} className="ml-1 font-semibold text-amber">≈</span>}
                </td>
                {fields.map((field) => (
                  <td key={field.key} className="py-2 pr-3">
                    <div className="flex items-center gap-1">
                      <input
                        className={cellClass}
                        inputMode="decimal"
                        value={valueFor(sku, field)}
                        onChange={(event) => setDrafts((current) => ({ ...current, [sku.id]: { ...current[sku.id], [field.key]: event.target.value } }))}
                      />
                      {estimated.includes(field.key) && <span title={t('commerce.sku.estimatedTitle')} className="text-xs font-semibold text-amber">≈</span>}
                    </div>
                  </td>
                ))}
                <td className="py-2">
                  {saved === sku.id
                    ? <span className="inline-flex items-center gap-1 text-xs text-teal"><Check size={14} /> {t('commerce.sku.saved')}</span>
                    : <button type="button" onClick={() => void save(sku)} disabled={!isDirty(sku) || saving === sku.id} className="inline-flex items-center gap-1 rounded-lg border border-accent-indigo/30 bg-accent-indigo/10 px-2.5 py-1 text-xs font-medium text-accent-indigo disabled:opacity-40">{saving === sku.id && <Loader2 size={12} className="animate-spin" />}{t('commerce.sku.save')}</button>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
