import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useI18n } from '../../i18n'
import { trialBookingCopy, trialStatusCopy } from '../../i18n/trialBooking'
import { supabase } from '../../lib/supabase'
import { createTrialBookingClient, createTrialSessionTokenProvider, isLocalTrialUrl, type TrialOperation, type TrialSlot } from '../../lib/trialBookingClient'

type Saved = { key?: string; slotId?: string; operationId?: string }
type Connection = { client: ReturnType<typeof createTrialBookingClient>; storageKey: string; owner: boolean; signal: AbortSignal }

// Embedded in the existing conversation, deliberately local-only until real acceptance.
export function TrialBookingChatCard({ operationOnly = false }: { operationOnly?: boolean }) {
  const { user } = useAuth()
  const { lang } = useI18n()
  const copy = trialBookingCopy[lang]
  const statusLabel = (status: string) => trialStatusCopy[lang][status as keyof typeof trialStatusCopy['en']] ?? trialStatusCopy[lang].unknown
  const [slots, setSlots] = useState<TrialSlot[]>([])
  const [operation, setOperation] = useState<TrialOperation | null>(null)
  const [recent, setRecent] = useState<TrialOperation[]>([])
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [authRequired, setAuthRequired] = useState(false)
  const [owner, setOwner] = useState(false)
  const [connectedUserId, setConnectedUserId] = useState<string | null>(null)
  const [savedView, setSavedView] = useState<Saved>({})
  const connection = useRef<Connection | null>(null)
  const saved = useRef<Saved>({})
  const lifetime = useRef<AbortController | null>(null)
  const inFlight = useRef(false)

  const refresh = async (current: Connection) => {
    const schedule = await current.client.schedule()
    const value = saved.current.operationId
      ? await current.client.result(saved.current.operationId)
      : saved.current.key ? await current.client.recover(saved.current.key) : null
    const requests = await current.client.recent()
    if (current.signal.aborted || connection.current !== current) return
    // This is the only place that publishes a confirmed booking: authoritative readback.
    setSlots(schedule); setOperation(value); setRecent(requests)
  }

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    connection.current = null; saved.current = {}; inFlight.current = false
    const subscription = supabase?.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== user?.id) { controller.abort(); setAuthRequired(true) }
    }).data.subscription
    void (async () => {
      await Promise.resolve()
      if (controller.signal.aborted) return
      setOperation(null); setRecent([]); setSlots([]); setOwner(false); setError(false); setAuthRequired(false); setSavedView({})
      setBusy(true)
      try {
        const session = (await supabase?.auth.getSession())?.data.session
        if (!session || !supabase) throw new Error('TRIAL_AUTH_REQUIRED')
        if (session.user.id !== user?.id || controller.signal.aborted) throw new Error('TRIAL_SESSION_CHANGED')
        const url = String(import.meta.env.VITE_SUPABASE_URL)
        if (!isLocalTrialUrl(url)) throw new Error('local_only')
        const apiKey = String(import.meta.env.VITE_SUPABASE_ANON_KEY)
        // Refresh credentials per call while keeping the original identity pinned.
        const getAccessToken = createTrialSessionTokenProvider(supabase.auth, session.user.id, controller.signal)
        const token = await getAccessToken()
        const response = await fetch(`${url}/rest/v1/users?select=account_id,role&id=eq.${session.user.id}`, {
          signal: controller.signal, redirect: 'error', headers: { apikey: apiKey, Authorization: `Bearer ${token}` },
        })
        if (response.status === 401) throw new Error('TRIAL_AUTH_REQUIRED')
        if (!response.ok) throw new Error('profile')
        const profiles = await response.json() as { account_id: string; role: string }[]
        if (profiles.length !== 1) throw new Error('profile')
        const profile = profiles[0]
        const current = {
          client: createTrialBookingClient({ url, apiKey, getAccessToken, accountId: profile.account_id, signal: controller.signal }),
          storageKey: `nemo:trial:v1:${url}:${profile.account_id}:${session.user.id}`,
          owner: profile.role === 'owner',
          signal: controller.signal,
        }
        if (controller.signal.aborted) return
        saved.current = JSON.parse(localStorage.getItem(current.storageKey) ?? '{}') as Saved
        setSavedView(saved.current)
        connection.current = current
        setConnectedUserId(session.user.id)
        setOwner(current.owner)
        await refresh(current)
      } catch (cause) { if (!controller.signal.aborted) { setError(true); if (cause instanceof Error && ['TRIAL_AUTH_REQUIRED', 'TRIAL_SESSION_CHANGED'].includes(cause.message)) setAuthRequired(true) } }
      finally { if (!controller.signal.aborted) setBusy(false) }
    })()
    return () => { controller.abort(); subscription?.unsubscribe(); connection.current = null }
  }, [user?.id])

  const act = async (action: 'refresh' | 'request' | 'approve' | 'reject' | 'execute' | 'new', chosen?: TrialOperation) => {
    const current = connection.current
    if (!current || inFlight.current || lifetime.current?.signal.aborted) return
    inFlight.current = true; setBusy(true); setError(false)
    const persist = (value: Saved) => {
      // Persist BEFORE a mutation. If storage fails, no request is sent.
      if (current.signal.aborted || connection.current !== current) throw new Error('scope')
      localStorage.setItem(current.storageKey, JSON.stringify(value)); saved.current = value; setSavedView(value)
    }
    try {
      if (chosen) persist({ operationId: chosen.operation_id })
      if (action === 'new') { persist({}); setOperation(null); setSelected('') }
      if (action === 'request') {
        if (!saved.current.key) persist({ key: crypto.randomUUID(), slotId: selected })
        // A lost response retries the original key and original slot, never a new operation.
        const result = await current.client.request(saved.current.slotId!, saved.current.key!, 'Synthetic attendee')
        persist({ ...saved.current, operationId: result.operation_id })
      }
      const id = saved.current.operationId ?? operation?.operation_id
      if ((action === 'approve' || action === 'reject') && id) await current.client.decide(id, action)
      if ((action === 'approve' || action === 'execute') && id) await current.client.execute(id)
      await refresh(current)
    } catch (cause) { if (!current.signal.aborted && connection.current === current) { setError(true); if (cause instanceof Error && ['TRIAL_AUTH_REQUIRED', 'TRIAL_SESSION_CHANGED'].includes(cause.message)) setAuthRequired(true) } }
    finally { if (!current.signal.aborted && connection.current === current) { inFlight.current = false; setBusy(false) } }
  }

  const buttonClass = 'rounded-lg border border-ice/15 px-3 py-2 text-sm disabled:opacity-40'
  const confirmed = operation?.status === 'completed' && operation.booking_id
  // Keep persisted operation identity intact; signing in never starts a replacement mutation.
  if (authRequired) return <p role="alert"><a href="/auth">{lang === 'ru' ? 'Войдите снова, чтобы продолжить сохранённую запись' : lang === 'uz' ? 'Saqlangan yozuvni davom ettirish uchun qayta kiring' : 'Sign in again to continue the saved booking'}</a></p>
  if (connectedUserId !== user?.id) return <p role="status">{error ? copy.failed : copy.load}</p>
  return <section aria-label={copy.title} className="space-y-3 rounded-xl border border-ice/15 p-4">
    <h3 className="font-semibold">{copy.title}</h3><p className="text-xs text-muted">{copy.local}</p>
    <button className={buttonClass} disabled={busy} onClick={() => void act('refresh')}>{copy.load}</button>
    {error && <p role="alert">{copy.failed}</p>}
    {!operation && !operationOnly && <>
      <select aria-label={copy.choose} className="w-full rounded-lg border p-2" value={savedView.slotId ?? selected} disabled={busy || !!savedView.key} onChange={e => setSelected(e.target.value)}>
        <option value="">{copy.choose}</option>
        {slots.filter(slot => slot.available > 0 && slot.status !== 'cancelled').map(slot => <option key={slot.id} value={slot.id}>{slot.course_name} · {new Date(slot.starts_at).toLocaleString(lang, { timeZone: slot.timezone })} · {copy.seats}: {slot.available}</option>)}
      </select>
      {!error && !busy && !slots.length && <p>{copy.noSlots}</p>}
      <button className={buttonClass} disabled={busy || (!selected && !savedView.slotId)} onClick={() => void act('request')}>{copy.request}</button>
    </>}
    {operation && <div aria-live="polite" className="space-y-2">
      <p>{copy.operation}: {operation.operation_id}</p>
      <p role="status" data-testid="trial-operation-status" data-status={operation.status}>{copy.status}: {statusLabel(operation.status)}</p>
      <p>{String(operation.payload.course_name ?? '')} · {String(operation.payload.attendee_label ?? '')}</p>
      <p>{operation.payload.starts_at ? new Date(String(operation.payload.starts_at)).toLocaleString(lang, { timeZone: 'Asia/Tashkent' }) : ''} · Asia/Tashkent</p>
      {confirmed && <p>{copy.confirmed} <strong>{operation.booking_id}</strong></p>}
      {operation.status === 'waiting_for_approval' && <><p>{copy.pending}</p>{owner && <><button className={buttonClass} disabled={busy} onClick={() => void act('approve')}>{copy.approve}</button><button className={buttonClass} disabled={busy} onClick={() => void act('reject')}>{copy.reject}</button></>}</>}
      {operation.status === 'waiting_for_action' && <button className={buttonClass} disabled={busy} onClick={() => void act('execute')}>{copy.resume}</button>}
      {!operationOnly && ['completed', 'denied', 'failed', 'expired'].includes(operation.status) && <button className={buttonClass} disabled={busy} onClick={() => void act('new')}>{copy.newRequest}</button>}
    </div>}
    {recent.length > 0 && <ul className="space-y-1">{recent.map(item => <li key={item.operation_id}><button className={buttonClass} disabled={busy} onClick={() => void act('refresh', item)}>{copy.operation}: {item.operation_id} · {statusLabel(item.status)}</button></li>)}</ul>}
  </section>
}
