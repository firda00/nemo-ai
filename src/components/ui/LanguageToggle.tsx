import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'
import type { Lang } from '../../types'

const langs: { code: Lang; label: string }[] = [
  { code: 'uz', label: 'UZ' },
  { code: 'ru', label: 'RU' },
  { code: 'en', label: 'EN' },
]

export function LanguageToggle({ className }: { className?: string }) {
  const { lang, setLang, t } = useI18n()
  return (
    <div
      className={cn('inline-flex items-center gap-1 rounded-pill border border-white/10 bg-white/[0.04] p-0.5', className)}
      role="group"
      aria-label={t('common.language')}
    >
      {langs.map((l) => {
        const active = lang === l.code
        return (
          <button
            key={l.code}
            onClick={() => setLang(l.code)}
            className={cn(
              'rounded-pill px-2.5 py-1 text-xs font-medium transition-colors',
              active ? 'bg-indigo text-white' : 'text-fog hover:text-ink',
            )}
            aria-pressed={active}
          >
            {l.label}
          </button>
        )
      })}
    </div>
  )
}
