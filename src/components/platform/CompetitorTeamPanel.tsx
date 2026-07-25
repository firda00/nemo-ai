import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Swords, Loader2, Check, ChevronDown, Bot, Users, Sparkles, Save, RotateCcw, MessageSquare, ShieldCheck, Link2, BookOpen, Plus, X } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useAgentStore } from '../../store/useAgentStore'
import { saveDynamicTeam } from '../../lib/ustudyTeam'
import { useI18n } from '../../i18n'
import { Markdown } from '../ui/Markdown'
import { cn } from '../../lib/cn'
import { DocExport } from './DocExport'
import { QualityBar, DeliveryBar } from './AutonomousRunner'

const live = isSupabaseEnabled
const COLORS = ['#22D3EE', '#5B7CF6', '#8B7CF8', '#13C5B4', '#F4A640', '#EC6CB0']
const PLATFORMS = ['Instagram', 'Telegram', 'YouTube', 'TikTok'] as const
// How many competitors one run can analyze, by plan (mirrors _shared/plans.ts competitors).
const PLAN_COMPETITORS: Record<string, number> = { free: 1, starter: 2, pro: 3, business: 5, agency: 10, enterprise: 20, beta: 5 }

interface Review { approved: boolean; score: number; issues: string[]; fix: string }
interface Spec {
  role: string
  name: string
  skills: string[]
  prompt: { role: string; tasks: string; tone: string; rules: string }
  output?: string
  review?: Review | null
  revised?: boolean
  status: 'pending' | 'running' | 'review' | 'fixing' | 'done'
}
type Phase = 'idle' | 'scout' | 'architect' | 'team' | 'synth'

function subSystem(s: Spec): string {
  return [
    `You are "${s.name}", a ${s.role}.`,
    s.prompt.role && `Role: ${s.prompt.role}`,
    s.prompt.tasks && `Tasks: ${s.prompt.tasks}`,
    s.prompt.tone && `Tone: ${s.prompt.tone}`,
    s.prompt.rules && `Rules: ${s.prompt.rules}`,
  ].filter(Boolean).join('\n')
}
function mapRole(role: string): string {
  const r = role.toLowerCase()
  if (/research|scout|intel|развед|аналитик рынка/.test(r)) return 'researcher'
  if (/writ|content|copy|email|market|контент|копирайт|автор/.test(r)) return 'writer'
  if (/review|qa|quality|check|audit|ревиз|рецен|редакт|контрол/.test(r)) return 'reviewer'
  return 'analyst'
}
const isReviewer = (s: { role: string; prompt: { role: string } }): boolean =>
  /review|qa|quality|check|audit|ревиз|рецен|редакт|контрол|провер/i.test(`${s.role} ${s.prompt.role}`)

const STAGES: { id: Phase; labelKey: string }[] = [
  { id: 'scout', labelKey: 'competitorTeamPanel.stageScout' },
  { id: 'architect', labelKey: 'competitorTeamPanel.stageArchitect' },
  { id: 'team', labelKey: 'competitorTeamPanel.stageTeam' },
  { id: 'synth', labelKey: 'competitorTeamPanel.stageSynth' },
]

/**
 * Competitor factory: drop YOUR channel link + a COMPETITOR channel link -> a scout
 * agent builds competitor intel, the Team Architect designs a bespoke AI content team
 * (each specialist equipped with marketing-skill briefs), the specialists execute in
 * sequence while the team's QA reviewer cross-checks every step (visible peer review,
 * with one revision pass on rejection), and the manager synthesizes the deliverable.
 */
export function CompetitorTeamPanel({ model }: { model?: string }) {
  const { t, lang } = useI18n()
  const navigate = useNavigate()
  const addAgent = useAgentStore((s) => s.addAgent)
  const deleteAgent = useAgentStore((s) => s.deleteAgent)
  const accountId = useAgentStore((s) => s.accountId)

  const [platform, setPlatform] = useState<string>('Instagram')
  const [ownUrl, setOwnUrl] = useState('')
  const [comps, setComps] = useState<string[]>([''])
  const [cap, setCap] = useState(3)
  const [focus, setFocus] = useState('')
  const [scoutMsg, setScoutMsg] = useState('')

  // competitor count is plan-gated — read the account plan and set the cap
  useEffect(() => {
    if (!live || !supabase || !accountId || accountId === 'demo') return
    ;(async () => {
      const { data } = await supabase!.from('accounts').select('plan').eq('id', accountId).maybeSingle()
      const c = PLAN_COMPETITORS[String((data as { plan?: string } | null)?.plan ?? 'free')] ?? 1
      setCap(c)
    })()
  }, [accountId])

  const addComp = () => setComps((p) => (p.length >= cap ? p : [...p, '']))
  const setComp = (i: number, v: string) => setComps((p) => p.map((c, idx) => (idx === i ? v : c)))
  const removeComp = (i: number) => setComps((p) => (p.length <= 1 ? p : p.filter((_, idx) => idx !== i)))

  const [running, setRunning] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [intel, setIntel] = useState('')
  const [intelOpen, setIntelOpen] = useState(false)
  const [specs, setSpecs] = useState<Spec[]>([])
  const [mission, setMission] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [openStep, setOpenStep] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (b: Record<string, unknown>): Promise<any> => {
    if (!live || !supabase) return null
    const { data, error: err } = await supabase.functions.invoke('orchestrate', {
      body: { ...b, lang, ...(model ? { model } : {}) },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (err || !(data as any)?.ok) return null
    return data
  }

  const patchSpec = (i: number, patch: Partial<Spec>) =>
    setSpecs((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))

  const run = async () => {
    const list = comps.map((c) => c.trim()).filter(Boolean).slice(0, cap)
    if (!list.length || running) return
    setError(''); setResult(null); setSpecs([]); setIntel(''); setIntelOpen(false); setScoutMsg('')
    setRunning(true)
    try {
      if (!live || !supabase) {
        setError(t('competitorTeamPanel.errNoLive'))
        return
      }
      // 1) SCOUT — intel for EACH competitor from real page signals
      setPhase('scout')
      const intels: string[] = []
      for (let i = 0; i < list.length; i++) {
        setScoutMsg(t('competitorTeamPanel.scoutProgress', { n: i + 1, total: list.length }))
        const scout = await call({ action: 'scout', competitor_url: list[i], own_url: ownUrl.trim(), platform, goal: focus.trim() })
        if (scout?.intel) intels.push(`### ${t('competitorTeamPanel.competitorN', { n: i + 1 })}: ${list[i]}\n${String(scout.intel)}`)
      }
      setScoutMsg('')
      if (!intels.length) {
        setError(t('competitorTeamPanel.errScout'))
        return
      }
      const combinedIntel = intels.join('\n\n---\n\n')
      setIntel(combinedIntel)

      // 2) ARCHITECT — design the team against ALL competitors, with marketing skills
      setPhase('architect')
      const m =
        `Цель: обойти конкурентов по контенту на ${platform} и вырастить наш канал.` +
        (ownUrl.trim() ? `\nНаш канал: ${ownUrl.trim()}` : '') +
        `\nКонкуренты (${list.length}): ${list.join(', ')}` +
        (focus.trim() ? `\nФокус клиента: ${focus.trim()}` : '') +
        `\nКоманда должна выдать: (1) контент-стратегию против ЭТИХ конкурентов — учесть каждого, найти общие слабости и незанятые ниши, (2) контент-план на 2 недели (день, формат, тема, хук), (3) 3 готовых поста/сценария с хуками и CTA.` +
        `\n\nРАЗВЕДДАННЫЕ ПО КОНКУРЕНТАМ (используй как факты):\n${combinedIntel.slice(0, 4000)}`
      setMission(m)
      const staff = await call({ action: 'staff', goal: m, niche: `контент-маркетинг, ${platform}`, purpose: 'контент-команда против конкурентов', use_skills: true })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const created: Spec[] = (staff?.subagents ?? []).map((s: any) => ({
        role: String(s.role ?? ''), name: String(s.name ?? s.role ?? ''),
        skills: Array.isArray(s.skills) ? s.skills.map(String) : [],
        prompt: { role: s.prompt?.role ?? '', tasks: s.prompt?.tasks ?? '', tone: s.prompt?.tone ?? '', rules: s.prompt?.rules ?? '' },
        status: 'pending' as const,
      }))
      if (!created.length) {
        setError(t('competitorTeamPanel.errStaff'))
        return
      }
      setSpecs(created)

      // 3) TEAM — each specialist works; the QA reviewer cross-checks every step
      setPhase('team')
      const revIdx = (() => { const i = created.findIndex(isReviewer); return i === -1 ? created.length - 1 : i })()
      const reviewer = created[revIdx]
      const done: Spec[] = []
      let ctx = ''
      for (let i = 0; i < created.length; i++) {
        const s = created[i]
        patchSpec(i, { status: 'running' })
        const r = await call({
          action: 'step', goal: m, role: mapRole(s.role),
          task: s.prompt.tasks || s.role, system: subSystem(s), skills: s.skills,
          context: ctx.slice(-4000),
        })
        let output: string = r?.output ?? ''

        // peer cross-review by the team's QA (every step except the reviewer's own)
        let review: Review | null = null
        let revised = false
        if (i !== revIdx && output) {
          patchSpec(i, { status: 'review', output })
          const v = await call({
            action: 'review', goal: m, work: output, author_role: s.role,
            reviewer_system: subSystem(reviewer),
            criteria: 'соответствие цели и своему шагу; конкретика и факты из разведки; применимость без доработки',
          })
          if (v) {
            review = { approved: Boolean(v.approved), score: Number(v.score) || 0, issues: Array.isArray(v.issues) ? v.issues : [], fix: String(v.fix ?? '') }
            if (!review.approved) {
              patchSpec(i, { status: 'fixing', review })
              const fix = await call({
                action: 'step', goal: m, role: mapRole(s.role),
                task: 'Перепиши свою работу, устранив ВСЕ замечания рецензента. Верни улучшенную версию целиком, в том же формате.',
                system: subSystem(s), skills: s.skills,
                context: `ТВОЯ ТЕКУЩАЯ РАБОТА:\n${output.slice(0, 2600)}\n\nЗАМЕЧАНИЯ РЕЦЕНЗЕНТА (${reviewer.name}):\n${review.fix}\n${review.issues.join('\n')}`,
              })
              if (fix?.output) { output = fix.output; revised = true }
            }
          }
        }

        const filled: Spec = { ...s, output, review, revised, status: 'done' }
        done.push(filled)
        ctx += `\n[${filled.name}] ${output}`
        patchSpec(i, filled)
      }

      // 4) SYNTH — the manager assembles the final deliverable
      setPhase('synth')
      const synth = await call({ action: 'synth', goal: m, steps: done.map((d) => ({ role: d.role, task: d.prompt.tasks, output: d.output })), sources: [] })
      if (!synth) {
        setError(t('competitorTeamPanel.errSynth'))
        return
      }
      setResult(synth.result)
    } finally {
      setRunning(false)
      setPhase('idle')
    }
  }

  const saveTeam = async () => {
    if (saving || !specs.length) return
    setSaving(true)
    try {
      const firstComp = comps.map((c) => c.trim()).filter(Boolean)[0] ?? ''
      const res = await saveDynamicTeam(addAgent, {
        name: `Контент-команда vs ${firstComp.replace(/^https?:\/\/(www\.)?/, '').slice(0, 32)}`,
        goal: mission.slice(0, 500),
        specialists: specs.map((s) => ({ role: s.role, name: s.name, prompt: s.prompt })),
      }, deleteAgent)
      if (!res.error && res.agentId && res.departmentId) navigate(`/app/teams/${res.agentId}`)
      else setError(res.error ?? 'Could not save the complete team.')
    } finally {
      setSaving(false)
    }
  }

  const reset = () => { setResult(null); setSpecs([]); setIntel(''); setMission('') }

  const stageState = (id: Phase): 'todo' | 'on' | 'done' => {
    const order: Phase[] = ['scout', 'architect', 'team', 'synth']
    if (phase === 'idle') return result || intel ? 'done' : 'todo'
    const cur = order.indexOf(phase)
    const idx = order.indexOf(id)
    return idx < cur ? 'done' : idx === cur ? 'on' : 'todo'
  }

  return (
    <div>
      <div className="card rounded-2xl border border-violet/20 bg-violet/[0.04] p-4">
        <p className="flex items-start gap-2 text-[13px] text-muted">
          <Swords size={15} className="mt-0.5 shrink-0 text-violet" />
          <span>{t('competitorTeamPanel.intro1')}<b className="text-text">{t('competitorTeamPanel.introBold')}</b>.</span>
        </p>
      </div>

      {/* input form */}
      <div className="card mt-4 rounded-2xl p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">{t('competitorTeamPanel.labelPlatform')}</span>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)} disabled={running} className="glass w-full rounded-xl px-3 py-2.5 text-sm text-text outline-none focus:border-violet/50">
              {PLATFORMS.map((p) => <option key={p} value={p} className="bg-panel">{p}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">{t('competitorTeamPanel.labelOwnChannel')}</span>
            <div className="relative">
              <Link2 size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fog" />
              <input value={ownUrl} onChange={(e) => setOwnUrl(e.target.value)} disabled={running} placeholder={t('competitorTeamPanel.placeholderOwnUrl')} className="glass w-full rounded-xl py-2.5 pl-9 pr-3 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
            </div>
          </label>
        </div>
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="block text-[11px] font-medium uppercase tracking-wide text-muted">{t('competitorTeamPanel.labelCompChannels')}</span>
            <span className="text-[10px] text-fog">{t('competitorTeamPanel.capNote', { cap })}</span>
          </div>
          <div className="space-y-2">
            {comps.map((c, i) => (
              <div key={i} className="relative flex items-center gap-2">
                <Swords size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fog" />
                <input value={c} onChange={(e) => setComp(i, e.target.value)} disabled={running} placeholder={t('competitorTeamPanel.placeholderCompUrl')} className="glass w-full rounded-xl py-2.5 pl-9 pr-3 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
                {comps.length > 1 && <button onClick={() => removeComp(i)} disabled={running} className="shrink-0 rounded-lg p-1.5 text-fog hover:text-danger" aria-label={t('competitorTeamPanel.removeCompetitor')}><X size={15} /></button>}
              </div>
            ))}
          </div>
          {comps.length < cap && (
            <button onClick={addComp} disabled={running} className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-ice/12 px-2.5 py-1.5 text-[12px] font-medium text-muted transition hover:text-text disabled:opacity-40">
              <Plus size={13} /> {t('competitorTeamPanel.addCompetitor')}
            </button>
          )}
        </div>
        <label className="mt-3 block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">{t('competitorTeamPanel.labelFocus')}</span>
          <textarea value={focus} onChange={(e) => setFocus(e.target.value)} disabled={running} rows={2} placeholder={t('competitorTeamPanel.placeholderFocus')} className="glass w-full resize-none rounded-xl px-3 py-2.5 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
        </label>
        <button onClick={run} disabled={running || comps.every((c) => c.trim().length < 8)} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white transition disabled:opacity-40">
          {running ? <Loader2 size={16} className="animate-spin" /> : <Swords size={16} />} {t('competitorTeamPanel.btnRun')}
        </button>
        {scoutMsg && <p className="mt-3 inline-flex items-center gap-2 text-xs text-muted"><Loader2 size={13} className="animate-spin text-violet" /> {scoutMsg}</p>}
        {error && <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
      </div>

      {/* pipeline stages */}
      {(running || intel || result) && (
        <div className="card mt-4 rounded-2xl p-4">
          <div className="grid gap-2 sm:grid-cols-4">
            {STAGES.map((st) => {
              const state = stageState(st.id)
              return (
                <div key={st.id} className={cn('flex items-center gap-2 rounded-xl border px-3 py-2', state === 'on' ? 'border-violet/50 bg-violet/10' : state === 'done' ? 'border-teal/30 bg-teal/[0.06]' : 'border-ice/10')}>
                  {state === 'on' ? <Loader2 size={13} className="shrink-0 animate-spin text-violet" /> : state === 'done' ? <Check size={13} className="shrink-0 text-teal" /> : <span className="h-[13px] w-[13px] shrink-0 rounded-full border border-ice/20" />}
                  <span className={cn('text-[11.5px] leading-tight', state === 'todo' ? 'text-fog' : 'text-text')}>{t(st.labelKey)}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* competitor intel */}
      {intel && (
        <div className="card mt-4 rounded-2xl">
          <button onClick={() => setIntelOpen((v) => !v)} className="flex w-full items-center gap-2.5 px-5 py-3.5 text-left">
            <ShieldCheck size={16} className="shrink-0 text-cyan" />
            <span className="flex-1 text-sm font-medium text-text">{t('competitorTeamPanel.intelReady')}</span>
            <ChevronDown size={15} className={cn('shrink-0 text-muted transition-transform', intelOpen && 'rotate-180')} />
          </button>
          {intelOpen && <div className="border-t border-ice/[0.07] px-5 py-4"><Markdown content={intel} /></div>}
        </div>
      )}

      {/* the team, with visible peer review */}
      {specs.length > 0 && (
        <div className="card mt-4 rounded-2xl p-5">
          <p className="mb-3 flex items-center gap-2 text-sm font-medium text-text">
            <Users size={15} className="text-violet" /> {t('competitorTeamPanel.teamTitle', { count: specs.length })}
            {running && phase === 'synth' && <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted"><Loader2 size={12} className="animate-spin" /> {t('competitorTeamPanel.assembling')}</span>}
          </p>
          <div className="space-y-2">
            {specs.map((s, i) => {
              const color = COLORS[i % COLORS.length]
              return (
                <div key={i} className="rounded-xl border border-ice/[0.07]">
                  <button onClick={() => s.status === 'done' && setOpenStep(openStep === i ? null : i)} className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg" style={{ background: `${color}22`, color }}><Bot size={13} /></span>
                    <span className="shrink-0 text-sm font-medium text-text">{s.name}</span>
                    <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: `${color}1a`, color }}>{s.role}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted">{s.prompt.tasks}</span>
                    {s.status === 'running' ? (
                      <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-violet"><Loader2 size={13} className="animate-spin" /> {t('competitorTeamPanel.statusWorking')}</span>
                    ) : s.status === 'review' ? (
                      <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-cyan"><Loader2 size={13} className="animate-spin" /> {t('competitorTeamPanel.statusReviewing')}</span>
                    ) : s.status === 'fixing' ? (
                      <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-amber"><Loader2 size={13} className="animate-spin" /> {t('competitorTeamPanel.statusFixing')}</span>
                    ) : s.status === 'done' ? (
                      <><Check size={14} className="shrink-0 text-teal" /><ChevronDown size={15} className={cn('shrink-0 text-muted transition-transform', openStep === i && 'rotate-180')} /></>
                    ) : (
                      <span className="shrink-0 text-[11px] text-muted">…</span>
                    )}
                  </button>

                  {/* skill badges from the marketing skills library */}
                  {s.skills.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 px-3.5 pb-2.5">
                      {s.skills.map((id) => (
                        <span key={id} className="inline-flex items-center gap-1 rounded-full border border-ice/10 bg-black/20 px-2 py-0.5 text-[10px] text-muted">
                          <BookOpen size={9} className="text-violet" /> {id}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* peer-review dialogue: reviewer verdict + author's revision */}
                  {s.review && (
                    <div className="mx-3.5 mb-2.5 rounded-lg border border-amber/20 bg-amber/[0.05] px-3 py-2">
                      <p className="flex items-center gap-1.5 text-[11.5px] font-medium text-amber">
                        <MessageSquare size={12} /> {t('competitorTeamPanel.reviewVerdict', { score: s.review.score })} · {s.review.approved ? t('competitorTeamPanel.reviewApproved') : t('competitorTeamPanel.reviewHadIssues')}
                      </p>
                      {s.review.issues.length > 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {s.review.issues.slice(0, 4).map((it, k) => <li key={k} className="text-[11px] text-muted">• {it}</li>)}
                        </ul>
                      )}
                      {s.revised && <p className="mt-1 text-[11px] font-medium text-teal">{t('competitorTeamPanel.revisedNote')}</p>}
                    </div>
                  )}

                  {openStep === i && s.status === 'done' && (
                    <div className="border-t border-ice/[0.07] px-3.5 py-3"><Markdown content={s.output || '—'} /></div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* final deliverable + quality/delivery/save */}
      {result && !running && (
        <div className="mt-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-base font-medium text-text"><Sparkles size={16} className="text-violet" /> {t('competitorTeamPanel.resultTitle')}</h2>
            <button onClick={reset} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ice/12 px-2.5 py-1.5 text-xs font-medium text-muted hover:text-text">
              <RotateCcw size={13} /> {t('competitorTeamPanel.btnNewRun')}
            </button>
          </div>
          <div className="card rounded-2xl p-6"><Markdown content={result} /></div>
          <DocExport content={result} title={`vs ${comps.map((c) => c.trim()).filter(Boolean)[0] ?? 'competitors'}`} />
          <QualityBar goal={mission} content={result} model={model} lang={lang} onRevised={setResult} />
          <DeliveryBar content={result} />
          <button onClick={saveTeam} disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition disabled:opacity-40">
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {t('competitorTeamPanel.btnSaveTeam')}
          </button>
        </div>
      )}
    </div>
  )
}
