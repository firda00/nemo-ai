import { Bot, CheckCircle2, Clock3, Monitor, ShieldAlert, Wrench } from 'lucide-react'
import { Handle, Position, type NodeProps } from 'reactflow'
import type { AgentNodeData } from '../../types/orchestrator'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

const statusClass: Record<AgentNodeData['status'], string> = {
  idle: 'border-ice/15', queued: 'border-amber/45', working: 'border-cyan/55 office-node-active',
  waiting_approval: 'border-violet/55 office-node-attention', completed: 'border-teal/45', failed: 'border-danger/55',
}

type DeskNodeData = AgentNodeData & { onSelect?: () => void }

export function AgentDeskNode({ data, selected }: NodeProps<DeskNodeData>) {
  const { t } = useI18n()
  return (
    <article
      aria-label={`${data.name}: ${t(`teamOffice.status.${data.status}`)}`}
      className={cn('w-[230px] rounded-2xl border bg-panel/95 p-3 shadow-xl transition', statusClass[data.status], selected && 'ring-2 ring-cyan/40')}
    >
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-bg !bg-fog" />
      <button type="button" onClick={data.onSelect} className="block w-full rounded-xl text-left focus:outline-none focus:ring-2 focus:ring-cyan/40">
      <div className="flex items-start gap-3">
        <div className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-ice/10 bg-bg text-cyan">
          <Bot size={23} aria-hidden />
          <span className={cn('absolute -bottom-1 -right-1 h-3 w-3 rounded-full border-2 border-panel', data.status === 'working' ? 'bg-cyan' : data.status === 'failed' ? 'bg-danger' : data.status === 'completed' ? 'bg-teal' : 'bg-fog')} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-text">{data.name}</p>
          <p className="truncate text-xs text-muted">{data.role}</p>
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-fog">
            <Monitor size={12} aria-hidden /> {t(`teamOffice.status.${data.status}`)}
          </div>
        </div>
      </div>
      {data.currentTask && <p className="mt-3 rounded-lg border border-ice/10 bg-bg/70 px-2.5 py-2 text-xs text-muted">{t(`teamOffice.tasks.${data.currentTask}`)}</p>}
      <div className="mt-3 flex items-center justify-between border-t border-ice/10 pt-2 text-[10px] text-fog">
        <span className="inline-flex items-center gap-1"><CheckCircle2 size={11} />{data.metrics.tasksCompleted}</span>
        <span className="inline-flex items-center gap-1"><Wrench size={11} />{data.tools.length}</span>
        {data.status === 'waiting_approval' ? <ShieldAlert size={12} className="text-violet" /> : <Clock3 size={11} />}
      </div>
      </button>
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-bg !bg-fog" />
    </article>
  )
}
