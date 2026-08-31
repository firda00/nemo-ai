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
  const activeIndex = langs.findIndex((item) => item.code === lang)
  return (
    <div className={cn('inline-flex items-center gap-2', className)}>
      {showLabel && <span className="hidden text-xs font-medium tracking-wide text-muted sm:inline">{t('common.language')}</span>}
      <div
        className="relative grid grid-cols-3 rounded-xl border border-ice/[0.09] bg-card/[0.04] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
        role="group"
        aria-label={t('common.language')}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-1 left-1 top-1 w-[calc((100%-0.5rem)/3)] rounded-lg border border-ice/[0.08] bg-panel shadow-[0_4px_12px_-6px_rgba(15,23,42,0.8)] transition-transform duration-300 ease-out"
          style={{ transform: `translateX(${activeIndex * 100}%)` }}
        />
        {langs.map((l) => {
          const active = lang === l.code
          return (
            <button
              key={l.code}
              onClick={() => setLang(l.code)}
              className={cn('relative z-10 min-w-9 rounded-lg px-2 py-1.5 text-[10px] font-bold tracking-[0.08em] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40', active ? 'text-text' : 'text-fog hover:text-text')}
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
