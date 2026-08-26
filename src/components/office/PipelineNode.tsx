import { ArrowRight, Database, ShieldCheck } from 'lucide-react'
import { Handle, Position, type NodeProps } from 'reactflow'
import { useI18n } from '../../i18n'
import type { AgentNodeData } from '../../types/orchestrator'
import { cn } from '../../lib/cn'

const statusTone: Record<AgentNodeData['status'], string> = {
  idle: 'border-ice/15',
  queued: 'border-amber/40',
  working: 'border-cyan/50 shadow-[0_0_24px_rgba(34,211,238,0.10)]',
  waiting_approval: 'border-violet/50',
  completed: 'border-teal/40',
  failed: 'border-danger/50',
}

type PipelineNodeData = AgentNodeData & { onSelect?: () => void }

export function PipelineNode({ data, selected }: NodeProps<PipelineNodeData>) {
  const { t } = useI18n()

  return (
    <article
      aria-label={`${data.name}: ${t(`teamOffice.status.${data.status}`)}`}
      className={cn(
        'w-[220px] rounded-xl border bg-panel/95 p-3 shadow-lg transition',
        statusTone[data.status],
        selected && 'ring-2 ring-cyan/35',
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-bg !bg-cyan" />
      <button type="button" onClick={data.onSelect} className="block w-full text-left focus:outline-none focus:ring-2 focus:ring-cyan/35">
        <div className="flex items-start justify-between gap-3 border-b border-ice/10 pb-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-text">{data.name}</p>
            <p className="truncate text-[11px] text-muted">{data.role}</p>
          </div>
          <span className="rounded-full border border-ice/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-fog">
            {t(`teamOffice.status.${data.status}`)}
          </span>
        </div>
        <div className="mt-2.5 space-y-1.5 text-[11px] text-muted">
          <p className="flex items-center gap-1.5"><Database size={12} className="text-cyan" />A2A Wire v1</p>
          <p className="flex items-center gap-1.5"><ShieldCheck size={12} className="text-teal" />{data.tools.length} allowed tools</p>
        </div>
        <div className="mt-2.5 flex items-center justify-between border-t border-ice/10 pt-2 text-[10px] text-fog">
          <span>{data.metrics.tasksCompleted} completed</span>
          <ArrowRight size={12} aria-hidden />
        </div>
      </button>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-bg !bg-violet" />
    </article>
  )
}
