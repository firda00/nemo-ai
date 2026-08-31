import { useEffect, useState } from 'react'
import { Loader2, Copy, Check, ExternalLink, ShieldCheck, KeyRound, Unplug, CheckCircle2, Mail, Table2, CalendarDays, FileText, HardDrive } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { Button } from '../ui/Button'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'

/**
 * Self-service Google connect. A business registers its OWN Google Cloud OAuth app once
 * (guided below), pastes Client ID + Secret (stored server-only), then authorizes its
 * Google account — after which agents can send Gmail, write Sheets and set Calendar events.
 * Falls back to the shared Nemo app when global GOOGLE_CLIENT_ID is configured server-side.
 */
export function GoogleSetup({ onConnected, simple = false }: { onConnected?: () => void; simple?: boolean }) {
  const { t } = useI18n()
  const [loading, setLoading] = useState(isSupabaseEnabled)
  const [redirect, setRedirect] = useState('')
  const [accountConfigured, setAccountConfigured] = useState(false)
  const [configured, setConfigured] = useState(false) // own app OR shared Nemo app available
  const [connected, setConnected] = useState(false)
  const [email, setEmail] = useState<string | null>(null)
  const [cid, setCid] = useState('')
  const [csec, setCsec] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const refresh = async () => {
    if (!supabase) return
    const [{ data: app }, { data: st }] = await Promise.all([
      supabase.functions.invoke('google-oauth', { body: { action: 'get_app' } }),
      supabase.functions.invoke('google-oauth', { body: { action: 'status' } }),
    ])
    const a = app as { redirect_uri?: string; account_configured?: boolean; configured?: boolean } | null
    const s = st as { connected?: boolean; email?: string } | null
    if (a) { setRedirect(a.redirect_uri ?? ''); setAccountConfigured(Boolean(a.account_configured)); setConfigured(Boolean(a.configured)) }
    if (s?.connected) { setConnected(true); setEmail(s.email ?? null); onConnected?.() }
  }

  useEffect(() => {
    if (!isSupabaseEnabled || !supabase) return
    ;(async () => { try { await refresh() } catch { /* ignore */ } setLoading(false) })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const copy = () => { navigator.clipboard?.writeText(redirect); setCopied(true); window.setTimeout(() => setCopied(false), 1600) }

  const saveApp = async () => {
    if (!supabase || busy) return
    setBusy(true); setMsg(null)
    try {
      const { data } = await supabase.functions.invoke('google-oauth', { body: { action: 'set_app', client_id: cid.trim(), client_secret: csec.trim() } })
      const p = data as { ok?: boolean; error?: string } | null
      if (!p?.ok) { setMsg({ ok: false, text: p?.error ?? t('googleSetup.saveFailed') }); return }
      setAccountConfigured(true); setConfigured(true); setCsec('')
      setMsg({ ok: true, text: t('googleSetup.appSaved') })
    } catch { setMsg({ ok: false, text: t('googleSetup.saveError') }) } finally { setBusy(false) }
  }

  const authorize = async () => {
    if (!supabase || busy) return
    setBusy(true); setMsg(null)
    try {
      const { data, error } = await supabase.functions.invoke('google-oauth', { body: { action: 'authorize' } })
      const p = data as { ok?: boolean; url?: string; message?: string } | null
      if (!error && p?.url) { window.location.href = p.url; return }
      setMsg({ ok: false, text: p?.message ?? t('googleSetup.notConfigured') })
    } catch { setMsg({ ok: false, text: t('googleSetup.authError') }) } finally { setBusy(false) }
  }

  const changeApp = async () => {
    if (!supabase || busy) return
    setBusy(true); setMsg(null)
    try { await supabase.functions.invoke('google-oauth', { body: { action: 'clear_app' } }); setAccountConfigured(false); await refresh() }
    catch { /* ignore */ } finally { setBusy(false) }
  }

  const disconnect = async () => {
    if (!supabase || busy) return
    setBusy(true); setMsg(null)
    try { await supabase.functions.invoke('google-oauth', { body: { action: 'disconnect' } }); setConnected(false); setEmail(null); setMsg({ ok: true, text: t('googleSetup.disconnected') }) }
    catch { /* ignore */ } finally { setBusy(false) }
  }

  if (loading) return <div className="flex items-center gap-2 py-4 text-sm text-muted"><Loader2 size={15} className="animate-spin" /> …</div>

  // CONNECTED — show the linked account + what agents can now do
  if (connected) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-teal/20 bg-teal/[0.06] px-3 py-2.5">
          <CheckCircle2 size={16} className="text-teal" />
          <span className="text-sm text-text">{t('googleSetup.connected')}{email ? ` · ${email}` : ''}</span>
          <Button size="sm" variant="ghost" onClick={disconnect} disabled={busy} className="ml-auto">{busy ? <Loader2 size={14} className="animate-spin" /> : <Unplug size={14} />} {t('googleSetup.disconnectBtn')}</Button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <Cap icon={Mail} text={t('googleSetup.capGmail')} />
          <Cap icon={Table2} text={t('googleSetup.capSheets')} />
          <Cap icon={CalendarDays} text={t('googleSetup.capCalendar')} />
          <Cap icon={FileText} text="Google Docs" />
          <Cap icon={HardDrive} text="Google Drive" />
        </div>
        {msg && <Note msg={msg} />}
      </div>
    )
  }

  if (simple) {
    return (
      <div className="space-y-4">
        <div className="flex flex-col gap-3 rounded-2xl border border-ice/[0.08] bg-black/10 p-4 sm:flex-row sm:items-center">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white text-xl font-bold text-[#4285f4] shadow-sm">G</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-text">Google Workspace</p>
            <p className="mt-1 text-xs leading-5 text-muted">Gmail, Sheets, Drive и Docs — безопасная авторизация через Google OAuth 2.0.</p>
          </div>
          <Button onClick={authorize} disabled={busy || !isSupabaseEnabled} className="shrink-0">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <ExternalLink size={15} />} Connect Google Workspace
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Cap icon={Table2} text="Sheets" />
          <Cap icon={HardDrive} text="Drive" />
          <Cap icon={FileText} text="Docs" />
          <Cap icon={Mail} text="Gmail" />
        </div>
        {msg && <Note msg={msg} />}
        <p className="flex items-center gap-1.5 text-[11px] text-fog"><ShieldCheck size={13} className="text-teal" /> OAuth-токен шифруется на сервере и не показывается в браузере.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-muted">
        {t('googleSetup.introPre')}<span className="text-text">{t('googleSetup.introH1')}</span>{t('googleSetup.introMid1')}<span className="text-text">{t('googleSetup.introH2')}</span>{t('googleSetup.introMid2')}<span className="text-text">{t('googleSetup.introH3')}</span>{t('googleSetup.introSuffix')}
      </p>

      {/* GUIDE — create the Google app once */}
      {!configured && (
        <div className="rounded-xl border border-ice/[0.08] bg-black/20 p-4">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-text">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-violet/15 text-[11px] text-violet">1</span>
            {t('googleSetup.step1Title')}
          </p>
          <ol className="mt-3 space-y-2 text-[12.5px] leading-relaxed text-muted">
            <li>• {t('googleSetup.step1Open')}<a href="https://console.cloud.google.com/" target="_blank" rel="noopener noreferrer" className="text-violet hover:underline">console.cloud.google.com <ExternalLink size={11} className="inline" /></a>{t('googleSetup.step1CreateProject')}</li>
            <li>• <span className="text-text">Enable APIs</span>{t('googleSetup.step1Enable')}<span className="text-text">Gmail API</span>, <span className="text-text">Google Sheets API</span>, <span className="text-text">Google Calendar API</span>.</li>
            <li>• <span className="text-text">OAuth consent screen</span>{t('googleSetup.step1Type')}<span className="text-text">External</span>{t('googleSetup.step1AddEmailPre')}<span className="text-text">Test users</span>{t('googleSetup.step1TestUsersSuffix')}</li>
            <li>• <span className="text-text">Credentials → Create → OAuth client ID</span>{t('googleSetup.step1Type')}<span className="text-text">Web application</span>.</li>
            <li>• В поле <span className="text-text">Authorized redirect URIs</span> вставьте этот адрес:</li>
          </ol>
          <div className="mt-2 flex items-stretch gap-2">
            <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-lg border border-ice/10 bg-black/40 px-3 py-2 text-[11.5px] text-cyan">{redirect || '…'}</code>
            <button onClick={copy} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ice/12 px-2.5 text-xs font-medium text-text hover:bg-white/5">
              {copied ? <Check size={14} className="text-teal" /> : <Copy size={14} />} {copied ? t('googleSetup.copied') : t('googleSetup.copyBtn')}
            </button>
          </div>

          <p className="mt-4 flex items-center gap-2 text-[13px] font-semibold text-text">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-violet/15 text-[11px] text-violet">2</span>
            {t('googleSetup.step2Title')}
          </p>
          <div className="mt-3 space-y-2">
            <input value={cid} onChange={(e) => setCid(e.target.value)} placeholder="1234...apps.googleusercontent.com"
              className="w-full rounded-xl border border-ice/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
            <input value={csec} onChange={(e) => setCsec(e.target.value)} type="password" placeholder="Client Secret (GOCSPX-…)"
              className="w-full rounded-xl border border-ice/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
            <Button onClick={saveApp} disabled={busy || cid.trim().length < 12 || csec.trim().length < 6} className="w-full">
              {busy ? <><Loader2 size={15} className="animate-spin" /> …</> : <><KeyRound size={15} /> {t('googleSetup.saveAppBtn')}</>}
            </Button>
          </div>
        </div>
      )}

      {/* AUTHORIZE — app is configured (own or shared) */}
      {(accountConfigured || configured) && (
        <div className="rounded-xl border border-teal/15 bg-teal/[0.04] p-4">
          <p className="text-[13px] text-text">{accountConfigured ? t('googleSetup.appConnected') : t('googleSetup.readyToConnect')} {t('googleSetup.authorizeHint')}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button onClick={authorize} disabled={busy}>{busy ? <Loader2 size={15} className="animate-spin" /> : <ExternalLink size={15} />} {t('googleSetup.connectBtn')}</Button>
            {accountConfigured && <button onClick={changeApp} disabled={busy} className="text-xs text-muted underline-offset-2 hover:text-text hover:underline">{t('googleSetup.changeApp')}</button>}
          </div>
        </div>
      )}

      {msg && <Note msg={msg} />}

      <p className="flex items-center gap-1.5 text-[11px] text-fog"><ShieldCheck size={13} className="text-teal" /> {t('googleSetup.securityNote')}</p>
    </div>
  )
}

function Cap({ icon: Icon, text }: { icon: typeof Mail; text: string }) {
  return <div className="flex items-center gap-2 rounded-xl border border-ice/[0.07] bg-white/[0.02] px-3 py-2 text-[12px] text-muted"><Icon size={14} className="shrink-0 text-cyan" /> {text}</div>
}
function Note({ msg }: { msg: { ok: boolean; text: string } }) {
  return <p className={cn('rounded-lg px-3 py-2 text-xs', msg.ok ? 'bg-teal/10 text-teal' : 'bg-danger/10 text-danger')}>{msg.text}</p>
}
