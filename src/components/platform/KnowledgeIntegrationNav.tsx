import { BookOpen, Blocks, Wrench } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

export function KnowledgeIntegrationNav({ active }: { active: 'knowledge' | 'integrations' | 'tools' }) {
  const { t } = useI18n()
  const items = [
    { id: 'knowledge' as const, to: '/app/knowledge', label: t('platform.nav.knowledge'), icon: BookOpen },
    { id: 'integrations' as const, to: '/app/integrations', label: t('appLayout.navTools'), icon: Blocks },
    { id: 'tools' as const, to: '/app/tools', label: t('appLayout.navToolsHub'), icon: Wrench },
  ]
  return <nav aria-label={t('teamOffice.navKnowledge')} className="mb-6 flex flex-wrap gap-2 rounded-2xl border border-ice/10 bg-white/[0.02] p-2">{items.map((item) => <Link key={item.id} to={item.to} aria-current={active === item.id ? 'page' : undefined} className={cn('inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium transition', active === item.id ? 'bg-white/8 text-text' : 'text-muted hover:bg-white/[0.04] hover:text-text')}><item.icon size={14} />{item.label}</Link>)}</nav>
}
