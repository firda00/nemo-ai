import { useEffect, useState } from 'react'
import { Users, Sparkles, Trash2, RefreshCw, ChevronDown, Bot } from 'lucide-react'
import { useI18n } from '../../i18n'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useToast } from '../ui/Toast'
import { Button } from '../ui/Button'
import { OrchestratorRunner, type TeamMember } from './OrchestratorRunner'
import { cn } from '../../lib/cn'
import type { Department, SubAgent, PlatformAgent } from '../../types/platform'

const live = isSupabaseEnabled

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mapSub = (r: any): SubAgent => ({
  id: r.id,
  role: r.role,
  name: r.name ?? r.role,
  prompt: r.prompt ?? { role: '', tasks: '', tone: '', rules: '' },
  model: r.model,
  status: r.status,
})

// build a sub-agent's own system prompt from its fields
const subSystem = (sa: SubAgent) =>
  [
    `You are "${sa.name}", a ${sa.role}.`,
    sa.prompt.role && `Role: ${sa.prompt.role}`,
    sa.prompt.tasks && `Tasks: ${sa.prompt.tasks}`,
    sa.prompt.tone && `Tone: ${sa.prompt.tone}`,
    sa.prompt.rules && `Rules: ${sa.prompt.rules}`,
  ]
    .filter(Boolean)
    .join('\n')

const COLORS = ['#22D3EE', '#5B7CF6', '#8B7CF8', '#13C5B4', '#F4A640', '#EC6CB0']

/**
 * Persistent "department" for a manager (workflow) agent: the AI designs a team of
 * specialist sub-agents tailored to the agent's niche, they're saved to the DB, and
 * the whole team can be run on a task. Account-scoped via RLS.
 */
export function DepartmentPanel({ agent }: { agent: PlatformAgent }) {
  const { t } = useI18n()
  const toast = useToast()
  const [dept, setDept] = useState<Department | null>(null)
  const [loading, setLoading] = useState(live)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    if (!live || !supabase) {
      window.setTimeout(() => setLoading(false), 0)
      return
    }
    let on = true
    ;(async () => {
      const { data: depts } = await supabase
        .from('departments')
        .select('*')
        .eq('main_agent_id', agent.id)
        .order('created_at', { ascending: false })
        .limit(1)
      const d = depts?.[0]
      if (!d) {
        if (on) {
          setDept(null)
          setLoading(false)
        }
        return
      }
      const { data: subs } = await supabase.from('sub_agents').select('*').eq('department_id', d.id).order('created_at', { ascending: true })
      if (on) {
        setDept({ id: d.id, name: d.name, niche: d.niche ?? undefined, mainAgentId: d.main_agent_id ?? undefined, subAgents: (subs ?? []).map(mapSub) })
        setLoading(false)
      }
    })()
    return () => {
      on = false
    }
  }, [agent.id])

  const generate = async () => {
    setBusy(true)
    setError('')
    try {
      const goal = [agent.prompt.tasks, agent.prompt.role, agent.name].find((x) => x && x.trim()) || agent.name
      if (!live || !supabase) {
        // demo fallback — a small local team so the flow is visible without a backend
        const demo: SubAgent[] = [
          { id: 's1', role: 'Researcher', name: 'Aziz', prompt: { role: 'Tadqiqotchi', tasks: 'Maʼlumot yigʻadi', tone: 'Aniq', rules: '' } },
          { id: 's2', role: 'Writer', name: 'Dilnoza', prompt: { role: 'Kontent', tasks: 'Matn yozadi', tone: 'Jonli', rules: '' } },
        ]
        setDept({ id: 'dep_demo', name: agent.niche || agent.name, niche: agent.niche, subAgents: demo })
        return
      }
      const { data, error: err } = await supabase.functions.invoke('orchestrate', {
        body: { action: 'staff', goal, niche: agent.niche, purpose: agent.purpose, lang: agent.language !== 'auto' ? agent.language : undefined },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload = data as any
      if (err || !payload?.ok || !Array.isArray(payload.subagents) || !payload.subagents.length) {
        setError(t('platform.research.error'))
        return
      }
      const { data: depRow, error: e2 } = await supabase
        .from('departments')
        .insert({ main_agent_id: agent.id, name: agent.niche || agent.name, niche: agent.niche ?? null })
        .select('*')
        .single()
      if (e2 || !depRow) {
        setError(t('platform.research.error'))
        return
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = payload.subagents.map((s: any) => ({ department_id: depRow.id, role: s.role, name: s.name, prompt: s.prompt, model: agent.model }))
      const { data: subRows } = await supabase.from('sub_agents').insert(rows).select('*')
      setDept({ id: depRow.id, name: depRow.name, niche: depRow.niche ?? undefined, mainAgentId: agent.id, subAgents: (subRows ?? []).map(mapSub) })
      toast(t('platform.department.created'))
    } finally {
      setBusy(false)
    }
  }

  const removeSub = async (id: string) => {
    setDept((d) => (d ? { ...d, subAgents: d.subAgents.filter((s) => s.id !== id) } : d))
    if (live && supabase && !id.startsWith('s')) await supabase.from('sub_agents').delete().eq('id', id)
  }

  const removeDept = async () => {
    const id = dept?.id
    setDept(null)
    if (live && supabase && id && id !== 'dep_demo') await supabase.from('departments').delete().eq('id', id)
  }

  if (loading) return <div className="flex min-h-[30vh] items-center justify-center text-2xl text-muted">…</div>

  // no team yet — invite to generate one
  if (!dept) {
    return (
      <div className="card rounded-2xl p-6">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-white"><Users size={18} /></span>
          <div>
            <h2 className="font-normal text-text">{t('platform.department.title')}</h2>
            <p className="text-xs text-muted">{t('platform.department.subtitle')}</p>
          </div>
        </div>
        {error && <p className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
        <div className="mt-5">
          <Button onClick={generate} disabled={busy}>
            <Sparkles size={16} /> {busy ? t('platform.department.generating') : t('platform.department.generate')}
          </Button>
        </div>
      </div>
    )
  }

  const team: TeamMember[] = dept.subAgents.map((sa) => ({ role: sa.role, name: sa.name, task: sa.prompt.tasks || sa.prompt.role || sa.role, system: subSystem(sa) }))

  return (
    <div className="space-y-5">
      <div className="card rounded-2xl p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet/15 text-violet"><Users size={17} /></span>
            <div>
              <h2 className="font-normal text-text">{dept.name}</h2>
              <p className="text-xs text-muted">{t('platform.department.members')} · {dept.subAgents.length}{dept.niche ? ` · ${dept.niche}` : ''}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={generate} disabled={busy}>
              <RefreshCw size={14} className={cn(busy && 'animate-spin')} /> {t('platform.department.regenerate')}
            </Button>
            <button onClick={removeDept} className="rounded-lg p-2 text-muted hover:bg-ice/[0.06] hover:text-danger" aria-label={t('platform.agents.delete')}>
              <Trash2 size={15} />
            </button>
          </div>
        </div>
        {error && <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}

        <div className="mt-4 space-y-2">
          {dept.subAgents.map((sa, i) => {
            const color = COLORS[i % COLORS.length]
            const isOpen = open === sa.id
            return (
              <div key={sa.id} className="rounded-xl border border-ice/[0.07]">
                <div className="flex items-center gap-2.5 px-3.5 py-2.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ background: `${color}22`, color }}><Bot size={14} /></span>
                  <button onClick={() => setOpen(isOpen ? null : sa.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    <span className="truncate text-sm font-normal text-text">{sa.name}</span>
                    <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: `${color}1a`, color }}>{sa.role}</span>
                    <ChevronDown size={14} className={cn('ml-auto shrink-0 text-muted transition-transform', isOpen && 'rotate-180')} />
                  </button>
                  <button onClick={() => removeSub(sa.id)} className="rounded-lg p-1.5 text-muted hover:bg-ice/[0.06] hover:text-danger" aria-label={t('platform.agents.delete')}>
                    <Trash2 size={14} />
                  </button>
                </div>
                {isOpen && (
                  <div className="space-y-1.5 border-t border-ice/[0.07] px-3.5 py-3 text-[12px] leading-relaxed text-muted">
                    {sa.prompt.role && <p><span className="text-fog">{t('platform.onboarding.role')}:</span> {sa.prompt.role}</p>}
                    {sa.prompt.tasks && <p><span className="text-fog">{t('platform.onboarding.tasks')}:</span> {sa.prompt.tasks}</p>}
                    {sa.prompt.tone && <p><span className="text-fog">{t('platform.onboarding.tone')}:</span> {sa.prompt.tone}</p>}
                    {sa.prompt.rules && <p><span className="text-fog">{t('platform.onboarding.rules')}:</span> {sa.prompt.rules}</p>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* run the saved team on a task */}
      <div>
        <p className="mb-2 text-sm font-normal text-text">{t('platform.department.runTitle')}</p>
        <OrchestratorRunner
          defaultGoal={[agent.prompt.tasks, agent.name].find((x) => x && x.trim()) || ''}
          niche={agent.niche}
          purpose={agent.purpose}
          lang={agent.language !== 'auto' ? agent.language : undefined}
          team={team}
        />
      </div>
    </div>
  )
}
