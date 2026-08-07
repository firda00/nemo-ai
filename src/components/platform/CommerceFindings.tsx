import { AlertTriangle, PackageX, TrendingDown } from 'lucide-react'
import { useI18n } from '../../i18n'

export type Finding = {
  id: string
  kind: string
  severity: string
  calculation: Record<string, unknown> | null
  suggested_action: Record<string, unknown> | null
  title: string
  external_sku: string
}

const money = (tiyin: unknown, unit: string) =>
  typeof tiyin === 'number' ? `${Math.round(tiyin / 100).toLocaleString('ru-RU')} ${unit}` : '—'
const percent = (value: unknown) => (typeof value === 'number' ? `${value.toFixed(1)}%` : '—')

/**
 * What the sync concluded, on the screen where the owner can act on it.
 *
 * Until now these lived only in the database and the Telegram digest: the page showed every input
 * and none of the conclusions. The Zero Noise rule from the digest holds here too — findings that
 * need a decision are listed one by one, and the large quiet background collapses into a single
 * line. Ninety-three names is a wall on a phone and a wall on a laptop.
 */
export function CommerceFindings({ findings, loading }: { findings: Finding[]; loading: boolean }) {
  const { t } = useI18n()
  const unit = t('commerce.sku.currency')

  if (loading) return <p className="text-sm text-muted">{t('commerce.findings.loading')}</p>
  if (!findings.length) return <p className="text-sm text-muted">{t('commerce.findings.empty')}</p>

  const stockouts = findings.filter((row) => row.kind === 'stockout')
  const urgentStockouts = stockouts.filter((row) => row.severity === 'critical')
  const quietStockouts = stockouts.length - urgentStockouts.length
  const priceIssues = findings.filter((row) => row.kind === 'price_guard')
  const reorders = findings.filter((row) => row.kind === 'reorder')

  return (
    <div className="space-y-5">
      {urgentStockouts.length > 0 && (
        <section>
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-danger">
            <PackageX size={14} /> {t('commerce.findings.stockoutUrgent')} · {urgentStockouts.length}
          </h3>
          <ul className="mt-2 space-y-1.5">
            {urgentStockouts.map((row) => (
              <li key={row.id} className="rounded-xl border border-danger/20 bg-danger/[0.06] px-3 py-2 text-xs">
                <p className="font-medium text-text">{row.title}</p>
                <p className="mt-0.5 text-muted">
                  {t('commerce.findings.soldLastWeek')} {String(row.calculation?.sold_units_7d ?? '—')} · {money(row.calculation?.price_tiyin, unit)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {reorders.length > 0 && (
        <section>
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber">
            <AlertTriangle size={14} /> {t('commerce.findings.reorder')} · {reorders.length}
          </h3>
          <ul className="mt-2 space-y-1.5">
            {reorders.slice(0, 10).map((row) => (
              <li key={row.id} className="rounded-xl border border-ice/10 bg-panel/60 px-3 py-2 text-xs">
                <p className="font-medium text-text">{row.title}</p>
                <p className="mt-0.5 text-muted">
                  {t('commerce.findings.stockLeft')} {String(row.calculation?.stock_total ?? '—')} · {t('commerce.findings.order')} <span className="text-text">{String(row.suggested_action?.units ?? '—')}</span>
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {priceIssues.length > 0 && (
        <section>
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber">
            <TrendingDown size={14} /> {t('commerce.findings.margin')} · {priceIssues.length}
          </h3>
          <ul className="mt-2 space-y-1.5">
            {priceIssues.slice(0, 10).map((row) => {
              // The floor price is the actionable half: "below target" is a complaint, "sell above
              // this and you are not" is an instruction.
              const estimated = Array.isArray(row.calculation?.estimated_inputs) ? row.calculation.estimated_inputs as string[] : []
              return (
                <li key={row.id} className="rounded-xl border border-ice/10 bg-panel/60 px-3 py-2 text-xs">
                  <p className="font-medium text-text">{row.title}</p>
                  <p className="mt-0.5 text-muted">
                    {t('commerce.findings.marginNow')} <span className="text-text">{percent(row.calculation?.margin_percent)}</span>
                    {' · '}{t('commerce.findings.floor')} <span className="text-accent-cyan">{money(row.calculation?.min_selling_price_tiyin, unit)}</span>
                    {/* Named, because an owner deciding on a price is entitled to know the number
                        rests on a Nemo guess rather than on their own figure. */}
                    {estimated.length > 0 && <span className="ml-1 text-amber" title={t('commerce.findings.estimatedTitle')}>≈</span>}
                  </p>
                </li>
              )
            })}
            {priceIssues.length > 10 && <li className="px-3 text-xs text-muted">{t('commerce.findings.andMore').replace('{n}', String(priceIssues.length - 10))}</li>}
          </ul>
        </section>
      )}

      {quietStockouts > 0 && (
        <p className="rounded-xl border border-ice/10 bg-bg/40 px-3 py-2 text-xs text-muted">
          <PackageX size={13} className="mr-1.5 inline" />
          {t('commerce.findings.stockoutQuiet').replace('{n}', String(quietStockouts))}
        </p>
      )}
    </div>
  )
}
