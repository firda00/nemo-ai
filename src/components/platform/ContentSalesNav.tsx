import { Link } from 'react-router-dom'
import { ClipboardCheck, PenLine, Repeat, Send, Target, Users } from 'lucide-react'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

type Section = 'marketing' | 'content' | 'autopost' | 'followups' | 'leads' | 'approvals'

export function ContentSalesNav({ active }: { active: Section }) {
  const { t } = useI18n()
  const items = [
    { id: 'marketing' as const, to: '/app/marketing', label: t('teamOffice.marketingTabs.funnels'), icon: Target },
    { id: 'content' as const, to: '/app/content', label: t('appLayout.navContent'), icon: PenLine },
    { id: 'autopost' as const, to: '/app/autopost', label: t('appLayout.navAutopost'), icon: Send },
    { id: 'followups' as const, to: '/app/followups', label: t('appLayout.navFollowups'), icon: Repeat },
    { id: 'leads' as const, to: '/app/lead-forms', label: t('teamOffice.marketingTabs.leads'), icon: Users },
    { id: 'approvals' as const, to: '/app/approvals', label: t('teamOffice.marketingTabs.approvals'), icon: ClipboardCheck },
  ]

  return (
    <nav aria-label={t('appLayout.navContent')} className="mb-6 flex flex-wrap items-center gap-2 rounded-2xl border border-cyan/15 bg-cyan/[0.04] p-2">
      {items.map((item) => (
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
