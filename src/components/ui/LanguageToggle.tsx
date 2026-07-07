import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'
import type { Lang } from '../../types'

const langs: { code: Lang; label: string }[] = [
  { code: 'uz', label: 'UZ' },
  { code: 'ru', label: 'RU' },
  { code: 'en', label: 'EN' },
]

export function LanguageToggle({ className, showLabel = false }: { className?: string; showLabel?: boolean }) {
  const { lang, setLang, t } = useI18n()
  return (
    <div className={cn('inline-flex items-center gap-2', className)}>
      {showLabel && <span className="hidden text-xs font-medium uppercase tracking-[0.18em] text-muted sm:inline">Language</span>}
      <div
        className="inline-flex items-center gap-1 rounded-pill border border-white/15 bg-white/[0.06] p-0.5 shadow-[0_0_0_1px_rgb(255,255,255,0.03)]"
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
                active ? 'bg-indigo text-white shadow-glow' : 'text-fog hover:text-ink',
              )}
              aria-pressed={active}
            >
              {l.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
