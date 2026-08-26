import { X } from 'lucide-react'
import type { AgentNodeData } from '../../types/orchestrator'
import { useI18n } from '../../i18n'

export function AgentDrawer({ agent, onClose }: { agent: AgentNodeData | null; onClose: () => void }) {
  const { t } = useI18n()
  if (!agent) return null
  return (
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-labelledby="office-agent-title">
      <button type="button" className="absolute inset-0 bg-black/55" onClick={onClose} aria-label={t('common.close')} />
      <aside className="absolute inset-y-0 right-0 w-full max-w-md overflow-y-auto border-l border-ice/10 bg-panel p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div><p className="text-xs text-cyan">{agent.role}</p><h2 id="office-agent-title" className="mt-1 text-xl font-semibold text-text">{agent.name}</h2></div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-muted hover:bg-white/5 hover:text-text" aria-label={t('common.close')}><X size={18} /></button>
        </div>
        <dl className="mt-6 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-xl border border-ice/10 p-3"><dt className="text-xs text-fog">{t('teamOffice.drawer.status')}</dt><dd className="mt-1 text-text">{t(`teamOffice.status.${agent.status}`)}</dd></div>
          <div className="rounded-xl border border-ice/10 p-3"><dt className="text-xs text-fog">{t('teamOffice.drawer.completed')}</dt><dd className="mt-1 text-text">{agent.metrics.tasksCompleted}</dd></div>
          <div className="col-span-2 rounded-xl border border-ice/10 p-3"><dt className="text-xs text-fog">{t('teamOffice.drawer.model')}</dt><dd className="mt-1 break-all text-text">{agent.model ?? '—'} · {agent.provider ?? '—'}</dd></div>
          <div className="col-span-2 rounded-xl border border-ice/10 p-3"><dt className="text-xs text-fog">{t('teamOffice.drawer.configuration')}</dt><dd className="mt-1 text-text">{agent.configurationSummary ? t(`teamOffice.configuration.${agent.configurationSummary}`) : '—'}</dd></div>
        </dl>
        <section className="mt-5"><h3 className="text-sm font-semibold text-text">{t('teamOffice.drawer.tools')}</h3><div className="mt-2 flex flex-wrap gap-2">{agent.tools.length ? agent.tools.map((tool) => <span key={tool} className="rounded-lg border border-ice/10 px-2 py-1 text-xs text-muted">{tool}</span>) : <span className="text-sm text-muted">—</span>}</div></section>
        <section className="mt-6"><h3 className="text-sm font-semibold text-text">{t('teamOffice.drawer.events')}</h3><p className="mt-1 text-xs text-fog">{t('teamOffice.drawer.safeEvents')}</p><ol className="mt-3 space-y-2">{agent.events?.length ? agent.events.map((event) => <li key={event.id} className="rounded-xl border border-ice/10 p-3 text-xs"><p className="text-text">{event.label in ({ brief_analysis: 1, estimate_calculation: 1, video_rendering: 1, awaiting_approval: 1, task_completed: 1, task_failed: 1 }) ? t(`teamOffice.tasks.${event.label}`) : t(`teamOffice.status.${event.status}`)}</p><time className="mt-1 block text-fog">{new Date(event.occurredAt).toLocaleString()}</time></li>) : <li className="text-sm text-muted">{t('teamOffice.drawer.noEvents')}</li>}</ol></section>
      </aside>
    </div>
  )
}

