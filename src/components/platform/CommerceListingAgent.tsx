import { useState } from 'react'
import { Check, Copy, Loader2, PenLine, Sparkles, Trash2 } from 'lucide-react'
import { Button } from '../ui/Button'
import { useI18n } from '../../i18n'
import { categoryLabel, type CategoryLabel } from '../../lib/categoryLabel'

/**
 * Копирование по одному полю, а не всей карточки.
 *
 * В кабинете Uzum заголовок, описание и каждая характеристика — отдельные поля, и «скопировать
 * всё» там бесполезно: пришлось бы вычищать из буфера чужие строки прямо в форме. Поэтому кнопка
 * стоит у каждого куска, который куда-то вставляется целиком.
 *
 * Подтверждение галочкой обязательно: буфер обмена не виден, и без ответа непонятно, сработало ли
 * нажатие — а повторное нажатие «на всякий случай» ничего не проверяет.
 */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  if (!text) return null
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          window.setTimeout(() => setDone(false), 1500)
        } catch { /* буфер недоступен — молчим, кнопка просто не подтвердит */ }
      }}
      className={`shrink-0 rounded-md p-1 transition ${done ? 'text-teal' : 'text-muted hover:text-accent-cyan'}`}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )
}

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
  /** Поля, значение которых назвал владелец, а не Uzum. */
  owner_stated_fields: string[] | null
  status: string
  created_at: string
}

export type CategoryChoice = { category: string; commission_percent: number; returns_reserve_percent: number | null; skus: number }

/** Комиссия и возвраты, названные владельцем для полки, которой у него ещё нет. */
export type ManualFees = { category: string; commission_percent: number; returns_reserve_percent: number }

/** Значение выбора «моей категории здесь нет». Пустая строка занята вариантом «не выбрано». */
const MANUAL = '__manual__'
/** Не-гардеробный товар возвращают редко. Одежду — часто, и это уже видно по своим полкам. */
const DEFAULT_RETURNS = 5

/**
 * Выбор полки для черновика — своей или названной руками.
 *
 * Список содержит только категории, где продавец УЖЕ торгует: там комиссию назвал сам Uzum, и
 * она факт. Товар из новой ниши такой полки не имеет, и без ручного ввода система упиралась в
 * отказ на каждом первом товаре нового направления.
 *
 * Названное владельцем не выдаётся за прочитанное у Uzum: результат помечается знаком ≈ и
 * остаётся таким, пока полка не появится среди своих.
 */
function CategoryPicker({ categories, labels, lang, busy, onPick, onManual, t }: {
  categories: CategoryChoice[]
  labels: Record<string, CategoryLabel>
  lang: string
  busy: boolean
  onPick: (category: string) => void
  onManual: (input: ManualFees) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  const [mode, setMode] = useState('')
  const [name, setName] = useState('')
  const [commission, setCommission] = useState('')
  const [returns, setReturns] = useState(String(DEFAULT_RETURNS))

  const commissionValue = Number(commission.replace(',', '.'))
  const returnsValue = Number(returns.replace(',', '.'))
  const ready = name.trim().length >= 2
    && Number.isFinite(commissionValue) && commissionValue >= 0 && commissionValue <= 99.99
    && Number.isFinite(returnsValue) && returnsValue >= 0 && returnsValue <= 99.99

  return (
    <div className="mt-3 rounded-lg border border-amber/25 bg-amber/[0.06] p-2.5">
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium text-amber">{t('commerce.listing.pickCategoryHere')}</span>
        <select
          className={inputClass}
          value={mode}
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value
            setMode(value === MANUAL ? MANUAL : '')
            if (value && value !== MANUAL) onPick(value)
          }}
        >
          <option value="">{busy ? t('commerce.listing.recalculating') : t('commerce.listing.noCategory')}</option>
          {/* value — всегда узбекское имя от Uzum: это ключ, по которому сходятся товары и
              считается комиссия. На экран идёт перевод, на сервер — ключ. */}
          {categories.map((choice) => (
            <option key={choice.category} value={choice.category} className="bg-panel">
              {categoryLabel(choice.category, labels, lang)} — {choice.commission_percent}% ({choice.skus})
            </option>
          ))}
          <option value={MANUAL} className="bg-panel">{t('commerce.listing.manualOption')}</option>
        </select>
      </label>

      {mode === MANUAL && (
        <div className="mt-2 space-y-2">
          <input
            className={inputClass}
            placeholder={t('commerce.listing.manualName')}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-[10px] text-muted">{t('commerce.listing.manualCommission')}</span>
              <input className={inputClass} inputMode="decimal" value={commission} onChange={(event) => setCommission(event.target.value)} />
            </label>
            <label className="block">
              {/* Резерв не входит в минимальную цену — возврат по тарифу Uzum не стоит ничего.
                  Он говорит, сколько стока должно двигаться ради одной продажи, и это вопрос
                  закупок. Подпись обязана это сказать, иначе поле выглядит частью цены. */}
              <span className="mb-1 block text-[10px] text-muted">{t('commerce.listing.manualReturns')}</span>
              <input className={inputClass} inputMode="decimal" value={returns} onChange={(event) => setReturns(event.target.value)} />
            </label>
          </div>
          <p className="text-[10px] leading-relaxed text-muted">{t('commerce.listing.manualHint')}</p>
          <Button
            size="sm"
            disabled={!ready || busy}
            onClick={() => onManual({
              category: name.trim(),
              commission_percent: commissionValue,
              returns_reserve_percent: returnsValue,
            })}
          >
            {t('commerce.listing.manualApply')}
          </Button>
        </div>
      )}
    </div>
  )
}

const money = (tiyin: number | null, unit: string) => (tiyin == null ? '—' : `${(tiyin / 100).toLocaleString('ru-RU')} ${unit}`)
const inputClass = 'w-full rounded-xl border border-ice/12 bg-bg/60 px-3 py-2 text-sm text-text outline-none focus:border-accent-cyan/60'

export function CommerceListingAgent({
  drafts,
  categories,
  categoryLabels,
  onDraft,
  onCategory,
  onApprove,
  onDiscard,
}: {
  drafts: ListingDraft[]
  /** Все полки аккаунта — чтобы выбрать её для черновика, который уже написан. */
  categories: CategoryChoice[]
  /** Подписи полок по-русски и по-английски. Uzum отдаёт только узбекское имя. */
  categoryLabels: Record<string, CategoryLabel>
  onDraft: (sourceText: string, category: string | null) => Promise<boolean>
  onCategory: (draftId: string, category: string, manual?: ManualFees) => Promise<boolean>
  onApprove: (draftId: string) => Promise<boolean>
  onDiscard: (draftId: string) => Promise<boolean>
}) {
  const { t, lang } = useI18n()
  const [sourceText, setSourceText] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const submit = async () => {
    if (sourceText.trim().length < 10 || busy) return
    setBusy('draft')
    if (await onDraft(sourceText.trim(), null)) setSourceText('')
    setBusy(null)
  }

  const decide = async (draftId: string, approve: boolean) => {
    if (busy) return
    setBusy(draftId)
    await (approve ? onApprove(draftId) : onDiscard(draftId))
    setBusy(null)
  }

  const pick = async (draftId: string, category: string, manual?: ManualFees) => {
    if (!category || busy) return
    setBusy(draftId)
    await onCategory(draftId, category, manual)
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
        {/* Селектора категории здесь больше нет.
            Он относился к СЛЕДУЮЩЕЙ генерации, а появлялся ровно в тот момент, когда владелец
            смотрел на только что созданный черновик с прочерками вместо комиссии — и читался как
            «выбери полку для него». Выбор ничего не пересчитывал, а поле ввода к этому моменту
            уже очищено после успешной генерации, так что и генерировать было нечего. Полка
            выбирается на самой карточке, где видно, что именно она меняет. */}
        <div className="flex justify-end">
          <Button onClick={() => void submit()} loading={busy === 'draft'} disabled={sourceText.trim().length < 10} leftIcon={<Sparkles size={15} />}>
            {t('commerce.listing.create')}
          </Button>
        </div>
      </div>

      {!drafts.length && <p className="text-sm text-muted">{t('commerce.listing.empty')}</p>}

      {drafts.map((draft) => {
        const missing = draft.missing ?? []
        const ready = draft.status === 'ready'
        const ownerStated = (draft.owner_stated_fields ?? []).includes('commission_percent')
        return (
          <div key={draft.id} className="rounded-xl border border-ice/10 bg-panel/60 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-1">
                  <p className="truncate text-sm font-semibold text-text">{draft.title_ru ?? t('commerce.listing.noTitle')}</p>
                  <CopyButton text={draft.title_ru ?? ''} label={`${t('commerce.listing.copy')} — ${t('commerce.listing.titleRu')}`} />
                </div>
                {draft.title_uz && (
                  <div className="flex items-center gap-1">
                    <p className="truncate text-xs text-muted">{draft.title_uz}</p>
                    <CopyButton text={draft.title_uz} label={`${t('commerce.listing.copy')} — ${t('commerce.listing.titleUz')}`} />
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {/* Один блок для документа или заметки — когда переносят не в форму, а «к себе».
                    Подписан по полям, потому что без подписей это просто слипшийся текст. */}
                <Button
                  variant="ghost" size="sm"
                  onClick={async () => {
                    const block = [
                      [t('commerce.listing.titleRu'), draft.title_ru],
                      [t('commerce.listing.titleUz'), draft.title_uz],
                      [t('commerce.listing.descRu'), draft.description_ru],
                      [t('commerce.listing.descUz'), draft.description_uz],
                      [t('commerce.listing.category'), draft.uzum_category],
                      ...(draft.attributes ?? []).map((attribute) => [attribute.name, attribute.value] as const),
                      [t('commerce.listing.floor'), money(draft.min_selling_price_tiyin, t('commerce.sku.currency'))],
                    ].filter(([, value]) => value).map(([name, value]) => `${name}: ${value}`).join('\n')
                    try { await navigator.clipboard.writeText(block) } catch { /* буфер недоступен */ }
                  }}
                  leftIcon={<Copy size={13} />}
                >
                  {t('commerce.listing.copyAll')}
                </Button>
                {ready
                  ? <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-teal/10 px-3 py-1 text-xs font-medium text-teal"><Check size={13} /> {t('commerce.listing.ready')}</span>
                  : (
                    <>
                      <Button variant="outline" onClick={() => void decide(draft.id, true)} disabled={missing.length > 0 || busy === draft.id}>
                        {busy === draft.id ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {t('commerce.listing.approve')}
                      </Button>
                      <Button variant="ghost" onClick={() => void decide(draft.id, false)} disabled={busy === draft.id}><Trash2 size={13} /></Button>
                    </>
                  )}
              </div>
            </div>

            {/* Полка выбирается прямо здесь, на карточке.
                Раньше выпадающий список стоял только над формой генерации и влиял на СЛЕДУЮЩИЙ
                черновик. Владелец, увидев прочерки вместо комиссии, выбирал категорию — и терял
                написанный текст, потому что применить выбор можно было только повторной
                генерацией. Полка меняет арифметику, а не текст, и модель для этого не нужна. */}
            {!draft.uzum_category && draft.status === 'draft' && categories.length > 0 && (
              <CategoryPicker
                categories={categories}
                labels={categoryLabels}
                lang={lang}
                busy={busy === draft.id}
                onPick={(category) => pick(draft.id, category)}
                onManual={(input) => pick(draft.id, input.category, input)}
                t={t}
              />
            )}

            {/* The economics are the reason this exists: a listing that knows its floor price
                before it is published cannot be sold below cost by accident. */}
            {/* Комиссия, названная владельцем, не выдаётся за прочитанную у Uzum: через неделю
                никто, включая саму систему, не отличил бы одно от другого. Тот же знак ≈, что
                и на оценочной себестоимости в находках. */}
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
              <div>
                <dt className="text-muted">{t('commerce.listing.category')}</dt>
                {/* Узбекское имя остаётся в title: именно его владелец ищет в кабинете Uzum. */}
                <dd className="text-text" title={draft.uzum_category ?? undefined}>
                  {draft.uzum_category ? categoryLabel(draft.uzum_category, categoryLabels, lang) : '—'}
                </dd>
              </div>
              <div>
                <dt className="text-muted">{t('commerce.listing.commission')}</dt>
                <dd className="text-text">
                  {draft.commission_percent == null ? '—' : `${draft.commission_percent}%`}
                  {ownerStated && <span className="ml-1 text-amber" title={t('commerce.listing.ownerStatedTitle')}>≈</span>}
                </dd>
              </div>
              <div><dt className="text-muted">{t('commerce.listing.logistics')}</dt><dd className="text-text">{money(draft.fulfillment_tiyin, t('commerce.sku.currency'))}</dd></div>
              <div>
                <dt className="text-muted">{t('commerce.listing.floor')}</dt>
                <dd className={draft.min_selling_price_tiyin == null ? 'text-muted' : 'font-semibold text-accent-cyan'}>
                  {money(draft.min_selling_price_tiyin, t('commerce.sku.currency'))}
                  {ownerStated && draft.min_selling_price_tiyin != null && (
                    <span className="ml-1 text-amber" title={t('commerce.listing.ownerStatedTitle')}>≈</span>
                  )}
                </dd>
              </div>
            </dl>

            {/* Узбекское описание раньше лежало в базе и не показывалось вовсе — а на Uzum его
                вставляют в отдельное поле, и без него карточка неполная. */}
            {/* whitespace-pre-line обязателен: описание теперь состоит из блоков и буллетов, а без
                него HTML схлопнет переносы и на экране снова будет тот же сплошной абзац —
                при том, что в буфер уйдёт правильная разметка. Расхождение хуже обоих вариантов. */}
            {draft.description_ru && (
              <div className="mt-3 flex items-start gap-1">
                <p className="whitespace-pre-line text-xs leading-relaxed text-fog">{draft.description_ru}</p>
                <CopyButton text={draft.description_ru} label={`${t('commerce.listing.copy')} — ${t('commerce.listing.descRu')}`} />
              </div>
            )}
            {draft.description_uz && (
              <div className="mt-2 flex items-start gap-1">
                <p className="whitespace-pre-line text-xs leading-relaxed text-muted">{draft.description_uz}</p>
                <CopyButton text={draft.description_uz} label={`${t('commerce.listing.copy')} — ${t('commerce.listing.descUz')}`} />
              </div>
            )}

            {/* Копируется ЗНАЧЕНИЕ, а не «Цвет: Чёрный»: в форме Uzum название поля уже написано
                слева, и вставлять его повторно значит чинить текст руками после каждой вставки. */}
            {(draft.attributes ?? []).length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {(draft.attributes ?? []).map((attribute) => (
                  <span key={attribute.name} className="flex items-center gap-1 rounded-lg bg-bg/60 px-2 py-1 text-[11px] text-fog">
                    <span className="text-muted">{attribute.name}:</span> {attribute.value}
                    <CopyButton text={attribute.value} label={`${t('commerce.listing.copy')} — ${attribute.name}`} />
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
