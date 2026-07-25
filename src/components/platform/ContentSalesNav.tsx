import { Link } from 'react-router-dom'
import { ArrowLeft, PenLine, Repeat, Send } from 'lucide-react'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

type Section = 'content' | 'autopost' | 'followups'

export function ContentSalesNav({ active }: { active: Section }) {
  const { t } = useI18n()
  const items = [
    { id: 'content' as const, to: '/app/content', label: t('appLayout.navContent'), icon: PenLine },
    { id: 'autopost' as const, to: '/app/autopost', label: t('appLayout.navAutopost'), icon: Send },
    { id: 'followups' as const, to: '/app/followups', label: t('appLayout.navFollowups'), icon: Repeat },
  ]

  return (
    <nav aria-label={t('appLayout.navContent')} className="mb-6 flex flex-wrap items-center gap-2 rounded-2xl border border-cyan/15 bg-cyan/[0.04] p-2">
      {active !== 'content' && (
        <Link to="/app/content" className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium text-cyan transition hover:bg-cyan/10">
          <ArrowLeft size={14} /> {t('appLayout.navContent')}
        </Link>
      )}
      {items.filter((item) => active === 'content' || item.id !== 'content').map((item) => (
        <Link
          key={item.id}
          to={item.to}
          aria-current={active === item.id ? 'page' : undefined}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium transition',
            active === item.id
              ? 'border-violet/40 bg-violet/12 text-text'
              : 'border-transparent text-muted hover:border-ice/10 hover:bg-white/[0.03] hover:text-text',
          )}
        >
          <item.icon size={14} /> {item.label}
        </Link>
      ))}
    </nav>
  )
}
