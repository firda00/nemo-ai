// Monthly reminders — settings panel (Plan B wrapper stage). Server-driven and bounded:
//   • every wait goes through callBoundedFunction (one deadline, error bodies included);
//   • the server decides authorization (owner_required renders nothing at all) and every rule
//     (verification, day/minute validation, the atomic 30-schedule cap) — the panel only
//     phrases the typed refusals;
//   • OWNERSHIP: the rendered data is keyed by a generation-stamped session scope (same
//     contract as the margin chat card). An auth switch under the mounted panel hides the
//     previous user's schedules/history/draft immediately (the form is not even rendered until
//     the new identity's list arrives — an old draft can never be submitted under a new
//     token), and a late load/save completion from the previous identity is ignored;
//   • the Feb/short-month CLAMP policy is ALWAYS visible next to the day picker;
//   • occurrence history translates terminal reasons; a failed history read hides the block.
import { BellRing, Loader2, Pencil, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useI18n } from '../../i18n'
import { callBoundedFunction } from '../../lib/boundedBriefingCall'
import { createSessionScope } from '../../lib/marginRunCache'
import { isSupabaseEnabled, supabase } from '../../lib/supabase'

interface ScheduleRow {
  id: string
  title: string
  day_of_month: number
  send_minute: number
  enabled: boolean
  schedule_revision: number
  kind?: string
  report_currency?: string | null
}
interface SourceRow {
  file_sha256: string
  file_name: string
  uploaded_at: string
  period_month: string | null
}
interface OccurrenceRow {
  schedule_id: string
  month_key: string
  due_date: string
  status: string
  error: string | null
}
interface RecipientInfo { verified: boolean; channel_bound: boolean }
interface PanelView {
  scope: string
  forbidden: boolean
  loadError: boolean
  schedules: ScheduleRow[]
  occurrences: OccurrenceRow[] | null
  recipient: RecipientInfo | null
  sources: SourceRow[] | null
  sourcesHasMore: boolean
}
interface SourcePages { page: number; extra: SourceRow[]; hasMore: boolean; truncated: boolean; moreFailed: boolean }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callReminders(body: Record<string, unknown>): Promise<{ ok: boolean; reached: boolean; payload: any }> {
  if (!supabase) return Promise.resolve({ ok: false, reached: false, payload: null })
  return callBoundedFunction(() => supabase!.functions.invoke('reminders', { body }))
}

const reminderScope = createSessionScope()

const minuteToTime = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
const timeToMinute = (value: string): number | null => {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  const minute = Number(match[1]) * 60 + Number(match[2])
  return minute >= 0 && minute <= 1439 ? minute : null
}

// terminal occurrence reasons the server can record — phrased, never raw, for known slugs
const ERROR_KEYS: Record<string, string> = {
  schedule_disabled: 'reminderErr_schedule_disabled',
  expired_unsent: 'reminderErr_expired_unsent',
  attempts_exhausted: 'reminderErr_attempts_exhausted',
  dispatch_lease_expired: 'reminderErr_dispatch_lease_expired',
  external_blocked: 'reminderErr_external_blocked',
  recipient_not_verified: 'reminderErr_recipient_not_verified',
  pre_consent: 'reminderErr_pre_consent',
  superseded: 'reminderErr_superseded',
  token_unavailable: 'reminderErr_token_unavailable',
  telegram_rejected: 'reminderErr_telegram_rejected',
  send_ambiguous: 'reminderErr_send_ambiguous',
  source_missing_period: 'reminderErr_source_missing_period',
  source_read_failed: 'reminderErr_source_read_failed',
  source_integrity: 'reminderErr_source_integrity',
  document_too_large: 'reminderErr_document_too_large',
  report_unsupported: 'reminderErr_report_unsupported',
  engine_invalid_period: 'reminderErr_invalid_filter_period',
  engine_needs_source_dates: 'reminderErr_source_dates',
  engine_no_rows_period: 'reminderErr_no_rows_period',
  engine_source_incomplete: 'reminderErr_source_dates',
  engine_source_unreadable: 'reminderErr_source_read_failed',
  engine_source_too_large: 'reminderErr_document_too_large',
}

export function ReminderPanel() {
  const { t } = useI18n()
  const { user } = useAuth()
  const scope = reminderScope(user?.id ?? null)
  const scopeRef = useRef(scope)
  const opRef = useRef(0)
  const [view, setView] = useState<PanelView | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [dayText, setDayText] = useState('30')
  const [timeText, setTimeText] = useState('09:00')
  const [kindText, setKindText] = useState<'reminder' | 'product_report'>('reminder')
  const [currencyText, setCurrencyText] = useState('UZS')
  const [periodDrafts, setPeriodDrafts] = useState<Record<string, string>>({})
  const [sourcePages, setSourcePages] = useState<SourcePages>({ page: 0, extra: [], hasMore: false, truncated: false, moreFailed: false })
  const [message, setMessage] = useState('')
  // busy is OWNED by an (operation, identity) token: an old user's still-pending save neither
  // blocks nor un-blocks the next identity's controls
  const saveOpRef = useRef(0)
  const busySaveRef = useRef<{ op: number; scope: string } | null>(null)
  const [busyToken, setBusyToken] = useState<{ op: number; scope: string } | null>(null)
  const busy = busyToken !== null && busyToken.scope === scope

  const load = useCallback(async (targetScope: string, resetDraft = true) => {
    if (!supabase) return
    const opId = ++opRef.current
    const result = await callReminders({ action: 'list' })
    // a late completion must not repopulate a different (or newer) identity's panel
    if (opId !== opRef.current || scopeRef.current !== targetScope) return
    const forbidden = result.payload?.error === 'owner_required'
    const ok = result.ok && result.payload?.ok === true
    setView({
      scope: targetScope,
      forbidden,
      loadError: !forbidden && !ok,
      schedules: ok ? (result.payload.schedules ?? []) as ScheduleRow[] : [],
      occurrences: ok ? (result.payload.occurrences ?? null) as OccurrenceRow[] | null : null,
      recipient: ok ? (result.payload.recipient ?? null) as RecipientInfo | null : null,
      sources: ok ? (result.payload.sources ?? null) as SourceRow[] | null : null,
      sourcesHasMore: ok && result.payload.sources_has_more === true,
    })
    setMessage('')
    setSourcePages({ page: 0, extra: [], hasMore: ok && result.payload.sources_has_more === true, truncated: false, moreFailed: false })
    // the draft clears ONLY on an identity change or after a successful schedule save — a
    // source-period refresh mid-drafting must not eat the schedule the user is composing
    if (resetDraft) {
      setEditingId(null)
      setTitle('')
      setKindText('reminder')
      setPeriodDrafts({})
    }
  }, [])

  useEffect(() => {
    scopeRef.current = scope
    // every setState inside load() sits AFTER its await and is op/scope-fenced — this is the
    // subscribe-and-refresh pattern, not a synchronous cascading render
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(scope)
  }, [scope, load])

  const reasonText = (reason: string): string => {
    if (reason === 'recipient_not_verified') return t('settingsPage.reminderNeedVerified')
    if (reason === 'schedule_limit') return t('settingsPage.reminderLimit')
    if (reason === 'bad_title' || reason === 'bad_day' || reason === 'bad_minute'
      || reason === 'bad_kind' || reason === 'bad_currency' || reason === 'kind_immutable') return t('settingsPage.reminderValidation')
    if (reason === 'bad_period' || reason === 'invalid_period') return t('settingsPage.reminderPeriodInvalid')
    if (reason === 'not_found') return t('settingsPage.reminderSourceGone')
    return t('settingsPage.reminderSaveFailed')
  }

  const save = async (body: Record<string, unknown>, action: 'save' | 'set-period' = 'save') => {
    const scopeAtStart = scopeRef.current
    // single-flight PER IDENTITY: the previous user's pending save must not lock this one out
    if (busySaveRef.current?.scope === scopeAtStart) return
    const op = ++saveOpRef.current
    busySaveRef.current = { op, scope: scopeAtStart }
    setBusyToken({ op, scope: scopeAtStart })
    setMessage('')
    try {
      const result = await callReminders({ action, ...body })
      if (scopeAtStart !== scopeRef.current) return // identity changed mid-save: stay silent
      if (result.payload?.ok === true) {
        // refresh FIRST (its completion clears the message field), then confirm — the
        // confirmation must survive the reload. A set-period refresh PRESERVES the draft.
        await load(scopeAtStart, action === 'save')
        if (scopeAtStart === scopeRef.current) setMessage(t('settingsPage.reminderSaved'))
      } else {
        setMessage(reasonText(String(result.payload?.error ?? '')))
      }
    } finally {
      // release only OUR token — a late settle must never clear a newer identity's busy state
      if (busySaveRef.current?.op === op) busySaveRef.current = null
      setBusyToken((previous) => previous && previous.op === op ? null : previous)
    }
  }

  const toggleRow = (row: ScheduleRow) => {
    void save({
      schedule_id: row.id,
      title: row.title,
      day_of_month: row.day_of_month,
      send_minute: row.send_minute,
      enabled: !row.enabled,
      kind: row.kind ?? 'reminder',
      report_currency: row.report_currency ?? null,
    })
  }

  // the panel renders ONLY the current identity's view; anything older is dropped, not shown
  const current = view && view.scope === scope ? view : null

  const submit = () => {
    if (!current) return
    const day = Number(dayText)
    const minute = timeToMinute(timeText)
    if (!title.trim() || !Number.isInteger(day) || day < 1 || day > 31 || minute === null) {
      setMessage(t('settingsPage.reminderValidation'))
      return
    }
    const editing = current.schedules.find((row) => row.id === editingId)
    const kind = editing ? (editing.kind ?? 'reminder') : kindText // the kind is frozen after creation
    void save({
      ...(editingId ? { schedule_id: editingId } : {}),
      title: title.trim(),
      day_of_month: day,
      send_minute: minute,
      enabled: editing ? editing.enabled : false,
      kind,
      report_currency: kind === 'product_report' ? currencyText : null,
    })
  }

  const loadMoreSources = async () => {
    const scopeAtStart = scopeRef.current
    if (busySaveRef.current?.scope === scopeAtStart) return
    const op = ++saveOpRef.current
    busySaveRef.current = { op, scope: scopeAtStart }
    setBusyToken({ op, scope: scopeAtStart })
    try {
      const nextPage = sourcePages.page + 1
      const result = await callReminders({ action: 'sources', page: nextPage })
      if (scopeAtStart !== scopeRef.current) return
      if (result.payload?.ok === true) {
        const rows = (result.payload.sources ?? []) as SourceRow[]
        setSourcePages((previous) => ({
          page: nextPage,
          extra: [...previous.extra, ...rows],
          hasMore: result.payload.has_more === true,
          truncated: result.payload.truncated === true,
          moreFailed: false,
        }))
      } else {
        setSourcePages((previous) => ({ ...previous, moreFailed: true }))
      }
    } finally {
      if (busySaveRef.current?.op === op) busySaveRef.current = null
      setBusyToken((previous) => previous && previous.op === op ? null : previous)
    }
  }

  const setPeriod = (sha: string) => {
    const month = periodDrafts[sha] ?? ''
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      setMessage(t('settingsPage.reminderPeriodInvalid'))
      return
    }
    void save({ file_sha256: sha, period_month: month }, 'set-period')
  }

  const cancelEdit = () => {
    setEditingId(null)
    setTitle('')
    setMessage('')
  }

  const startEdit = (row: ScheduleRow) => {
    setEditingId(row.id)
    setTitle(row.title)
    setDayText(String(row.day_of_month))
    setTimeText(minuteToTime(row.send_minute))
    setKindText((row.kind ?? 'reminder') as 'reminder' | 'product_report')
    if (row.report_currency) setCurrencyText(row.report_currency)
    setMessage('')
  }

  if (current?.forbidden) return null

  return <section className="card mt-5 rounded-2xl p-5 sm:p-6" aria-labelledby="reminder-panel-title">
    <div className="flex items-start gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet/15 to-accent-cyan/15 text-violet"><BellRing size={18} /></span>
      <div className="min-w-0 flex-1">
        <h2 id="reminder-panel-title" className="font-semibold text-text">{t('settingsPage.reminderTitle')}</h2>
        <p className="mt-1 text-xs leading-5 text-muted">{t('settingsPage.reminderDesc')}</p>
      </div>
    </div>

    {!isSupabaseEnabled && <p className="mt-4 text-xs text-muted">{t('settingsPage.reminderDemo')}</p>}
    {isSupabaseEnabled && !current && <p className="mt-4 flex items-center gap-2 text-xs text-muted"><Loader2 size={13} className="animate-spin" />…</p>}
    {isSupabaseEnabled && current && current.loadError && <p className="mt-4 text-xs text-amber">
      {t('settingsPage.reminderLoadFailed')}{' '}
      <button type="button" onClick={() => void load(scope)} className="font-semibold underline">{t('settingsPage.reminderRetry')}</button>
    </p>}

    {isSupabaseEnabled && current && !current.loadError && <div className="mt-4 space-y-4">
      {current.recipient && !current.recipient.verified && (
        <p className="rounded-xl border border-amber/30 bg-amber/10 px-3 py-2 text-xs leading-5 text-amber">
          {t('settingsPage.reminderNeedVerified')}{' '}
          <a href="#briefing-panel" className="font-semibold underline">{t('settingsPage.reminderVerifyLink')}</a>
        </p>
      )}

      {!current.schedules.length && <p className="text-xs text-muted">{t('settingsPage.reminderEmpty')}</p>}
      {!!current.schedules.length && <ul className="space-y-2">
        {current.schedules.map((row) => <li key={row.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-ice/[0.08] bg-black/10 px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-sm text-text">{row.title}</span>
          {row.kind === 'product_report' && <span className="rounded-full border border-violet/25 bg-violet/10 px-2 py-0.5 text-[10px] font-semibold text-violet">📊 {t('settingsPage.reminderKindReport')}{row.report_currency ? ` · ${row.report_currency}` : ''}</span>}
          <span className="text-[11px] text-muted">{t('settingsPage.reminderEvery', { day: String(row.day_of_month) })} · {minuteToTime(row.send_minute)}</span>
          <span className={row.enabled ? 'rounded-full border border-teal/20 bg-teal/10 px-2 py-0.5 text-[10px] font-semibold text-teal' : 'rounded-full border border-ice/15 bg-black/15 px-2 py-0.5 text-[10px] font-semibold text-fog'}>
            {row.enabled ? t('settingsPage.reminderEnabled') : t('settingsPage.reminderDisabled')}
          </span>
          <button type="button" onClick={() => startEdit(row)} disabled={busy} aria-label={t('settingsPage.reminderEdit')} className="rounded-lg p-1.5 text-muted hover:bg-white/[0.05] hover:text-text disabled:opacity-40"><Pencil size={13} /></button>
          <button type="button" onClick={() => toggleRow(row)} disabled={busy} className="rounded-lg border border-ice/10 px-2.5 py-1 text-[11px] font-semibold text-text hover:bg-white/[0.05] disabled:opacity-40">
            {row.enabled ? t('settingsPage.reminderDisable') : t('settingsPage.reminderEnable')}
          </button>
        </li>)}
      </ul>}

      <div className="rounded-xl border border-ice/[0.08] bg-black/10 p-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-40 flex-1 text-[11px] text-muted">
            {t('settingsPage.reminderTitleLabel')}
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} disabled={busy}
              placeholder={t('settingsPage.reminderTitlePlaceholder')}
              className="mt-1 w-full rounded-xl border border-ice/10 bg-black/15 px-3 py-2 text-sm text-text outline-none placeholder:text-fog" />
          </label>
          <label className="text-[11px] text-muted">
            {t('settingsPage.reminderKind')}
            <select value={kindText}
              onChange={(event) => setKindText(event.target.value as 'reminder' | 'product_report')}
              disabled={busy || editingId !== null} // the kind is frozen after creation
              className="mt-1 block rounded-xl border border-ice/10 bg-black/15 px-2 py-2 text-sm text-text outline-none">
              <option value="reminder">{t('settingsPage.reminderKindReminder')}</option>
              <option value="product_report">{t('settingsPage.reminderKindReport')}</option>
            </select>
          </label>
          {kindText === 'product_report' && <label className="text-[11px] text-muted">
            {t('settingsPage.reminderCurrency')}
            <select value={currencyText} onChange={(event) => setCurrencyText(event.target.value)} disabled={busy}
              className="mt-1 block rounded-xl border border-ice/10 bg-black/15 px-2 py-2 text-sm text-text outline-none">
              {['UZS', 'USD', 'RUB', 'EUR'].map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>}
          <label className="text-[11px] text-muted">
            {t('settingsPage.reminderDay')}
            <select value={dayText} onChange={(event) => setDayText(event.target.value)} disabled={busy}
              className="mt-1 block rounded-xl border border-ice/10 bg-black/15 px-2 py-2 text-sm text-text outline-none">
              {Array.from({ length: 31 }, (_v, index) => index + 1).map((day) => <option key={day} value={day}>{day}</option>)}
            </select>
          </label>
          <label className="text-[11px] text-muted">
            {t('settingsPage.reminderTime')}
            <input type="time" value={timeText} onChange={(event) => setTimeText(event.target.value)} disabled={busy}
              className="mt-1 block rounded-xl border border-ice/10 bg-black/15 px-2 py-2 text-sm text-text outline-none" />
          </label>
          <button type="button" onClick={submit} disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-xl bg-accent-cyan px-3 py-2.5 text-xs font-bold text-bg transition hover:brightness-105 disabled:opacity-40">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
            {editingId ? t('settingsPage.reminderSaveEdit') : t('settingsPage.reminderAdd')}
          </button>
          {editingId && <button type="button" onClick={cancelEdit} disabled={busy}
            className="inline-flex items-center gap-1 rounded-xl border border-ice/10 px-3 py-2.5 text-xs font-semibold text-muted hover:bg-white/[0.05] hover:text-text disabled:opacity-40">
            <X size={13} />{t('settingsPage.reminderCancelEdit')}
          </button>}
        </div>
        {/* the clamp policy is a PROMISE about behavior — always on screen, never a surprise */}
        <p className="mt-2 text-[10px] leading-4 text-fog">{t('settingsPage.reminderClampNote')}</p>
        {kindText === 'product_report' && <p className="mt-1 text-[10px] leading-4 text-fog">{t('settingsPage.reminderReportNote')}</p>}
        {message && <p role="status" className="mt-2 text-xs text-amber">{message}</p>}
      </div>

      {(kindText === 'product_report' || current.schedules.some((row) => row.kind === 'product_report')) && <div>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{t('settingsPage.reminderSourcesTitle')}</p>
        {current.sources === null && <p className="text-xs text-amber">
          {t('settingsPage.reminderSourcesFailed')}{' '}
          <button type="button" onClick={() => void load(scope, false)} className="font-semibold underline">{t('settingsPage.reminderRetry')}</button>
        </p>}
        {current.sources !== null && <>
          {!current.sources.length && <p className="text-xs text-muted">{t('settingsPage.reminderSourcesEmpty')}</p>}
          {!!current.sources.length && <ul className="space-y-1.5">
            {[...current.sources, ...sourcePages.extra].map((source) => <li key={source.file_sha256} className="flex flex-wrap items-center gap-2 rounded-xl border border-ice/[0.08] bg-black/10 px-3 py-1.5 text-xs">
              <span className="min-w-0 flex-1 truncate text-text">{source.file_name}</span>
              <span className="text-fog">{source.uploaded_at.slice(0, 10)}</span>
              <span className={source.period_month ? 'rounded-full border border-teal/20 bg-teal/10 px-2 py-0.5 text-[10px] font-semibold text-teal' : 'text-[10px] text-amber'}>
                {source.period_month ?? t('settingsPage.reminderPeriodNone')}
              </span>
              <input type="month" value={periodDrafts[source.file_sha256] ?? ''} disabled={busy}
                onChange={(event) => setPeriodDrafts((drafts) => ({ ...drafts, [source.file_sha256]: event.target.value }))}
                className="rounded-lg border border-ice/10 bg-black/15 px-1.5 py-1 text-[11px] text-text outline-none" />
              <button type="button" onClick={() => setPeriod(source.file_sha256)} disabled={busy}
                className="rounded-lg border border-ice/10 px-2 py-1 text-[10px] font-semibold text-text hover:bg-white/[0.05] disabled:opacity-40">
                {t('settingsPage.reminderAssignPeriod')}
              </button>
            </li>)}
          </ul>}
          {sourcePages.moreFailed && <p className="mt-1.5 text-xs text-amber">
            {t('settingsPage.reminderSourcesFailed')}{' '}
            <button type="button" onClick={() => void loadMoreSources()} className="font-semibold underline">{t('settingsPage.reminderRetry')}</button>
          </p>}
          {!sourcePages.moreFailed && sourcePages.hasMore && <button type="button" onClick={() => void loadMoreSources()} disabled={busy}
            className="mt-1.5 rounded-lg border border-ice/10 px-2.5 py-1.5 text-[11px] font-semibold text-muted hover:bg-white/[0.05] hover:text-text disabled:opacity-40">
            {t('settingsPage.reminderSourcesMore')}
          </button>}
          {sourcePages.truncated && <p className="mt-1.5 text-[10px] text-fog">{t('settingsPage.reminderSourcesTruncated')}</p>}
        </>}
      </div>}

      {current.occurrences !== null && !!current.occurrences.length && <div>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{t('settingsPage.reminderHistoryTitle')}</p>
        <ul className="space-y-1 text-xs leading-5 text-muted">
          {current.occurrences.slice(0, 8).map((row) => <li key={`${row.schedule_id}:${row.month_key}`} className="flex items-center gap-2">
            <span className="font-variant-numeric tabular-nums">{row.due_date}</span>
            <span className={row.status === 'sent' ? 'text-teal' : row.status === 'planned' || row.status === 'sending' ? 'text-text' : 'text-amber'}>
              {t(`settingsPage.reminderStatus_${row.status}`)}
            </span>
            {row.error && <span className="truncate text-fog">
              ({ERROR_KEYS[row.error] ? t(`settingsPage.${ERROR_KEYS[row.error]}`) : row.error})
            </span>}
          </li>)}
        </ul>
      </div>}
    </div>}
  </section>
}
