import { useState } from 'react'
import { Sparkles, Wand2, Users, ListChecks, Bot, Send, Repeat } from 'lucide-react'
import { AutonomousRunner } from '../../components/platform/AutonomousRunner'
import { SingleAgentRunner } from '../../components/platform/SingleAgentRunner'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

export default function AutonomousPage() {
  const { t } = useI18n()
  const [mode, setMode] = useState<'team' | 'single'>('team')
  const isTeam = mode === 'team'

  const examples = isTeam
    ? [t('autonomousPage.teamEx1'), t('autonomousPage.teamEx2'), t('autonomousPage.teamEx3')]
    : [t('autonomousPage.singleEx1'), t('autonomousPage.singleEx2'), t('autonomousPage.singleEx3')]

  const chips = isTeam
    ? [
        { icon: Sparkles, cls: 'text-violet', label: t('autonomousPage.chipTeam1') },
        { icon: Users, cls: 'text-cyan', label: t('autonomousPage.chipTeam2') },
        { icon: ListChecks, cls: 'text-teal', label: t('autonomousPage.chipTeam3') },
      ]
    : [
        { icon: Bot, cls: 'text-violet', label: t('autonomousPage.chipSingle1') },
        { icon: Send, cls: 'text-cyan', label: t('autonomousPage.chipSingle2') },
        { icon: Repeat, cls: 'text-teal', label: t('autonomousPage.chipSingle3') },
      ]

  return (
    <div className="container-page max-w-4xl py-8">
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand text-white shadow-glow">
          {isTeam ? <Wand2 size={20} /> : <Bot size={20} />}
        </span>
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-text">{isTeam ? t('autonomousPage.teamTitle') : t('autonomousPage.singleTitle')}</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">{isTeam ? t('autonomousPage.teamSubtitle') : t('autonomousPage.singleSubtitle')}</p>
        </div>
      </div>

      {/* mode toggle: one agent on request, or a whole team */}
      <div className="mt-6 inline-flex rounded-2xl border border-ice/10 bg-white/[0.03] p-1">
        <button
          onClick={() => setMode('single')}
          className={cn('inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium transition', !isTeam ? 'bg-brand text-white shadow-glow' : 'text-muted hover:text-text')}
        >
          <Bot size={15} /> {t('autonomousPage.modeSingle')}
        </button>
        <button
          onClick={() => setMode('team')}
          className={cn('inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium transition', isTeam ? 'bg-brand text-white shadow-glow' : 'text-muted hover:text-text')}
        >
          <Users size={15} /> {t('autonomousPage.modeTeam')}
        </button>
      </div>

      <div className="mt-5 flex flex-wrap gap-3 text-xs text-muted">
        {chips.map((c) => (
          <span key={c.label} className="inline-flex items-center gap-1.5 rounded-full border border-ice/10 bg-white/[0.03] px-3 py-1.5">
            <c.icon size={13} className={c.cls} /> {c.label}
          </span>
        ))}
      </div>

      <div className="mt-6">
        {isTeam ? <AutonomousRunner /> : <SingleAgentRunner />}
      </div>

      <div className="mt-8">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-muted">{t('autonomousPage.examplesLabel')}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {examples.map((e) => (
            <div key={e} className="rounded-2xl border border-ice/10 bg-white/[0.02] p-3 text-sm leading-relaxed text-muted">{e}</div>
          ))}
        </div>
      </div>
    </div>
  )
}
