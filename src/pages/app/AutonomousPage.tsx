import { useState } from 'react'
import { Sparkles, Wand2, Users, ListChecks, Bot, Send, Repeat } from 'lucide-react'
import { AutonomousRunner } from '../../components/platform/AutonomousRunner'
import { SingleAgentRunner } from '../../components/platform/SingleAgentRunner'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

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
  const [selectedDepartment, setSelectedDepartment] = useState<{ id: string; name: string; roles: string; goal: string } | null>(null)
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

  const departmentPresets = [
    { id: 'sales', name: lang === 'ru' ? 'Продажи' : lang === 'uz' ? 'Sotuv' : 'Sales', roles: 'Qualifier · Follow-up · CRM · Report', goal: lang === 'ru' ? 'Создай отдел продаж: квалифицируй лидов, отвечай на возражения, делай follow-up, обновляй CRM и готовь отчёт руководителю.' : lang === 'uz' ? 'Leadlarni saralash, eʼtirozlarga javob berish, follow-up, CRM va rahbar hisoboti uchun sotuv jamoasini yarat.' : 'Create a sales team for lead qualification, objections, follow-up, CRM updates and manager reporting.' },
    { id: 'support', name: lang === 'ru' ? 'Поддержка' : lang === 'uz' ? 'Yordam' : 'Support', roles: 'Triage · Knowledge · SLA · Escalation', goal: lang === 'ru' ? 'Создай отдел поддержки: классифицируй обращения, отвечай по базе знаний, контролируй SLA и передавай сложные случаи оператору.' : lang === 'uz' ? 'Murojaatlarni saralash, bilim bazasidan javob berish, SLA nazorati va operatorga eskalatsiya uchun yordam jamoasini yarat.' : 'Create a support team for triage, knowledge answers, SLA control and human escalation.' },
    { id: 'content', name: lang === 'ru' ? 'Контент' : lang === 'uz' ? 'Kontent' : 'Content', roles: 'Strategy · Research · Copy · Review', goal: lang === 'ru' ? 'Создай контент-отдел: стратегия, исследование, контент-план, тексты, сценарии и проверка качества перед публикацией.' : lang === 'uz' ? 'Strategiya, tadqiqot, kontent-reja, matn, ssenariy va sifat tekshiruvi uchun kontent jamoasini yarat.' : 'Create a content team for strategy, research, planning, copy, scripts and quality review.' },
    { id: 'operations', name: lang === 'ru' ? 'Операции' : lang === 'uz' ? 'Operatsiyalar' : 'Operations', roles: 'Meetings · Tasks · Reminders · QA', goal: lang === 'ru' ? 'Создай операционный отдел: разбирай встречи, назначай задачи и дедлайны, напоминай исполнителям и проверяй результат.' : lang === 'uz' ? 'Yigʻilishlarni tahlil qilish, vazifa va deadline berish, eslatish va natijani tekshirish uchun operatsion jamoa yarat.' : 'Create an operations team for meeting analysis, task assignment, deadlines, reminders and QA.' },
    { id: 'hr', name: 'HR', roles: 'Screening · Interviews · Onboarding', goal: lang === 'ru' ? 'Создай HR-отдел: первичный скрининг кандидатов, расписание интервью, onboarding и ответы на типовые HR-вопросы.' : lang === 'uz' ? 'Nomzodlarni saralash, intervyu rejalash, onboarding va HR savollari uchun HR jamoasini yarat.' : 'Create an HR team for candidate screening, interview scheduling, onboarding and HR FAQs.' },
    { id: 'analytics', name: lang === 'ru' ? 'Аналитика' : lang === 'uz' ? 'Analitika' : 'Analytics', roles: 'Data · BI · Anomalies · Reports', goal: lang === 'ru' ? 'Создай аналитический отдел: собирай показатели, находи отклонения и готовь понятные управленческие отчёты.' : lang === 'uz' ? 'Koʻrsatkichlarni yigʻish, ogʻishlarni topish va boshqaruv hisobotlari uchun analitika jamoasini yarat.' : 'Create an analytics team to collect metrics, detect anomalies and prepare management reports.' },
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
        {isTeam ? (
          <AutonomousRunner
            defaultGoal={starterGoal}
            goalValue={starterGoal}
            onGoalChange={setStarterGoal}
            contextHint={selectedDepartment ? `Selected department: ${selectedDepartment.name}. Preferred roles: ${selectedDepartment.roles}. Use this only to staff the team; the user's written task below remains the exact goal and must not be replaced.` : undefined}
          />
        ) : <SingleAgentRunner />}
      </div>

      {isTeam && (
        <div className="mt-8">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-muted">{lang === 'ru' ? 'Выберите отдел — роли подставятся автоматически' : lang === 'uz' ? 'Boʻlimni tanlang — rollar avtomatik tanlanadi' : 'Choose a department — roles are selected automatically'}</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {departmentPresets.map((p) => (
              <button key={p.id} onClick={() => { setSelectedDepartment(p); setStarterGoal(p.goal); window.scrollTo({ top: 0, behavior: 'smooth' }) }} className={cn('rounded-2xl border bg-white/[0.02] p-3 text-left transition hover:border-violet/35 hover:bg-violet/[0.04]', selectedDepartment?.id === p.id ? 'border-violet/60 bg-violet/[0.08]' : 'border-ice/10')}>
                <span className="text-sm font-semibold text-text">{p.name}</span>
                <span className="mt-1 block text-[11px] leading-relaxed text-muted">{p.roles}</span>
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
