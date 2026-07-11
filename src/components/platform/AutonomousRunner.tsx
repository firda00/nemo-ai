import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowUp, Loader2, Users, Check, ChevronDown, RotateCcw, Bot, Save, Sparkles, Image as ImageIcon, Send, Download, X, MessageSquare } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useAgentStore } from '../../store/useAgentStore'
import { saveDynamicTeam } from '../../lib/ustudyTeam'
import { IMAGE_MODEL_CATALOG, DEFAULT_IMAGE_MODEL } from '../../lib/models'
import { useI18n } from '../../i18n'
import { Markdown } from '../ui/Markdown'
import { DocExport } from './DocExport'
import { cn } from '../../lib/cn'

const live = isSupabaseEnabled
const COLORS = ['#22D3EE', '#5B7CF6', '#8B7CF8', '#13C5B4', '#F4A640', '#EC6CB0']

interface Review { approved: boolean; score: number; issues: string[]; fix: string }
interface Spec {
  role: string
  name: string
  prompt: { role: string; tasks: string; tone: string; rules: string }
  output?: string
  review?: Review | null
  reviewedBy?: string
  revised?: boolean
  revisions?: number
  escalated?: boolean
  status: 'pending' | 'running' | 'review' | 'fixing' | 'done'
}

function subSystem(s: Spec): string {
  return [
    `You are "${s.name}", a ${s.role}.`,
    'Universal execution contract: your role is a lens, not a limit. Complete the user\'s requested outcome even when it crosses domains; do not refuse just because the task is outside your specialty. If a required tool or permission is missing, say exactly what is missing and still return the most useful partial result.',
    s.prompt.role && `Role: ${s.prompt.role}`,
    s.prompt.tasks && `Tasks: ${s.prompt.tasks}`,
    s.prompt.tone && `Tone: ${s.prompt.tone}`,
    s.prompt.rules && `Rules: ${s.prompt.rules}`,
  ].filter(Boolean).join('\n')
}
// map a free-text specialist role to a known orchestrate role (for model/temperature)
function mapRole(role: string): string {
  const r = role.toLowerCase()
  if (/research|find|scout|data|analy.*market/.test(r)) return 'researcher'
  if (/writ|content|copy|email|draft|market/.test(r)) return 'writer'
  if (/review|qa|quality|check|audit/.test(r)) return 'reviewer'
  return 'analyst'
}

/**
 * Autonomous multi-agent run: give a GOAL -> the manager designs the specialist
 * sub-agents it needs ON THE FLY (orchestrate 'staff'), each specialist executes
 * its part ('step'), then the manager synthesizes the result ('synth'). The created
 * team can be saved as real reusable rows.
 */
export function AutonomousRunner({
  defaultGoal = '',
  presetSpecs,
  contextHint,
  placeholder,
  model,
  postActions,
}: {
  defaultGoal?: string
  // when provided, use THIS saved team instead of designing a fresh one (skip 'staff')
  presetSpecs?: { role: string; name: string; prompt: { role?: string; tasks?: string; tone?: string; rules?: string } }[]
  contextHint?: string
  placeholder?: string
  model?: string
  // show the "AI makes the visual" + "send to Telegram" delivery bar under the result
  postActions?: boolean
}) {
  const { t, lang } = useI18n()
  const navigate = useNavigate()
  const addAgent = useAgentStore((s) => s.addAgent)
  const deleteAgent = useAgentStore((s) => s.deleteAgent)
  const [goal, setGoal] = useState(defaultGoal)
  const [running, setRunning] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'architect' | 'team' | 'review' | 'synth'>('idle')
  const [specs, setSpecs] = useState<Spec[]>([])
  const [result, setResult] = useState<string | null>(null)
  const [escalatedCount, setEscalatedCount] = useState(0)
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

  const run = async () => {
    const task = goal.trim()
    if (task.length < 4 || running) return
    // the manager reasons on the task; a saved team also gets its team context
    const g = contextHint ? `${contextHint}\n\nЗадача: ${task}` : task
    setError('')
    setResult(null)
    setSpecs([])
    setRunning(true)
    try {
      if (!live || !supabase) {
        setError('Sign in to the live backend to run an autonomous team.')
        return
      }
      // 1) get the team: use the SAVED team when provided, else design a fresh one
      let created: Spec[]
      if (presetSpecs?.length) {
        created = presetSpecs.map((s) => ({ role: s.role, name: s.name, prompt: { role: s.prompt.role ?? '', tasks: s.prompt.tasks ?? '', tone: s.prompt.tone ?? '', rules: s.prompt.rules ?? '' }, status: 'pending' as const }))
        setSpecs(created)
      } else {
        setPhase('architect')
        const staff = await call({ action: 'staff', goal: g })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        created = (staff?.subagents ?? []).map((s: any) => ({ ...s, status: 'pending' as const }))
        if (!created.length) {
          setError('Could not build a team — rephrase the goal and try again.')
          return
        }
        setSpecs(created)
      }

      // 2) each SPECIALIST executes its part (live)
      setPhase('team')
      const done: Spec[] = []
      let ctx = ''
      for (let i = 0; i < created.length; i++) {
        setSpecs((prev) => prev.map((s, idx) => (idx === i ? { ...s, status: 'running' } : s)))
        const r = await call({
          action: 'step',
          goal: g,
          role: mapRole(created[i].role),
          task: created[i].prompt.tasks || created[i].role,
          system: subSystem(created[i]),
          context: ctx.slice(-4000),
        })
        const output = r?.output ?? ''
        const filled: Spec = { ...created[i], output, status: 'done' }
        done.push(filled)
        ctx += `\n[${filled.name}] ${output}`
        setSpecs((prev) => prev.map((s, idx) => (idx === i ? filled : s)))
      }

      // 3) PEER REVIEW — each specialist's work is checked by a TEAMMATE (round-robin), and
      // revised on issues. So the copywriter checks the scriptwriter and the scriptwriter
      // checks the copywriter — agents verify each other, not just a single QA.
      if (done.length >= 2) {
        setPhase('review')
        for (let i = 0; i < done.length; i++) {
          const reviewer = done[(i + 1) % done.length]
          setSpecs((prev) => prev.map((s, idx) => (idx === i ? { ...s, status: 'review' } : s)))
          // CONVERGENCE LOOP: review -> if issues, revise -> RE-REVIEW the revision, up to N rounds.
          // Converges when the reviewer approves; if still not approved after the last round, the
          // work is flagged escalated (handed to a human) instead of silently shipping the reject.
          const MAX_ROUNDS = 3
          let review: Review | null = null
          let revised = false
          let escalated = false
          let rounds = 0
          for (let round = 0; round < MAX_ROUNDS; round++) {
            const v = await call({
              action: 'review', goal: g, work: done[i].output ?? '', author_role: done[i].role,
              reviewer_system: subSystem(reviewer),
              criteria: 'соответствие задаче; конкретика и факты; отсутствие воды и клише; готовность без доработки',
            })
            if (!v) break
            review = { approved: Boolean(v.approved), score: Number(v.score) || 0, issues: Array.isArray(v.issues) ? v.issues : [], fix: String(v.fix ?? '') }
            if (review.approved) break
            if (round === MAX_ROUNDS - 1) { escalated = true; break } // out of rounds, still not converged
            setSpecs((prev) => prev.map((s, idx) => (idx === i ? { ...s, status: 'fixing', review, reviewedBy: reviewer.name } : s)))
            const fix = await call({
              action: 'step', goal: g, role: mapRole(done[i].role),
              task: 'Перепиши свою работу, устранив ВСЕ замечания коллеги. Верни улучшенную версию целиком, в том же формате.',
              system: subSystem(done[i]),
              context: `ТВОЯ РАБОТА:\n${(done[i].output ?? '').slice(0, 2600)}\n\nЗАМЕЧАНИЯ КОЛЛЕГИ (${reviewer.name}):\n${review.fix}\n${review.issues.join('\n')}`,
            })
            if (!fix?.output) break
            done[i].output = fix.output; revised = true; rounds = round + 1
          }
          done[i] = { ...done[i], review, reviewedBy: reviewer.name, revised, revisions: rounds, escalated, status: 'done' }
          setSpecs((prev) => prev.map((s, idx) => (idx === i ? done[i] : s)))
        }
      }

      // real human-fallback: a piece the reviewer never approved (escalated) is NOT presented as
      // clean — it's counted, flagged to the manager, and surfaced as a warning on the deliverable.
      const escN = done.filter((d) => d.escalated).length
      setEscalatedCount(escN)

      // 4) MANAGER synthesizes the final deliverable (from the peer-reviewed outputs)
      setPhase('synth')
      const synth = await call({ action: 'synth', goal: g, steps: done.map((d) => ({ role: d.role, task: d.prompt.tasks, output: d.output, needsHumanReview: Boolean(d.escalated) })), sources: [] })
      if (!synth) {
        setError('Final synthesis failed — check token balance.')
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
      const res = await saveDynamicTeam(addAgent, {
        name: `Team: ${goal.trim().slice(0, 40)}`,
        goal: goal.trim(),
        specialists: specs.map((s) => ({ role: s.role, name: s.name, prompt: s.prompt })),
      }, deleteAgent)
      if (!res.error && res.agentId && res.departmentId) navigate(`/app/teams/${res.agentId}`)
      else setError(res.error ?? 'Could not save the complete team.')
    } finally {
      setSaving(false)
    }
  }

  const reset = () => {
    setResult(null)
    setSpecs([])
    setGoal('')
  }

  return (
    <div>
      <div className="glass flex items-end gap-2 rounded-2xl p-2 focus-within:border-violet/50 focus-within:shadow-glow">
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run() }}
          rows={2}
          disabled={running}
          placeholder={placeholder ?? t('autonomousRunner.placeholderDefault')}
          className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-text outline-none placeholder:text-muted/70"
        />
        <button onClick={run} disabled={running || goal.trim().length < 4} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-white transition disabled:opacity-40">
          {running ? <Loader2 size={18} className="animate-spin" /> : <ArrowUp size={18} />}
        </button>
      </div>
      {error && <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-center text-xs text-danger">{error}</p>}

      {running && phase === 'architect' && (
        <div className="card mt-5 flex items-center gap-3 rounded-2xl p-5">
          <Loader2 size={18} className="animate-spin text-violet" />
          <p className="text-sm font-medium text-text">Manager is designing the team for this goal…</p>
        </div>
      )}

      {specs.length > 0 && (
        <div className="card mt-5 rounded-2xl p-5">
          <p className="mb-3 flex items-center gap-2 text-sm font-medium text-text">
            <Users size={15} className="text-violet" /> {t('autonomousRunner.managerCreated', { n: specs.length })}
            {running && phase === 'review' && <span className="ml-2 inline-flex items-center gap-1 text-xs text-cyan"><Loader2 size={12} className="animate-spin" /> {t('autonomousRunner.crossChecking')}</span>}
            {running && phase === 'synth' && <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted"><Loader2 size={12} className="animate-spin" /> {t('autonomousRunner.combiningResults')}</span>}
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
                      <Loader2 size={14} className="shrink-0 animate-spin text-violet" />
                    ) : s.status === 'review' ? (
                      <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-cyan"><Loader2 size={13} className="animate-spin" /> {t('autonomousRunner.reviewing')}</span>
                    ) : s.status === 'fixing' ? (
                      <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-amber"><Loader2 size={13} className="animate-spin" /> {t('autonomousRunner.fixing')}</span>
                    ) : s.status === 'done' ? (
                      <><Check size={14} className="shrink-0 text-teal" /><ChevronDown size={15} className={cn('shrink-0 text-muted transition-transform', openStep === i && 'rotate-180')} /></>
                    ) : (
                      <span className="shrink-0 text-[11px] text-muted">…</span>
                    )}
                  </button>
                  {/* peer-review verdict: which teammate checked this, score, issues, revision */}
                  {s.review && (
                    <div className="mx-3.5 mb-2.5 rounded-lg border border-amber/20 bg-amber/[0.05] px-3 py-2">
                      <p className="flex items-center gap-1.5 text-[11.5px] font-medium text-amber">
                        <MessageSquare size={12} /> {t('autonomousRunner.reviewedBy', { name: s.reviewedBy ?? '' })} · {s.review.score}/100 · {s.review.approved ? t('autonomousRunner.approved') : t('autonomousRunner.hasIssues')}
                      </p>
                      {s.review.issues.length > 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {s.review.issues.slice(0, 4).map((it, k) => <li key={k} className="text-[11px] text-muted">• {it}</li>)}
                        </ul>
                      )}
                      {s.revised && <p className="mt-1 text-[11px] font-medium text-teal">{t('autonomousRunner.revisedNote')}</p>}
                      {s.escalated && <p className="mt-1 text-[11px] font-medium text-amber">{t('autonomousRunner.escalatedNote')}</p>}
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

      {result && !running && (
        <div className="mt-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-base font-medium text-text"><Sparkles size={16} className="text-violet" /> {t('autonomousRunner.resultTitle')}</h2>
            <button onClick={reset} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ice/12 px-2.5 py-1.5 text-xs font-medium text-muted hover:text-text">
              <RotateCcw size={13} /> {t('autonomousRunner.newGoal')}
            </button>
          </div>
          {escalatedCount > 0 && (
            <div className="rounded-xl border border-amber/30 bg-amber/10 px-4 py-3 text-[13px] text-amber">⚠ {t('autonomousRunner.escalatedBanner', { count: escalatedCount })}</div>
          )}
          <div className="card rounded-2xl p-6"><Markdown content={result} /></div>
          <DocExport content={result} title={goal} />
          {postActions && <QualityBar goal={goal} content={result} model={model} lang={lang} onRevised={setResult} />}
          {postActions && <DeliveryBar content={result} />}
          {!presetSpecs?.length && (
            <button onClick={saveTeam} disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition disabled:opacity-40">
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {t('autonomousRunner.saveTeam')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Cross-review bar: a critical peer reviewer on the team checks the finished
 * deliverable (approved + score + concrete issues), and the team can REDO it with
 * those notes applied — the "agents check each other" loop, visible in the product.
 */
export function QualityBar({ goal, content, model, lang, onRevised }: { goal: string; content: string; model?: string; lang: string; onRevised: (t: string) => void }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [revising, setRevising] = useState(false)
  const [v, setV] = useState<{ approved: boolean; score: number; issues: string[]; fix: string } | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invoke = async (b: Record<string, unknown>): Promise<any> => {
    if (!supabase) return null
    const { data, error } = await supabase.functions.invoke('orchestrate', { body: { ...b, lang, ...(model ? { model } : {}) } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (error || !(data as any)?.ok) return null
    return data
  }
  const check = async () => {
    if (busy) return
    setBusy(true); setV(null)
    try {
      const r = await invoke({ action: 'review', goal, work: content, author_role: 'команда', reviewer_system: 'Ты — придирчивый главный редактор Nemo. Проверяешь готовый контент перед публикацией.', criteria: 'соответствие задаче; конкретика и факты; отсутствие клише и воды; готовность к публикации' })
      if (r) setV({ approved: Boolean(r.approved), score: Number(r.score) || 0, issues: Array.isArray(r.issues) ? r.issues : [], fix: String(r.fix ?? '') })
    } finally { setBusy(false) }
  }
  const revise = async () => {
    if (!v || revising) return
    setRevising(true)
    try {
      const r = await invoke({ action: 'step', goal, role: 'writer', task: 'Перепиши и улучши этот контент, устранив ВСЕ замечания рецензента. Верни готовый контент целиком, в том же формате.', system: 'Ты — сильный редактор-копирайтер. Улучшаешь готовый контент по замечаниям коллеги, сохраняя формат и смысл.', context: `ТЕКУЩИЙ КОНТЕНТ:\n${content}\n\nЗАМЕЧАНИЯ РЕЦЕНЗЕНТА:\n${v.fix}\n${v.issues.join('\n')}` })
      if (r?.output) { onRevised(r.output); setV(null) }
    } finally { setRevising(false) }
  }
  const band = v ? (v.score >= 70 ? 'text-teal' : v.score >= 50 ? 'text-amber' : 'text-danger') : ''
  return (
    <div className="card rounded-2xl border border-cyan/15 bg-cyan/[0.04] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-medium uppercase tracking-wide text-muted">{t('autonomousRunner.qualityCheck')}</span>
        <button onClick={check} disabled={busy} className="inline-flex items-center gap-2 rounded-xl border border-ice/12 px-3.5 py-2 text-sm font-medium text-muted transition hover:text-text disabled:opacity-40">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {t('autonomousRunner.teamReviews')}
        </button>
        {v && <span className={cn('text-sm font-semibold', band)}>{v.approved ? t('autonomousRunner.approved') : t('autonomousRunner.hasIssues')} · {v.score}/100</span>}
      </div>
      {v && v.issues.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {v.issues.map((it, i) => <li key={i} className="flex gap-2 text-[13px] text-muted"><span className="text-amber">•</span> {it}</li>)}
        </ul>
      )}
      {v && !v.approved && (
        <button onClick={revise} disabled={revising} className="mt-3 inline-flex items-center gap-2 rounded-xl bg-brand px-3.5 py-2 text-sm font-medium text-white transition disabled:opacity-40">
          {revising ? <Loader2 size={15} className="animate-spin" /> : <RotateCcw size={15} />} {t('autonomousRunner.reviseWithNotes')}
        </button>
      )}
    </div>
  )
}

/**
 * Delivery bar under a finished deliverable: the AI creates the visual ITSELF
 * (derives the image prompt from the content, then generates on the account's OpenAI
 * key), and the post can be pushed to a connected Telegram channel in one click.
 */
interface TgBot { id: string; label: string | null; username: string | null }
export function DeliveryBar({ content }: { content: string }) {
  const { t } = useI18n()
  const [imgBusy, setImgBusy] = useState(false)
  const [img, setImg] = useState<string | null>(null)
  const [imgPrompt, setImgPrompt] = useState('')
  const [imgErr, setImgErr] = useState('')
  // image realism + engine: default to a photorealistic model (fixes the cartoon/3D look)
  const [imgStyle, setImgStyle] = useState<'realistic' | 'illustration'>('realistic')
  const [imgModel, setImgModel] = useState(DEFAULT_IMAGE_MODEL)
  // telegram
  const [tgOpen, setTgOpen] = useState(false)
  const [bots, setBots] = useState<TgBot[]>([])
  const [botId, setBotId] = useState('')
  const [target, setTarget] = useState('')
  const [tgBusy, setTgBusy] = useState(false)
  const [tgMsg, setTgMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const makeVisual = async () => {
    if (!supabase || imgBusy) return
    setImgBusy(true); setImgErr(''); setImg(null); setImgPrompt('')
    try {
      const { data } = await supabase.functions.invoke('content-visual', { body: { content, style: imgStyle, image_model: imgStyle === 'realistic' ? imgModel : 'google/gemini-2.5-flash-image' } })
      const p = data as { ok?: boolean; image?: string; url?: string; prompt?: string; code?: string; message?: string; error?: string } | null
      if (p?.ok) { setImg(p.image || p.url || null); setImgPrompt(p.prompt || '') }
      else setImgErr(p?.message || p?.error || t('autonomousRunner.visualFailed'))
    } catch { setImgErr(t('autonomousRunner.visualError')) } finally { setImgBusy(false) }
  }

  const openTelegram = async () => {
    setTgOpen((v) => !v)
    if (bots.length || !supabase) return
    try {
      // select only client-granted columns — credentials (bot token) and label are not
      // exposed to the browser, so requesting them 403s. Number the bots for the picker.
      const { data } = await supabase.from('channels').select('id, type').eq('type', 'telegram')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list = ((data as any[]) ?? []).map((c, i) => ({ id: c.id, label: t('autonomousRunner.tgBotN', { n: i + 1 }), username: null }))
      setBots(list); if (list[0]) setBotId(list[0].id)
    } catch { /* ignore */ }
  }
  const sendTelegram = async () => {
    if (!supabase || tgBusy) return
    setTgBusy(true); setTgMsg(null)
    try {
      const { data } = await supabase.functions.invoke('autopost', { body: { action: 'send_now', platform: 'telegram', channel_id: botId || null, target_chat: target.trim(), content } })
      const p = data as { ok?: boolean; error?: string } | null
      setTgMsg(p?.ok ? { ok: true, text: t('autonomousRunner.sentToTelegram') } : { ok: false, text: p?.error ?? t('autonomousRunner.sendFailed') })
    } catch { setTgMsg({ ok: false, text: t('autonomousRunner.sendError') }) } finally { setTgBusy(false) }
  }

  return (
    <div className="card rounded-2xl border border-violet/15 bg-violet/[0.04] p-4">
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">{t('autonomousRunner.deliveryTitle')}</p>
      {/* image realism: realistic photo (default) vs illustration, + engine when realistic */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-xl border border-ice/12 p-0.5">
          {(['realistic', 'illustration'] as const).map((s) => (
            <button key={s} onClick={() => setImgStyle(s)}
              className={cn('rounded-[10px] px-3 py-1.5 text-xs font-medium transition', imgStyle === s ? 'bg-violet/20 text-text' : 'text-muted hover:text-text')}>
              {t(`autonomousRunner.style_${s}`)}
            </button>
          ))}
        </div>
        {imgStyle === 'realistic' && (
          <select value={imgModel} onChange={(e) => setImgModel(e.target.value)}
            className="rounded-xl border border-ice/12 bg-black/20 px-3 py-1.5 text-xs text-text outline-none focus:border-violet/50">
            {IMAGE_MODEL_CATALOG.filter((m) => m.realistic).map((m) => (
              <option key={m.id} value={m.id} className="bg-panel">{m.label}</option>
            ))}
          </select>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <button onClick={makeVisual} disabled={imgBusy} className="inline-flex items-center gap-2 rounded-xl bg-brand px-3.5 py-2 text-sm font-medium text-white transition disabled:opacity-40">
          {imgBusy ? <Loader2 size={15} className="animate-spin" /> : <ImageIcon size={15} />} {t('autonomousRunner.aiMakesVisual')}
        </button>
        <button onClick={openTelegram} className={cn('inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-medium transition', tgOpen ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/12 text-muted hover:text-text')}>
          <Send size={15} /> {t('autonomousRunner.sendToTelegram')}
        </button>
      </div>

      {imgErr && <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{imgErr}</p>}
      {img && (
        <div className="mt-3">
          {imgPrompt && <p className="mb-2 text-[11px] text-fog">{t('autonomousRunner.aiVisualLabel')} <span className="text-muted">{imgPrompt}</span></p>}
          <img src={img} alt={t('autonomousRunner.aiVisualAlt')} className="max-h-96 rounded-2xl border border-ice/10" />
          <a href={img} download="nemo-visual.png" className="mt-2 inline-flex items-center gap-1.5 text-xs text-violet hover:underline"><Download size={13} /> {t('autonomousRunner.download')}</a>
        </div>
      )}

      {tgOpen && (
        <div className="mt-3 rounded-xl border border-ice/10 bg-black/20 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted">{t('autonomousRunner.sendPostToChannel')}</span>
            <button onClick={() => setTgOpen(false)} className="text-muted hover:text-text"><X size={14} /></button>
          </div>
          {bots.length ? (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <select value={botId} onChange={(e) => setBotId(e.target.value)} className="glass rounded-xl px-3 py-2 text-sm text-text outline-none focus:border-violet/50">
                {bots.map((b) => <option key={b.id} value={b.id} className="bg-panel">{b.label || (b.username ? '@' + b.username : t('autonomousRunner.bot'))}</option>)}
              </select>
              <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={t('autonomousRunner.channelTargetPh')} className="glass rounded-xl px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
            </div>
          ) : (
            <p className="mt-2 text-[12px] text-amber">{t('autonomousRunner.connectBotHint')}</p>
          )}
          <button onClick={sendTelegram} disabled={tgBusy || !bots.length || target.trim().length < 2} className="mt-2 inline-flex items-center gap-2 rounded-xl bg-brand px-3.5 py-2 text-sm font-medium text-white transition disabled:opacity-40">
            {tgBusy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} {t('autonomousRunner.sendNow')}
          </button>
          {tgMsg && <p className={cn('mt-2 rounded-lg px-3 py-1.5 text-xs', tgMsg.ok ? 'bg-teal/10 text-teal' : 'bg-danger/10 text-danger')}>{tgMsg.text}</p>}
        </div>
      )}
    </div>
  )
}
