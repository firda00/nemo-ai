import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, Circle, ChevronDown, Rocket, Bot, Send, Mail, PlayCircle, X, HelpCircle, LayoutTemplate } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useAgentStore } from '../../store/useAgentStore'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'

interface Step {
  key: string
  title: string
  desc: string
  done: boolean
  to: string
  cta: string
  icon: LucideIcon
  help?: string
}

/**
 * Self-service onboarding checklist. A new user (after buying a plan) sees exactly
 * what to do to get value — create a team, connect channels, run a task — each with
 * inline help so they never have to ask support. Hides itself once everything is done.
 */
export function QuickStart() {
  const { t } = useI18n()
  const agents = useAgentStore((s) => s.agents)
  const hydrated = useAgentStore((s) => s.hydrated)
  const [channels, setChannels] = useState(0)
  const [google, setGoogle] = useState(false)
  const [runs, setRuns] = useState(0)
  const [openHelp, setOpenHelp] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem('nemo-quickstart-hidden') === '1' } catch { return false }
  })

  useEffect(() => {
    if (!isSupabaseEnabled || !supabase) return
    ;(async () => {
      try {
        const { count: ch } = await supabase!.from('channels').select('id', { count: 'exact', head: true })
        setChannels(ch ?? 0)
        const { count: rn } = await supabase!.from('research_runs').select('*', { count: 'exact', head: true })
        setRuns(rn ?? 0)
        const { data } = await supabase!.functions.invoke('google-oauth', { body: { action: 'status' } })
        if ((data as { connected?: boolean } | null)?.connected) setGoogle(true)
      } catch { /* ignore */ }
    })()
  }, [])

  const steps: Step[] = [
    { key: 'template', title: t('quickStart.templateTitle'), desc: t('quickStart.templateDesc'), done: agents.length > 0, to: '/app/templates', cta: t('quickStart.templateCta'), icon: LayoutTemplate },
    { key: 'team', title: t('quickStart.teamTitle'), desc: t('quickStart.teamDesc'), done: agents.length > 0, to: '/app?create=team', cta: t('quickStart.teamCta'), icon: Bot },
    { key: 'tg', title: t('quickStart.tgTitle'), desc: t('quickStart.tgDesc'), done: channels > 0, to: '/app/teams', cta: t('quickStart.tgCta'), icon: Send, help: t('quickStart.tgHelp') },
    { key: 'google', title: t('quickStart.googleTitle'), desc: t('quickStart.googleDesc'), done: google, to: '/app/settings?tab=integrations&section=services', cta: t('quickStart.googleCta'), icon: Mail, help: t('quickStart.googleHelp') },
    { key: 'run', title: t('quickStart.runTitle'), desc: t('quickStart.runDesc'), done: runs > 0, to: '/app/autonomous', cta: t('quickStart.runCta'), icon: PlayCircle },
  ]
  const doneCount = steps.filter((s) => s.done).length
  const allDone = doneCount === steps.length

  const hide = () => { try { localStorage.setItem('nemo-quickstart-hidden', '1') } catch { /* ignore */ } setDismissed(true) }

  if (dismissed) return null
  if (allDone && hydrated) return null

  return (
    <section className="card mt-6 overflow-hidden rounded-3xl p-4 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet/15 text-violet"><Rocket size={20} /></span>
          <div>
            <h2 className="text-xl font-bold text-text">{t('quickStart.title')}</h2>
            <p className="text-sm text-muted">{t('quickStart.subtitle', { done: doneCount, total: steps.length })}</p>
          </div>
        </div>
        <button onClick={hide} className="shrink-0 rounded-lg p-1.5 text-muted hover:bg-white/5 hover:text-text" title={t('quickStart.hide')} aria-label={t('quickStart.hide')}><X size={16} /></button>
      </div>

      <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
      </div>

      <div className="mt-5 space-y-2.5">
        {steps.map((s) => (
          <div key={s.key} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
            <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
              <div className="flex shrink-0 items-center gap-2">
                {s.done ? <CheckCircle2 size={20} className="shrink-0 text-teal" /> : <Circle size={20} className="shrink-0 text-muted/50" />}
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet/10 text-violet"><s.icon size={15} /></span>
              </div>
              <div className="min-w-0 break-words [overflow-wrap:anywhere]">
                <p className={cn('text-sm font-semibold', s.done ? 'text-muted line-through' : 'text-text')}>{s.title}</p>
                <p className="mt-0.5 text-xs leading-5 text-muted">{s.desc}</p>
              </div>
              <div className="col-start-2 flex min-w-0 flex-col gap-2 sm:col-start-auto sm:flex-row sm:items-center">
                {s.help && (
                  <button onClick={() => setOpenHelp(openHelp === s.key ? null : s.key)} className="inline-flex w-full items-center justify-center gap-1 rounded-lg border border-ice/12 px-2 py-2 text-[11px] text-muted hover:text-text sm:w-auto sm:shrink-0 sm:py-1.5">
                    <HelpCircle size={13} /> {t('quickStart.how')} <ChevronDown size={13} className={cn('transition-transform', openHelp === s.key && 'rotate-180')} />
                  </button>
                )}
                {!s.done && (
                  <Link to={s.to} className="inline-flex w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-brand px-3 py-2 text-xs font-medium text-white sm:w-auto sm:shrink-0 sm:py-1.5">{s.cta}</Link>
                )}
              </div>
            </div>
            {s.help && openHelp === s.key && (
              <p className="mt-3 rounded-xl border border-ice/[0.07] bg-black/20 p-3 text-[12px] leading-relaxed text-muted">{s.help}</p>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
