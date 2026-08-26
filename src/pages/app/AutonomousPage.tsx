import { useState } from 'react'
import { Sparkles, Wand2, Users, ListChecks, Bot, Send, Repeat } from 'lucide-react'
import { AutonomousRunner } from '../../components/platform/AutonomousRunner'
import { SingleAgentRunner } from '../../components/platform/SingleAgentRunner'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'
import { DURABLE_TEAM_TEMPLATES, type DurableTeamTemplate } from '../../data/durableTeamTemplates'

export default function AutonomousPage() {
  const { t, lang } = useI18n()
  const [mode, setMode] = useState<'team' | 'single'>('team')
  const [starterGoal, setStarterGoal] = useState(() => {
    try {
      const raw = localStorage.getItem('nemo-selected-template')
      if (!raw) return ''
      localStorage.removeItem('nemo-selected-template')
      const parsed = JSON.parse(raw) as { goal?: string; teamName?: string }
      return [parsed.teamName, parsed.goal].filter(Boolean).join(': ')
    } catch { return '' }
  })
  const [selectedDepartment, setSelectedDepartment] = useState<DurableTeamTemplate | null>(null)
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

  const templateLanguage = lang === 'ru' || lang === 'uz' ? lang : 'en'

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
        {isTeam ? (
          <AutonomousRunner
            defaultGoal={starterGoal}
            goalValue={starterGoal}
            onGoalChange={setStarterGoal}
            presetSpecs={selectedDepartment?.roles}
            contextHint={selectedDepartment ? `Durable team template ${selectedDepartment.id}@${selectedDepartment.version}. Routing: ${selectedDepartment.routingProtocol}. Persist the roster only through the atomic team creation boundary; the user's written task remains the exact goal.` : undefined}
          />
        ) : <SingleAgentRunner />}
      </div>

      {isTeam && (
        <div className="mt-8">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-muted">{lang === 'ru' ? 'Выберите отдел — роли подставятся автоматически' : lang === 'uz' ? 'Boʻlimni tanlang — rollar avtomatik tanlanadi' : 'Choose a department — roles are selected automatically'}</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {DURABLE_TEAM_TEMPLATES.map((p) => (
              <button key={p.id} onClick={() => { setSelectedDepartment(p); setStarterGoal(p.goal[templateLanguage]); window.scrollTo({ top: 0, behavior: 'smooth' }) }} className={cn('rounded-2xl border bg-white/[0.02] p-3 text-left transition hover:border-violet/35 hover:bg-violet/[0.04]', selectedDepartment?.id === p.id ? 'border-violet/60 bg-violet/[0.08]' : 'border-ice/10')}>
                <span className="text-sm font-semibold text-text">{p.title[templateLanguage]}</span>
                <span className="mt-1 block text-[11px] leading-relaxed text-muted">{p.description[templateLanguage]}</span>
                <span className="mt-2 block text-[10px] uppercase tracking-wide text-cyan">{p.roles.length} agents · {p.routingProtocol}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-8">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-muted">{t('autonomousPage.examplesLabel')}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {examples.map((e) => (
            <button key={e} onClick={() => isTeam && setStarterGoal(e)} className="rounded-2xl border border-ice/10 bg-white/[0.02] p-3 text-left text-sm leading-relaxed text-muted transition hover:border-violet/30 hover:text-text">{e}</button>
          ))}
        </div>
      </div>
    </div>
  )
}
