// Personal daily briefing — Step 2a settings + read-only preview panel (profile tab).
// Explicit opt-in: nothing is enabled until the owner saves a binding to an exact bot channel +
// chat id, and the copy says plainly that automatic delivery is NOT active yet. The recipient is
// shown as CONFIGURED, never "verified" — verification only exists after the delivery-phase claim.
//
// Truthful failure handling:
//   • every network call is bounded and try/finally-guarded — a thrown invoke can never leave the
//     panel busy forever, and a synchronous ref guard stops double submits before state updates;
//   • a save whose outcome is unknown (server said save_outcome_unknown, or the transport died
//     AFTER the request was dispatched) reconciles by reloading — and only claims "state
//     reloaded" when the reload actually succeeded;
//   • a failed bot-list query is reported as a failure, never rendered as "no bots";
//   • role gating is server-authoritative: an operator's settings-get returns owner_required and
//     the panel renders nothing, instead of trusting any client-side role field.
import { CalendarClock, RefreshCw, Send, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { useI18n } from '../../i18n'
import { callBoundedFunction, queryBounded } from '../../lib/boundedBriefingCall'
import { cn } from '../../lib/cn'
import { isSupabaseEnabled, supabase } from '../../lib/supabase'

const inputCls = 'w-full rounded-xl border border-ice/10 bg-black/15 px-3 py-2.5 text-sm text-text outline-none transition focus:border-accent-cyan/50 focus:ring-2 focus:ring-accent-cyan/10'
const labelCls = 'mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.08em] text-muted'

interface BriefingSettings {
  morning_enabled: boolean
  evening_enabled: boolean
  weather_lat: number | null
  weather_lon: number | null
  notify_channel_id: string | null
  notify_chat_id: string | null
  recipient_status: 'configured' | 'not_configured'
  recipient_verified: boolean
}

interface ChannelOption { id: string; label: string | null }
interface DeliveryStatus { implemented: boolean; enabled: boolean }
interface RunRow { kind: string; run_date: string; status: string }
interface OutcomeRow { run_date: string; text: string }
interface VerifyInfo { deepLink: string | null; payload: string }

// Bounded end to end (error-body parsing included) via the shared, offline-tested helper.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callBriefing(body: Record<string, unknown>): Promise<{ ok: boolean; reached: boolean; payload: any }> {
  if (!supabase) return Promise.resolve({ ok: false, reached: false, payload: null })
  return callBoundedFunction(() => supabase!.functions.invoke('daily-briefing', { body }))
}

export function BriefingPanel() {
  const { t, lang } = useI18n()

  const [loading, setLoading] = useState(isSupabaseEnabled)
  const [loadError, setLoadError] = useState(false)
  const [forbidden, setForbidden] = useState(false)
  const [settings, setSettings] = useState<BriefingSettings | null>(null)
  const [channels, setChannels] = useState<ChannelOption[]>([])
  const [channelsFailed, setChannelsFailed] = useState(false)
  const [morning, setMorning] = useState(false)
  const [evening, setEvening] = useState(false)
  const [latText, setLatText] = useState('')
  const [lonText, setLonText] = useState('')
  const [channelId, setChannelId] = useState('')
  const [chatId, setChatId] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [preview, setPreview] = useState('')
  const [previewBusy, setPreviewBusy] = useState<'' | 'morning' | 'evening'>('')
  const [delivery, setDelivery] = useState<DeliveryStatus | null>(null)
  const [verifyInfo, setVerifyInfo] = useState<VerifyInfo | null>(null)
  const [verifyBusy, setVerifyBusy] = useState(false)
  const [history, setHistory] = useState<RunRow[] | null>(null)
  const [outcomes, setOutcomes] = useState<OutcomeRow[] | null>(null)
  const busyRef = useRef(false)

  const applySettings = (next: BriefingSettings) => {
    setSettings(next)
    // a consumed link did its job — once the server says verified, stop showing it
    if (next.recipient_verified) setVerifyInfo(null)
    setMorning(next.morning_enabled)
    setEvening(next.evening_enabled)
    setLatText(next.weather_lat === null ? '' : String(next.weather_lat))
    setLonText(next.weather_lon === null ? '' : String(next.weather_lon))
    setChannelId(next.notify_channel_id ?? '')
    setChatId(next.notify_chat_id ?? '')
  }

  /** Returns whether the settings state was actually refreshed from the server. */
  const load = useCallback(async (): Promise<boolean> => {
    if (!supabase) { setLoading(false); return false }
    setLoading(true)
    setLoadError(false)
    try {
      // every wait is bounded: a hung query must not freeze loading (or the
      // save-reconciliation reload, which comes through here too)
      const [result, channelsResult, runsResult, outcomesResult] = await Promise.all([
        callBriefing({ action: 'settings-get' }),
        queryBounded((signal) => supabase!.from('channels').select('id, label, type').eq('type', 'telegram').abortSignal(signal)),
        queryBounded((signal) => supabase!.from('briefing_runs').select('kind, run_date, status').order('run_date', { ascending: false }).order('kind').limit(6).abortSignal(signal)),
        queryBounded((signal) => supabase!.from('briefing_outcomes').select('run_date, text').order('run_date', { ascending: false }).limit(3).abortSignal(signal)),
      ])
      if (result.payload?.error === 'owner_required') { setForbidden(true); return false }
      if (!result.ok || result.payload?.ok !== true) { setLoadError(true); return false }
      applySettings(result.payload.settings as BriefingSettings)
      setDelivery((result.payload.delivery ?? null) as DeliveryStatus | null)
      // auxiliary lists: a failed read HIDES the block (null) — it never renders as "no history"
      setHistory(!runsResult.timedOut && !runsResult.result.error ? ((runsResult.result.data ?? []) as RunRow[]) : null)
      setOutcomes(!outcomesResult.timedOut && !outcomesResult.result.error ? ((outcomesResult.result.data ?? []) as OutcomeRow[]) : null)
      // a failed or timed-out list is a failure — it must not read as "the account has no bots"
      if (channelsResult.timedOut || channelsResult.result.error) {
        setChannelsFailed(true)
        setChannels([])
      } else {
        setChannelsFailed(false)
        setChannels(((channelsResult.result.data ?? []) as Array<{ id: string; label?: string | null }>).map((row) => ({ id: row.id, label: row.label ?? null })))
      }
      return true
    } catch {
      setLoadError(true)
      return false
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const save = async () => {
    if (busyRef.current) return
    const hasLat = latText.trim() !== ''
    const hasLon = lonText.trim() !== ''
    const lat = hasLat ? Number(latText.trim()) : null
    const lon = hasLon ? Number(lonText.trim()) : null
    const binding = channelId !== ''
    const hasChat = chatId.trim() !== ''
    const localInvalid = hasLat !== hasLon
      || (hasLat && (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat!) > 90 || Math.abs(lon!) > 180))
      || ((morning || evening) && !binding)
      || (hasChat && (!binding || !/^-?\d{1,20}$/.test(chatId.trim())))
    if (localInvalid) { setMessage(t('settingsPage.briefingValidation')); return }
    busyRef.current = true
    setBusy(true)
    setMessage('')
    // every dispatched save bumps the server revision, which invalidates any outstanding link
    setVerifyInfo(null)
    try {
      const result = await callBriefing({
        action: 'settings-set',
        morning_enabled: morning,
        evening_enabled: evening,
        weather_lat: lat,
        weather_lon: lon,
        notify_channel_id: binding ? channelId : null,
        notify_chat_id: hasChat ? chatId.trim() : null,
      })
      if (result.ok && result.payload?.ok === true) {
        applySettings(result.payload.settings as BriefingSettings)
        setMessage(t('settingsPage.briefingSaved'))
      } else if (result.payload?.error === 'save_outcome_unknown' || !result.reached) {
        // the request may have landed — reconcile with the server, and only claim the state was
        // reloaded when the reload itself succeeded
        const reloaded = await load()
        setMessage(t(reloaded ? 'settingsPage.briefingSaveUnknownReloaded' : 'settingsPage.briefingSaveUnknownReloadFailed'))
      } else {
        setMessage(t('settingsPage.briefingSaveFailed'))
      }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const verifyRecipient = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setVerifyBusy(true)
    setMessage('')
    try {
      const result = await callBriefing({ action: 'verify-recipient' })
      if (result.ok && result.payload?.ok === true) {
        setVerifyInfo({ deepLink: result.payload.deep_link ?? null, payload: String(result.payload.start_payload ?? '') })
      } else {
        setMessage(t('settingsPage.briefingVerifyFailed'))
      }
    } finally {
      busyRef.current = false
      setVerifyBusy(false)
    }
  }

  const runPreview = async (kind: 'morning' | 'evening') => {
    if (busyRef.current) return
    busyRef.current = true
    setPreviewBusy(kind)
    setMessage('')
    try {
      const result = await callBriefing({ action: 'preview', kind, lang })
      if (result.ok && result.payload?.ok === true) setPreview(String(result.payload.text ?? ''))
      else setMessage(t('settingsPage.briefingPreviewFailed'))
    } finally {
      busyRef.current = false
      setPreviewBusy('')
    }
  }

  // server said owner_required: this account member has no business seeing the owner's
  // private recipient binding — render nothing at all
  if (forbidden) return null

  const recipientConfigured = settings?.recipient_status === 'configured'
  const recipientVerified = settings?.recipient_verified === true
  const STATUS_KEYS: Record<string, string> = {
    sent: 'settingsPage.briefingStatusSent', failed: 'settingsPage.briefingStatusFailed',
    unknown: 'settingsPage.briefingStatusUnknown', skipped: 'settingsPage.briefingStatusSkipped',
    prepared: 'settingsPage.briefingStatusPrepared', sending: 'settingsPage.briefingStatusSending',
  }
  const statusLabel = (status: string) => STATUS_KEYS[status] ? t(STATUS_KEYS[status]) : status
  // truthful delivery line built from the SAVED flags: nothing selected is "not selected", one
  // selected names only that one; "enabled" wording claims settings-level readiness, never
  // scheduler health (env alone is no evidence the cron is installed)
  const savedMorning = settings?.morning_enabled === true
  const savedEvening = settings?.evening_enabled === true
  const deliveryKey = delivery
    ? !delivery.enabled ? 'settingsPage.briefingDeliveryOff'
      : !savedMorning && !savedEvening ? 'settingsPage.briefingDeliveryNone'
      : !recipientVerified ? 'settingsPage.briefingDeliveryUnverified'
      : savedMorning && savedEvening ? 'settingsPage.briefingDeliveryActiveBoth'
      : savedMorning ? 'settingsPage.briefingDeliveryActiveMorning'
      : 'settingsPage.briefingDeliveryActiveEvening'
    : null

  return <section id="briefing-panel" className="card rounded-2xl p-5 sm:p-6">
    <div className="flex items-start gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent-cyan/15 to-accent-indigo/15 text-accent-cyan"><CalendarClock size={18} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-text">{t('settingsPage.briefingTitle')}</h2>
          {settings && <span className={cn('flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold', recipientVerified ? 'bg-teal/10 text-teal' : recipientConfigured ? 'bg-amber/10 text-amber' : 'bg-white/[0.06] text-muted')}>
            {recipientVerified ? <ShieldCheck size={11} /> : <ShieldAlert size={11} />}
            {t(recipientVerified ? 'settingsPage.briefingVerified' : recipientConfigured ? 'settingsPage.briefingRecipientConfigured' : 'settingsPage.briefingRecipientNone')}
          </span>}
        </div>
        <p className="mt-1 text-xs leading-5 text-muted">{t('settingsPage.briefingDesc')}</p>
        {settings && deliveryKey && <p className={cn('mt-1 text-xs font-semibold leading-5', deliveryKey.includes('Active') ? 'text-teal' : 'text-amber')}>{t(deliveryKey)}</p>}
      </div>
    </div>

    {!isSupabaseEnabled ? <p className="mt-5 text-xs text-muted">{t('settingsPage.briefingDemo')}</p>
      : loading ? <div className="mt-5 space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-9 animate-pulse rounded-xl bg-white/[0.05]" />)}</div>
      : loadError ? <div className="mt-5 flex items-center gap-3"><p className="text-xs text-muted">{t('settingsPage.briefingLoadFailed')}</p><Button variant="secondary" onClick={() => void load()} leftIcon={<RefreshCw size={13} />}>{t('settingsPage.briefingRetry')}</Button></div>
      : <div className="mt-5 space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {([['morning', morning, setMorning, t('settingsPage.briefingMorning')], ['evening', evening, setEvening, t('settingsPage.briefingEvening')]] as const).map(([key, value, setValue, label]) =>
            <label key={key} className={cn('flex cursor-pointer items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-sm font-semibold transition', value ? 'border-accent-cyan/40 bg-accent-cyan/10 text-text' : 'border-ice/10 text-muted hover:bg-white/5')}>
              {label}
              <input type="checkbox" checked={value} onChange={(event) => setValue(event.target.checked)} className="h-4 w-4 accent-[#8B7CF8]" />
            </label>)}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block"><span className={labelCls}>{t('settingsPage.briefingLat')}</span><input value={latText} onChange={(event) => setLatText(event.target.value)} inputMode="decimal" placeholder="41.311" className={inputCls} /></label>
          <label className="block"><span className={labelCls}>{t('settingsPage.briefingLon')}</span><input value={lonText} onChange={(event) => setLonText(event.target.value)} inputMode="decimal" placeholder="69.280" className={inputCls} /></label>
          <label className="block"><span className={labelCls}>{t('settingsPage.briefingChannel')}</span>
            <select value={channelId} onChange={(event) => setChannelId(event.target.value)} className={inputCls}>
              <option value="">{t('settingsPage.briefingChannelNone')}</option>
              {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.label || channel.id.slice(0, 8)}</option>)}
            </select>
            {channelsFailed && <span className="mt-1 block text-[11px] leading-4 text-amber">{t('settingsPage.briefingChannelsFailed')}</span>}
          </label>
          <label className="block"><span className={labelCls}>{t('settingsPage.briefingChat')}</span><input value={chatId} onChange={(event) => setChatId(event.target.value)} inputMode="numeric" placeholder={t('settingsPage.briefingChatHint')} className={inputCls} /></label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void save()} loading={busy}>{t('settingsPage.briefingSave')}</Button>
          {recipientConfigured && !recipientVerified
            && <Button variant="secondary" onClick={() => void verifyRecipient()} loading={verifyBusy} leftIcon={<ShieldCheck size={13} />}>{t('settingsPage.briefingVerify')}</Button>}
          <Button variant="secondary" onClick={() => void runPreview('morning')} loading={previewBusy === 'morning'} leftIcon={<Send size={13} />}>{t('settingsPage.briefingPreviewMorning')}</Button>
          <Button variant="secondary" onClick={() => void runPreview('evening')} loading={previewBusy === 'evening'} leftIcon={<Send size={13} />}>{t('settingsPage.briefingPreviewEvening')}</Button>
          {message && <p role="status" className="text-xs leading-5 text-muted">{message}</p>}
        </div>
        {verifyInfo && <div className="space-y-2 rounded-xl border border-ice/10 bg-black/20 p-4 text-xs leading-5 text-text">
          <p>{t('settingsPage.briefingVerifyIssued')}</p>
          {verifyInfo.deepLink && <a href={verifyInfo.deepLink} target="_blank" rel="noreferrer" className="block break-all text-accent-cyan underline">{verifyInfo.deepLink}</a>}
          <p className="text-muted">{t('settingsPage.briefingVerifyManual')}</p>
          <code className="block rounded-lg bg-black/30 px-2 py-1">/start {verifyInfo.payload}</code>
          <Button variant="secondary" onClick={() => void load()} leftIcon={<RefreshCw size={13} />}>{t('settingsPage.briefingCheckStatus')}</Button>
        </div>}
        {preview && <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl border border-ice/10 bg-black/20 p-4 text-xs leading-5 text-text">{preview}</pre>}
        {history !== null && <div>
          <h3 className={labelCls}>{t('settingsPage.briefingHistoryTitle')}</h3>
          {history.length === 0
            ? <p className="text-xs text-muted">{t('settingsPage.briefingNoHistory')}</p>
            : <ul className="space-y-1 text-xs leading-5 text-text">{history.map((run) => (
              <li key={`${run.run_date}-${run.kind}`} className="flex items-center gap-2">
                <span className="text-muted">{run.run_date}</span>
                <span>{run.kind === 'morning' ? '🌅' : '🌙'}</span>
                <span className={cn(run.status === 'sent' ? 'text-teal' : run.status === 'failed' || run.status === 'unknown' ? 'text-amber' : 'text-muted')}>{statusLabel(run.status)}</span>
              </li>))}</ul>}
        </div>}
        {outcomes !== null && <div>
          <h3 className={labelCls}>{t('settingsPage.briefingOutcomesTitle')}</h3>
          {outcomes.length === 0
            ? <p className="text-xs text-muted">{t('settingsPage.briefingNoOutcomes')}</p>
            : <ul className="space-y-1 text-xs leading-5 text-text">{outcomes.map((outcome) => (
              <li key={outcome.run_date}><span className="text-muted">{outcome.run_date}:</span> {outcome.text.slice(0, 160)}</li>))}</ul>}
        </div>}
      </div>}
  </section>
}
