import { useState } from 'react'
import { Check, Loader2, PenLine, Sparkles, Trash2 } from 'lucide-react'
import { Button } from '../ui/Button'
import { useI18n } from '../../i18n'

export type ListingDraft = {
  id: string
  source_text: string
  title_ru: string | null
  title_uz: string | null
  description_ru: string | null
  description_uz: string | null
  attributes: Array<{ name: string; value: string }> | null
  unknown_attributes: string[] | null
  uzum_category: string | null
  commission_percent: number | null
  returns_reserve_percent: number | null
  length_mm: number | null
  width_mm: number | null
  height_mm: number | null
  weight_g: number | null
  fulfillment_tiyin: number | null
  unit_cost_tiyin: number | null
  min_margin_percent: number | null
  min_selling_price_tiyin: number | null
  missing: string[] | null
  evidence: string[] | null
  status: string
  created_at: string
}

export type CategoryChoice = { category: string; commission_percent: number; returns_reserve_percent: number | null; skus: number }

const money = (tiyin: number | null, unit: string) => (tiyin == null ? '—' : `${(tiyin / 100).toLocaleString('ru-RU')} ${unit}`)
const inputClass = 'w-full rounded-xl border border-ice/12 bg-bg/60 px-3 py-2 text-sm text-text outline-none focus:border-accent-cyan/60'

export function CommerceListingAgent({
  drafts,
  categoryChoices,
  onDraft,
  onApprove,
  onDiscard,
}: {
  drafts: ListingDraft[]
  categoryChoices: CategoryChoice[]
  onDraft: (sourceText: string, category: string | null) => Promise<boolean>
  onApprove: (draftId: string) => Promise<boolean>
  onDiscard: (draftId: string) => Promise<boolean>
}) {
  const { t } = useI18n()
  const [sourceText, setSourceText] = useState('')
  const [category, setCategory] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const submit = async () => {
    if (sourceText.trim().length < 10 || busy) return
    setBusy('draft')
    if (await onDraft(sourceText.trim(), category || null)) {
      setSourceText('')
      setCategory('')
    }
    setBusy(null)
  }

  const decide = async (draftId: string, approve: boolean) => {
    if (busy) return
    setBusy(draftId)
    await (approve ? onApprove(draftId) : onDiscard(draftId))
    setBusy(null)
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <textarea
          className={`${inputClass} min-h-[92px] resize-y`}
          placeholder={t('commerce.listing.placeholder')}
          value={sourceText}
          onChange={(event) => setSourceText(event.target.value)}
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          {/* Shown only when the last draft could not match a category on its own. Picking is one
              tap and always right; a guessed commission would silently move every price. */}
          {categoryChoices.length > 0 && (
            <label className="flex-1">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-amber">{t('commerce.listing.pickCategory')}</span>
              <select className={inputClass} value={category} onChange={(event) => setCategory(event.target.value)}>
                <option value="">{t('commerce.listing.noCategory')}</option>
                {categoryChoices.map((choice) => (
                  <option key={choice.category} value={choice.category} className="bg-panel">
                    {choice.category} — {choice.commission_percent}% ({choice.skus})
                  </option>
                ))}
              </select>
            </label>
          )}
          <Button onClick={() => void submit()} loading={busy === 'draft'} disabled={sourceText.trim().length < 10} leftIcon={<Sparkles size={15} />}>
            {t('commerce.listing.create')}
          </Button>
        </div>
      </div>

      {!drafts.length && <p className="text-sm text-muted">{t('commerce.listing.empty')}</p>}

      {drafts.map((draft) => {
        const missing = draft.missing ?? []
        const ready = draft.status === 'ready'
        return (
          <div key={draft.id} className="rounded-xl border border-ice/10 bg-panel/60 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-text">{draft.title_ru ?? t('commerce.listing.noTitle')}</p>
                {draft.title_uz && <p className="truncate text-xs text-muted">{draft.title_uz}</p>}
              </div>
              {ready
                ? <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-teal/10 px-3 py-1 text-xs font-medium text-teal"><Check size={13} /> {t('commerce.listing.ready')}</span>
                : (
                  <div className="flex shrink-0 gap-2">
                    <Button variant="outline" onClick={() => void decide(draft.id, true)} disabled={missing.length > 0 || busy === draft.id}>
                      {busy === draft.id ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {t('commerce.listing.approve')}
                    </Button>
                    <Button variant="ghost" onClick={() => void decide(draft.id, false)} disabled={busy === draft.id}><Trash2 size={13} /></Button>
                  </div>
                )}
            </div>

            {/* The economics are the reason this exists: a listing that knows its floor price
                before it is published cannot be sold below cost by accident. */}
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
              <div><dt className="text-muted">{t('commerce.listing.category')}</dt><dd className="text-text">{draft.uzum_category ?? '—'}</dd></div>
              <div><dt className="text-muted">{t('commerce.listing.commission')}</dt><dd className="text-text">{draft.commission_percent == null ? '—' : `${draft.commission_percent}%`}</dd></div>
              <div><dt className="text-muted">{t('commerce.listing.logistics')}</dt><dd className="text-text">{money(draft.fulfillment_tiyin, t('commerce.sku.currency'))}</dd></div>
              <div>
                <dt className="text-muted">{t('commerce.listing.floor')}</dt>
                <dd className={draft.min_selling_price_tiyin == null ? 'text-muted' : 'font-semibold text-accent-cyan'}>
                  {money(draft.min_selling_price_tiyin, t('commerce.sku.currency'))}
                </dd>
              </div>
            </dl>

            {draft.description_ru && <p className="mt-3 text-xs leading-relaxed text-fog">{draft.description_ru}</p>}

            {(draft.attributes ?? []).length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {(draft.attributes ?? []).map((attribute) => (
                  <span key={attribute.name} className="rounded-lg bg-bg/60 px-2 py-1 text-[11px] text-fog">
                    <span className="text-muted">{attribute.name}:</span> {attribute.value}
                  </span>
                ))}
              </div>
            )}

            {/* Everything the draft does NOT know, said out loud. An empty list is what makes a
                draft approvable, so this is the work queue rather than a warning. */}
            {(missing.length > 0 || (draft.unknown_attributes ?? []).length > 0) && (
              <div className="mt-3 rounded-lg border border-amber/20 bg-amber/[0.06] p-2.5">
                <p className="text-[11px] font-medium text-amber">{t('commerce.listing.missingTitle')}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-fog">
                  {[...missing.map((field) => t(`commerce.listing.missing.${field}`)), ...(draft.unknown_attributes ?? [])].join(' · ')}
                </p>
              </div>
            )}

            {(draft.evidence ?? []).length > 0 && (
              <p className="mt-2 text-[11px] text-muted"><PenLine size={11} className="mr-1 inline" />{(draft.evidence ?? []).join(' · ')}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}
