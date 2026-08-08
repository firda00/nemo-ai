import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Brain, CheckCircle2, Clock, ShieldQuestion, Trash2, User } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { Button } from '../../components/ui/Button'

type Claim = {
  id: string
  statement: string
  kind: 'fact' | 'preference' | 'constraint' | 'lesson'
  subject: string
  source: 'owner' | 'agent' | 'tool' | 'outcome'
  status: 'active' | 'disputed' | 'retired'
  confidence: number
  evidence_for: number
  evidence_against: number
  expired: boolean
  valid_until: string | null
  from_run: boolean
}

type Scoreboard = { resolved: number; confirmed: number; refuted: number; unmeasurable: number; accuracy: number | null; unmeasurable_share: number | null }
type Recalls = { ok: number; empty: number; failed: number }

export default function MemoryPage() {
  const { t } = useI18n()
  const [claims, setClaims] = useState<Claim[]>([])
  const [board, setBoard] = useState<Scoreboard | null>(null)
  const [recalls, setRecalls] = useState<Recalls | null>(null)
  // Клиент известен на этапе модуля, поэтому «не настроено» — состояние рендера, а не состояние
  // компонента: иначе эффект синхронно вызывает setState и запускает каскад перерисовок.
  const [loading, setLoading] = useState(Boolean(supabase))
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [draftKind, setDraftKind] = useState<Claim['kind']>('constraint')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    if (!supabase) return
    // Никакого setLoading здесь: состояние уже начинается с loading, а синхронный setState внутри
    // эффекта запускает каскад перерисовок. Повторную попытку подсвечивает сам обработчик.
    const { data, error: failed } = await supabase.functions.invoke('org-memory', { body: { action: 'list' } })
    const result = data as { ok?: boolean; claims?: Claim[]; scoreboard?: Scoreboard; recalls?: Recalls } | null
    // Ошибка чтения показывается ошибкой, а не пустым списком: «система ничего не знает» и «мы не
    // смогли спросить» — разные новости, и вторая не должна выглядеть первой.
    if (failed || !result?.ok) { setError(true); setLoading(false); return }
    setError(false)
    setClaims(result.claims ?? [])
    setBoard(result.scoreboard ?? null)
    setRecalls(result.recalls ?? null)
    setLoading(false)
  }, [])

  // Отложенный на тик запуск — тот же приём, что на странице Commerce: правило запрещает
  // синхронный setState в эффекте, а таймер выводит загрузку за пределы фазы рендера.
  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const act = async (action: 'retire' | 'affirm', claimId: string) => {
    if (!supabase) return
    setBusy(claimId)
    await supabase.functions.invoke('org-memory', { body: { action, claim_id: claimId } })
    setBusy(null)
    await load()
  }

  const state = async () => {
    if (!supabase || draft.trim().length < 8) return
    setBusy('new')
    const { data } = await supabase.functions.invoke('org-memory', {
      body: { action: 'state', statement: draft.trim(), kind: draftKind, subject: 'owner' },
    })
    const result = data as { ok?: boolean; reason?: string } | null
    setNotice(result?.ok ? t('memory.stated') : t(`memory.rejected.${result?.reason ?? 'shape'}`))
    if (result?.ok) setDraft('')
    setBusy(null)
    await load()
  }

  const active = claims.filter((claim) => claim.status === 'active' && !claim.expired)
  const disputed = claims.filter((claim) => claim.status === 'disputed')
  const expired = claims.filter((claim) => claim.status === 'active' && claim.expired)
  const retired = claims.filter((claim) => claim.status === 'retired')

  return (
    <div className="container-page max-w-5xl py-8">
      <header className="gradient-ring rounded-3xl p-px">
        <div className="rounded-[1.45rem] bg-panel/90 p-6">
          <p className="mono-label">{t('memory.eyebrow')}</p>
          <h1 className="mt-2 flex items-center gap-2 text-3xl font-extrabold text-text">
            <Brain className="h-7 w-7 text-violet" /> {t('memory.title')}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{t('memory.subtitle')}</p>
        </div>
      </header>

      {/* Точность и доля неизмеримого стоят рядом: без второго первое врёт тем сильнее, чем хуже дела. */}
      {board && board.resolved > 0 && (
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <Tile label={t('memory.board.resolved')} value={String(board.resolved)} />
          <Tile label={t('memory.board.accuracy')} value={board.accuracy == null ? '—' : `${Math.round(board.accuracy * 100)}%`} />
          <Tile label={t('memory.board.unmeasurable')} value={board.unmeasurable_share == null ? '—' : `${Math.round(board.unmeasurable_share * 100)}%`} tone="warn" />
        </div>
      )}
      {recalls && recalls.failed > 0 && (
        <p className="mt-3 rounded-2xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
          <AlertTriangle className="mr-2 inline h-4 w-4" />{t('memory.recallsFailed', { n: recalls.failed })}
        </p>
      )}

      <section className="card mt-6 rounded-3xl p-5">
        <h2 className="text-lg font-bold text-text">{t('memory.state.title')}</h2>
        <p className="mt-1 text-sm text-muted">{t('memory.state.hint')}</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <select
            value={draftKind}
            onChange={(event) => setDraftKind(event.target.value as Claim['kind'])}
            className="rounded-xl border border-white/10 bg-bg/60 px-3 py-2 text-sm text-text"
            aria-label={t('memory.state.kind')}
          >
            <option value="constraint">{t('memory.kind.constraint')}</option>
            <option value="preference">{t('memory.kind.preference')}</option>
            <option value="fact">{t('memory.kind.fact')}</option>
            <option value="lesson">{t('memory.kind.lesson')}</option>
          </select>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t('memory.state.placeholder')}
            className="flex-1 rounded-xl border border-white/10 bg-bg/60 px-3 py-2 text-sm text-text"
          />
          <Button onClick={state} disabled={busy === 'new' || draft.trim().length < 8}>{t('memory.state.action')}</Button>
        </div>
        {notice && <p className="mt-2 text-sm text-muted">{notice}</p>}
      </section>

      {loading && <div className="mt-6 space-y-3">{[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-2xl bg-panel/60" />)}</div>}

      {!loading && (error || !supabase) && (
        <p className="mt-6 rounded-2xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">
          {t('memory.error')} <button className="underline" onClick={() => { setLoading(true); void load() }}>{t('memory.retry')}</button>
        </p>
      )}

      {!loading && !error && supabase && !claims.length && (
        <p className="mt-6 rounded-2xl border border-white/10 bg-panel/60 px-4 py-6 text-center text-sm text-muted">{t('memory.empty')}</p>
      )}

      {!loading && !error && (
        <>
          <Group title={t('memory.group.disputed')} hint={t('memory.group.disputedHint')} claims={disputed} busy={busy} onRetire={(id) => act('retire', id)} onAffirm={(id) => act('affirm', id)} t={t} />
          <Group title={t('memory.group.active')} claims={active} busy={busy} onRetire={(id) => act('retire', id)} t={t} />
          <Group title={t('memory.group.expired')} hint={t('memory.group.expiredHint')} claims={expired} busy={busy} onRetire={(id) => act('retire', id)} t={t} />
          <Group title={t('memory.group.retired')} hint={t('memory.group.retiredHint')} claims={retired} busy={busy} t={t} muted />
        </>
      )}
    </div>
  )
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className={`rounded-2xl border px-4 py-3 ${tone === 'warn' ? 'border-amber-400/25 bg-amber-400/5' : 'border-white/10 bg-panel/60'}`}>
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-black ${tone === 'warn' ? 'text-amber-300' : 'text-text'}`}>{value}</p>
    </div>
  )
}

function Group({ title, hint, claims, busy, onRetire, onAffirm, t, muted }: {
  title: string; hint?: string; claims: Claim[]; busy: string | null
  onRetire?: (id: string) => void; onAffirm?: (id: string) => void
  t: (key: string, vars?: Record<string, string | number>) => string; muted?: boolean
}) {
  if (!claims.length) return null
  return (
    <section className="mt-6">
      <h2 className="text-lg font-bold text-text">{title} <span className="text-sm font-normal text-muted">({claims.length})</span></h2>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      <div className="mt-3 space-y-2">
        {claims.map((claim) => (
          <article key={claim.id} className={`card rounded-2xl p-4 ${muted ? 'opacity-60' : ''}`}>
            <p className="text-sm text-text">{claim.statement}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <Pill>{t(`memory.kind.${claim.kind}`)}</Pill>
              <Pill>{claim.subject}</Pill>
              {/* Происхождение видно всегда: слово владельца и догадка агента не должны выглядеть одинаково. */}
              <Pill tone={claim.source === 'owner' ? 'owner' : undefined}>
                {claim.source === 'owner' ? <User className="mr-1 inline h-3 w-3" /> : null}
                {t(`memory.source.${claim.source}`)}
              </Pill>
              {claim.evidence_for + claim.evidence_against > 0 ? (
                <Pill tone={claim.evidence_against > claim.evidence_for ? 'bad' : 'good'}>
                  <CheckCircle2 className="mr-1 inline h-3 w-3" />
                  {t('memory.evidence', { for: claim.evidence_for, total: claim.evidence_for + claim.evidence_against })}
                </Pill>
              ) : (
                <Pill tone="unknown">{t('memory.noEvidence')}</Pill>
              )}
              <Pill>{t('memory.confidence', { v: claim.confidence.toFixed(2) })}</Pill>
              {claim.valid_until && (
                <Pill tone={claim.expired ? 'bad' : undefined}>
                  <Clock className="mr-1 inline h-3 w-3" />
                  {claim.expired ? t('memory.expired') : t('memory.until', { d: String(claim.valid_until).slice(0, 10) })}
                </Pill>
              )}
            </div>
            {(onRetire || onAffirm) && (
              <div className="mt-3 flex flex-wrap gap-2">
                {onAffirm && (
                  <Button variant="outline" onClick={() => onAffirm(claim.id)} disabled={busy === claim.id}>
                    <ShieldQuestion className="mr-1 h-4 w-4" />{t('memory.affirm')}
                  </Button>
                )}
                {onRetire && (
                  <Button variant="outline" onClick={() => onRetire(claim.id)} disabled={busy === claim.id}>
                    <Trash2 className="mr-1 h-4 w-4" />{t('memory.retire')}
                  </Button>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}

function Pill({ children, tone }: { children: React.ReactNode; tone?: 'good' | 'bad' | 'owner' | 'unknown' }) {
  const style = tone === 'good' ? 'border-teal/30 bg-teal/10 text-teal'
    : tone === 'bad' ? 'border-red-400/30 bg-red-400/10 text-red-200'
    : tone === 'owner' ? 'border-violet/30 bg-violet/10 text-violet'
    : tone === 'unknown' ? 'border-white/10 bg-white/5 text-muted'
    : 'border-white/10 bg-white/5 text-muted'
  return <span className={`rounded-full border px-2 py-0.5 ${style}`}>{children}</span>
}
