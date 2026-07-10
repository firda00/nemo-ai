import { useEffect, useState } from 'react'
import { Sparkles, Loader2, TrendingUp, Check, X, History } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

interface Prompt { role: string; tasks: string; tone: string; rules: string }
interface Proposal { evolution_id: string; before?: Prompt; after: Prompt; changelog: string[] }
interface EvoRow { id: string; summary: string | null; applied: boolean; created_at: string }

/**
 * Self-evolution panel: the owner sets a GROWTH DIRECTION, the agent analyzes its recent
 * conversations and proposes an improved config, and the owner applies it. Past evolutions
 * are shown as a growth log.
 */
export function AgentGrowth({ agentId, onApplied }: { agentId: string; onApplied: (p: Prompt) => void }) {
  const { t } = useI18n()
  const [direction, setDirection] = useState('')
  const [busy, setBusy] = useState(false)
  const [applying, setApplying] = useState(false)
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [history, setHistory] = useState<EvoRow[]>([])
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const loadHistory = async () => {
    if (!supabase) return
    const { data } = await supabase.from('agent_evolutions').select('id, summary, applied, created_at').eq('agent_id', agentId).order('created_at', { ascending: false }).limit(5)
    setHistory((data as EvoRow[]) ?? [])
  }

  useEffect(() => {
    let alive = true
    ;(async () => {
      if (!isSupabaseEnabled || !supabase || !agentId) return
      const { data } = await supabase.from('agents').select('growth_direction').eq('id', agentId).maybeSingle()
      if (alive && data?.growth_direction) setDirection(data.growth_direction as string)
      await loadHistory()
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId])

  const analyze = async () => {
    if (!supabase || busy) return
    setBusy(true); setMsg(null); setProposal(null)
    try {
      const { data, error } = await supabase.functions.invoke('evolve-agent', { body: { agent_id: agentId, action: 'analyze', direction: direction.trim() } })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = data as any
      if (error || !p?.ok) { setMsg({ ok: false, text: p?.error || t('agentGrowth.errGeneric') }); return }
      setProposal({ evolution_id: p.evolution_id, before: p.before, after: p.after, changelog: p.changelog ?? [] })
    } catch { setMsg({ ok: false, text: t('agentGrowth.errGeneric') }) } finally { setBusy(false) }
  }

  const apply = async () => {
    if (!supabase || !proposal || applying) return
    setApplying(true); setMsg(null)
    try {
      const { data, error } = await supabase.functions.invoke('evolve-agent', { body: { agent_id: agentId, action: 'apply', evolution_id: proposal.evolution_id } })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = data as any
      if (error || !p?.ok) { setMsg({ ok: false, text: p?.error || t('agentGrowth.errGeneric') }); return }
      onApplied(proposal.after)
      setMsg({ ok: true, text: t('agentGrowth.applied') })
      setProposal(null)
      await loadHistory()
    } catch { setMsg({ ok: false, text: t('agentGrowth.errGeneric') }) } finally { setApplying(false) }
  }

  return (
    <div className="mt-5 rounded-2xl border border-violet/20 bg-violet/[0.05] p-4">
      <p className="flex items-center gap-2 text-sm font-semibold text-text"><TrendingUp size={16} className="text-violet" /> {t('agentGrowth.title')}</p>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">{t('agentGrowth.desc')}</p>

      <label className="mt-3 block space-y-1.5">
        <span className="text-xs text-muted">{t('agentGrowth.directionLabel')}</span>
        <textarea
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
          rows={2}
          placeholder={t('agentGrowth.directionPh')}
          className="w-full resize-y rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-violet/50"
        />
      </label>

      <button onClick={analyze} disabled={busy} className="mt-2 inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition disabled:opacity-40">
        {busy ? <><Loader2 size={15} className="animate-spin" /> {t('agentGrowth.analyzing')}</> : <><Sparkles size={15} /> {t('agentGrowth.analyze')}</>}
      </button>

      {msg && <p className={cn('mt-3 rounded-lg px-3 py-2 text-xs', msg.ok ? 'bg-teal/10 text-teal' : 'bg-danger/10 text-danger')}>{msg.text}</p>}

      {proposal && (
        <div className="mt-3 rounded-xl border border-ice/10 bg-black/20 p-3.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">{t('agentGrowth.proposalTitle')}</p>
          <ul className="mt-2 space-y-1.5">
            {proposal.changelog.map((c, i) => <li key={i} className="flex gap-2 text-[13px] text-muted"><span className="text-violet">•</span> {c}</li>)}
          </ul>

          {/* exact before→after diff so the owner approves the real text (not just the changelog) */}
          {proposal.before && (['role', 'tasks', 'tone', 'rules'] as const).some((k) => (proposal.before as Prompt)[k] !== proposal.after[k]) && (
            <details className="mt-3 rounded-lg border border-ice/[0.07] bg-black/10 [&_summary]:list-none">
              <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-cyan">{t('agentGrowth.willChange')}</summary>
              <div className="space-y-2.5 border-t border-ice/[0.06] px-3 py-2.5">
                {(['role', 'tasks', 'tone', 'rules'] as const).map((k) => {
                  const b = (proposal.before as Prompt)[k] ?? ''
                  const a = proposal.after[k] ?? ''
                  if (b === a) return null
                  return (
                    <div key={k}>
                      <p className="text-[10px] uppercase tracking-wide text-muted">{t('singleAgent.' + k)}</p>
                      <p className="mt-0.5 whitespace-pre-wrap text-[12px] text-danger/80 line-through decoration-danger/40">{b || '—'}</p>
                      <p className="mt-0.5 whitespace-pre-wrap text-[12px] text-teal">{a || '—'}</p>
                    </div>
                  )
                })}
              </div>
            </details>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={apply} disabled={applying} className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-3.5 py-2 text-sm font-medium text-white transition disabled:opacity-40">
              {applying ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {t('agentGrowth.apply')}
            </button>
            <button onClick={() => setProposal(null)} className="inline-flex items-center gap-1.5 rounded-xl border border-ice/12 px-3 py-2 text-sm font-medium text-muted transition hover:text-text">
              <X size={14} /> {t('agentGrowth.dismiss')}
            </button>
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div className="mt-4">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted"><History size={12} /> {t('agentGrowth.historyTitle')}</p>
          <div className="mt-2 space-y-1.5">
            {history.map((h) => (
              <div key={h.id} className="rounded-lg border border-ice/[0.06] bg-white/[0.02] px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className={cn('rounded-full px-2 py-0.5 text-[10px]', h.applied ? 'bg-teal/15 text-teal' : 'bg-white/[0.06] text-muted')}>{h.applied ? t('agentGrowth.appliedBadge') : t('agentGrowth.proposedBadge')}</span>
                  <span className="text-[11px] text-muted">{new Date(h.created_at).toLocaleDateString()}</span>
                </div>
                {h.summary && <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-muted">{h.summary}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
