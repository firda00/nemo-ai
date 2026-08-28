import { BookOpen, Blocks, Users, Wrench } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

export function KnowledgeIntegrationNav({ active }: { active: 'dialogues' | 'leads' | 'knowledge' | 'integrations' | 'tools' }) {
  const { t } = useI18n()
  const items = [
    { id: 'leads' as const, to: '/app/lead-forms', label: t('platform.nav.leadForms'), icon: Users },
    { id: 'integrations' as const, to: '/app/integrations', label: t('appLayout.navTools'), icon: Blocks },
    { id: 'knowledge' as const, to: '/app/knowledge', label: t('platform.nav.knowledge'), icon: BookOpen },
    { id: 'tools' as const, to: '/app/tools', label: t('appLayout.navToolsHub'), icon: Wrench },
  ]
  return <nav aria-label={t('teamOffice.navKnowledge')} className="mb-6 flex gap-1 overflow-x-auto rounded-2xl border border-ice/10 bg-white/[0.02] p-1.5">{items.map((item) => <Link key={item.id} to={item.to} aria-current={active === item.id ? 'page' : undefined} className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/40', active === item.id ? 'bg-white/8 text-text shadow-sm' : 'text-muted hover:bg-white/[0.04] hover:text-text')}><item.icon size={14} className={cn(active === item.id && 'text-cyan')} />{item.label}</Link>)}</nav>
}
