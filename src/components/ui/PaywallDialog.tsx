import { Lock } from 'lucide-react'
import { Button } from './Button'
import { useI18n } from '../../i18n'
import { salesChatUrl, type Paywall } from '../../lib/paywall'

/**
 * Замок с объяснением, а не с извинением.
 *
 * Три вещи обязаны быть на экране одновременно, иначе окно работает против оплаты:
 *  — что именно перестало работать (генерация, сводки, цены), а не «доступ ограничен»;
 *  — что данные НА МЕСТЕ. Владелец, решивший, что потерял каталог, не платит, а уходит;
 *  — куда нажать. Окно без выхода — это стена, а не предложение.
 *
 * Текст причины приходит с сервера: он же уходит в Telegram, и два разных объяснения одного
 * отказа в двух местах — это два разных продукта в глазах владельца.
 */
export function PaywallDialog({ paywall, onClose }: { paywall: Paywall | null; onClose: () => void }) {
  const { t } = useI18n()
  if (!paywall) return null
  const title = paywall.reason === 'trial_expired' ? t('paywall.trialTitle') : t('paywall.lapsedTitle')
  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="modal-panel relative w-full max-w-md rounded-2xl p-6 animate-fadeInUp">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-amber/10 text-amber"><Lock size={18} /></span>
          <h3 className="text-lg font-semibold text-text">{title}</h3>
        </div>

        <p className="mt-3 text-sm leading-relaxed text-muted">{t('paywall.subtitle')}</p>

        <ul className="mt-3 space-y-1.5 text-sm text-fog">
          <li>• {t('paywall.lockedListing')}</li>
          <li>• {t('paywall.lockedDigest')}</li>
          <li>• {t('paywall.lockedPrice')}</li>
        </ul>

        {/* Отдельной строкой и спокойным тоном: это единственное, что удерживает от ухода. */}
        <p className="mt-4 rounded-xl border border-teal/25 bg-teal/[0.06] px-3 py-2 text-xs leading-relaxed text-teal">
          {t('paywall.dataKept')}
        </p>

        {/* Слово сервера. Оно же уходит в Telegram — расхождение читалось бы как две разные системы. */}
        {paywall.message && <p className="mt-3 text-xs leading-relaxed text-muted">{paywall.message}</p>}

        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose}>{t('paywall.later')}</Button>
          <Button onClick={() => window.open(salesChatUrl(), '_blank', 'noopener,noreferrer')}>
            {t('paywall.cta')}
          </Button>
        </div>
      </div>
    </div>
  )
}
