import { useCallback, useEffect, useState } from 'react'
import { Send, Loader2, CalendarClock, Trash2, CheckCircle2, XCircle, Clock, Info, Camera, Share2, KeyRound, Unplug, ExternalLink, Hash, MessageCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { Button } from '../../components/ui/Button'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'
import { FanoutComposer } from '../../components/platform/FanoutComposer'
import { ContentSalesNav } from '../../components/platform/ContentSalesNav'

/** Autoposting to Telegram / Facebook / Instagram (Meta) / Twitter-X / Reddit. Telegram via a bot;
 *  FB/IG via the customer's Meta connection; X + Reddit via their own API keys. A cron publishes. */
interface Bot { id: string; label: string | null; username: string | null }
interface Post { id: string; target_chat: string; content: string; scheduled_at: string; status: string; error?: string | null; platform?: string }
type Platform = 'telegram' | 'facebook' | 'instagram' | 'twitter' | 'reddit'

const PLATFORMS: { id: Platform; label: string; icon: typeof Send }[] = [
  { id: 'telegram', label: 'Telegram', icon: Send },
  { id: 'facebook', label: 'Facebook', icon: Share2 },
  { id: 'instagram', label: 'Instagram', icon: Camera },
  { id: 'twitter', label: 'X (Twitter)', icon: Hash },
  { id: 'reddit', label: 'Reddit', icon: MessageCircle },
]
const statusMeta: Record<string, { icon: typeof Clock; cls: string; label: string }> = {
  scheduled: { icon: Clock, cls: 'text-amber', label: 'autopostPage.statusScheduled' },
  posted: { icon: CheckCircle2, cls: 'text-teal', label: 'autopostPage.statusPosted' },
  failed: { icon: XCircle, cls: 'text-danger', label: 'autopostPage.statusFailed' },
  canceled: { icon: XCircle, cls: 'text-fog', label: 'autopostPage.statusCanceled' },
}
const inputCls = 'w-full rounded-xl border border-ice/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50'

function ConnectedChip({ t, label, onDisc }: { t: (k: string, v?: Record<string, string | number>) => string; label?: string; onDisc: () => void }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <span className="inline-flex items-center gap-2 rounded-xl border border-teal/20 bg-teal/[0.06] px-3 py-1.5 text-xs text-text"><CheckCircle2 size={14} className="text-teal" /> {t('autopostPage.connected')}{label ? ` · ${label}` : ''}</span>
      <Button size="sm" variant="ghost" onClick={onDisc}><Unplug size={13} /> {t('autopostPage.disconnect')}</Button>
    </div>
  )
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function AutopostPage() {
  const { t, lang } = useI18n()
  const [platform, setPlatform] = useState<Platform>('telegram')
  const [bots, setBots] = useState<Bot[]>([])
  const [botId, setBotId] = useState('')
  const [target, setTarget] = useState('')
  const [content, setContent] = useState('')
  const [mediaUrl, setMediaUrl] = useState('')
  const [when, setWhen] = useState('')
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(isSupabaseEnabled)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  // connection state per platform
  const [social, setSocial] = useState<{ meta: { connected: boolean; label?: string; page_id?: string | null; ig_user_id?: string | null }; twitter: { connected: boolean; label?: string }; reddit: { connected: boolean; label?: string; subreddit?: string } }>({ meta: { connected: false }, twitter: { connected: false }, reddit: { connected: false } })
  const [loadError, setLoadError] = useState('')
  const [cBusy, setCBusy] = useState(false); const [cMsg, setCMsg] = useState<{ ok: boolean; text: string } | null>(null)
  // meta form
  const [mToken, setMToken] = useState(''); const [mPage, setMPage] = useState(''); const [mIg, setMIg] = useState('')
  // twitter form
  const [tw, setTw] = useState({ api_key: '', api_secret: '', access_token: '', access_secret: '' })
  // reddit form
  const [rd, setRd] = useState({ client_id: '', client_secret: '', username: '', password: '', subreddit: '' })

  const loadPosts = useCallback(async () => {
    if (!supabase) return
    const { data, error } = await supabase.functions.invoke('autopost', { body: { action: 'list' } })
    const p = data as { ok?: boolean; posts?: Post[]; error?: string } | null
    if (error || !p?.ok) { setLoadError(p?.error ?? error?.message ?? t('autopostPage.genericError')); return }
    setPosts(p.posts ?? []); setLoadError('')
  }, [t])
  const loadSocial = useCallback(async () => {
    if (!supabase) return
    const { data, error } = await supabase.functions.invoke('connect-social', { body: { action: 'status' } })
    const p = data as any
    if (error || !p?.ok) { setLoadError(p?.error ?? error?.message ?? t('autopostPage.genericError')); return }
    if (p) setSocial({ meta: p.meta ?? { connected: Boolean(p.connected), label: p.label }, twitter: p.twitter ?? { connected: false }, reddit: p.reddit ?? { connected: false } })
  }, [t])
  useEffect(() => {
    if (!isSupabaseEnabled || !supabase) return
    ;(async () => {
      try {
        const { data: chs } = await supabase!.from('channels').select('id, type').eq('type', 'telegram')
        const list = (chs ?? []).map((c: any, i: number) => ({ id: c.id, label: t('autopostPage.botLabel', { n: i + 1 }), username: null }))
        setBots(list); if (list[0]) setBotId(list[0].id)
        await Promise.all([loadPosts(), loadSocial()])
      } catch { /* ignore */ }
      setLoading(false)
    })()
  }, [loadPosts, loadSocial, t])

  const connect = async (payload: any, okText: string) => {
    if (!supabase || cBusy) return
    setCBusy(true); setCMsg(null)
    try {
      const { data } = await supabase.functions.invoke('connect-social', { body: { action: 'connect', ...payload } })
      const p = data as any
      if (!p?.ok) { setCMsg({ ok: false, text: p?.error ?? t('autopostPage.genericError') }); return }
      setCMsg({ ok: true, text: okText }); await loadSocial()
    } catch { setCMsg({ ok: false, text: t('autopostPage.genericError') }) } finally { setCBusy(false) }
  }
  const disconnect = async (p: Platform) => {
    if (!supabase) return
    const key = p === 'facebook' || p === 'instagram' ? 'meta' : p
    const { data, error } = await supabase.functions.invoke('connect-social', { body: { action: 'disconnect', platform: key } })
    if (error || !(data as { ok?: boolean } | null)?.ok) setCMsg({ ok: false, text: error?.message ?? t('autopostPage.genericError') })
    else await loadSocial()
  }

  const postPayload = (action: 'schedule' | 'send_now') => {
    const payload: any = { action, platform, content: content.trim() }
    if (action === 'schedule') payload.scheduled_at = when ? new Date(when).toISOString() : ''
    if (platform === 'telegram') { payload.channel_id = botId || null; payload.target_chat = target.trim() }
    if (platform === 'reddit' && target.trim()) payload.target_chat = target.trim()
    if (mediaUrl.trim() && (platform === 'facebook' || platform === 'instagram')) payload.media_url = mediaUrl.trim()
    return payload
  }

  const schedule = async () => {
    if (!supabase || busy) return
    setBusy(true); setMsg(null)
    try {
      const { data, error } = await supabase.functions.invoke('autopost', { body: postPayload('schedule') })
      const p = data as { ok?: boolean; error?: string } | null
      if (error || !p?.ok) { setMsg({ ok: false, text: p?.error ?? error?.message ?? t('autopostPage.scheduleFailed') }); return }
      setMsg({ ok: true, text: t('autopostPage.postScheduled') }); setContent(''); setMediaUrl(''); setWhen('')
      await loadPosts()
    } catch { setMsg({ ok: false, text: t('autopostPage.genericError') }) } finally { setBusy(false) }
  }
  const sendNow = async () => {
    if (!supabase || busy) return
    setBusy(true); setMsg(null)
    try {
      const { data, error } = await supabase.functions.invoke('autopost', { body: postPayload('send_now') })
      const p = data as { ok?: boolean; error?: string } | null
      if (error || !p?.ok) { setMsg({ ok: false, text: p?.error ?? error?.message ?? t('autopostPage.genericError') }); return }
      setMsg({ ok: true, text: 'Публикация отправлена.' }); setContent(''); setMediaUrl(''); await loadPosts()
    } catch { setMsg({ ok: false, text: t('autopostPage.genericError') }) } finally { setBusy(false) }
  }
  const cancel = async (id: string) => {
    if (!supabase) return
    const { data, error } = await supabase.functions.invoke('autopost', { body: { action: 'cancel', id } })
    if (error || !(data as { ok?: boolean } | null)?.ok) setLoadError((data as { error?: string } | null)?.error ?? error?.message ?? t('autopostPage.genericError'))
    await loadPosts()
  }
  const fmt = (iso: string) => { try { return new Date(iso).toLocaleString(lang === 'ru' ? 'ru-RU' : lang === 'uz' ? 'uz-UZ' : 'en-US', { dateStyle: 'short', timeStyle: 'short' }) } catch { return iso } }

  const isMeta = platform === 'facebook' || platform === 'instagram'
  const ready = platform === 'telegram' ? target.trim().length > 0 && Boolean(botId)
    : platform === 'facebook' ? social.meta.connected && Boolean(social.meta.page_id)
      : platform === 'instagram' ? social.meta.connected && Boolean(social.meta.ig_user_id)
      : platform === 'twitter' ? social.twitter.connected
        : platform === 'reddit' ? social.reddit.connected : false
  const contentValid = content.trim().length >= 2 && (platform !== 'twitter' || content.length <= 280)
  const mediaValid = platform !== 'instagram' || mediaUrl.trim().length > 0
  const canSend = contentValid && ready && mediaValid
  const canSchedule = canSend && Boolean(when)
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const guide = lang === 'ru'
    ? ['1. Подключите канал', '2. Подготовьте и проверьте пост', '3. Отправьте сейчас или выберите время']
    : lang === 'uz'
      ? ['1. Kanalni ulang', '2. Postni tayyorlang va tekshiring', '3. Hozir yuboring yoki vaqtni tanlang']
      : ['1. Connect a channel', '2. Prepare and review the post', '3. Send now or choose a time']

  return (
    <div className="container-page max-w-4xl py-8">
      <ContentSalesNav active="autopost" />
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-violet/15 text-violet"><Send size={20} /></span>
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-text">{t('autopostPage.title')}</h1>
          <p className="text-sm text-muted">{t('autopostPage.subtitle')}</p>
        </div>
      </div>

      <div className="mt-5 grid gap-2 sm:grid-cols-3">
        {guide.map((step, i) => <div key={step} className={cn('rounded-xl border px-3 py-2 text-xs', i === 0 && ready ? 'border-teal/25 bg-teal/[0.06] text-teal' : 'border-ice/10 bg-white/[0.02] text-muted')}>{step}</div>)}
      </div>
      {loadError && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger">
          <span>{loadError}</span>
          <button onClick={() => void Promise.all([loadPosts(), loadSocial()])} className="rounded-lg border border-danger/20 px-2 py-1">Retry</button>
        </div>
      )}

      <div className="mt-5"><FanoutComposer onQueued={loadPosts} /></div>

      {/* single-platform composer below */}
      <div className="mt-6 flex flex-wrap gap-2">
        {PLATFORMS.map((p) => (
          <button key={p.id} onClick={() => { setPlatform(p.id); setCMsg(null) }} className={cn('inline-flex items-center gap-1.5 rounded-pill border px-3.5 py-1.5 text-xs font-medium transition', platform === p.id ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:border-ice/25')}>
            <p.icon size={14} /> {p.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="card mt-4 flex items-center gap-2 rounded-3xl p-6 text-sm text-muted"><Loader2 size={15} className="animate-spin" /> {t('common.loading')}</div>
      ) : (
        <>
          {/* per-platform connect / hint */}
          {platform === 'telegram' && (
            <div className="card mt-4 flex items-start gap-2 rounded-2xl border border-cyan/15 bg-cyan/[0.04] p-4 text-[12.5px] leading-relaxed text-muted">
              <Info size={15} className="mt-0.5 shrink-0 text-cyan" />
              <span>{t('autopostPage.tgHint1')}<b className="text-text">{t('autopostPage.tgHintAdmin')}</b>{t('autopostPage.tgHint2')}<b className="text-text">{t('autopostPage.tgHintUsername')}</b>{t('autopostPage.tgHint3')}<Link to="/app/teams" className="text-violet hover:underline">{t('autopostPage.tgHintTeams')}</Link>{t('autopostPage.tgHint4')}</span>
            </div>
          )}

          {isMeta && (
            <div className="card mt-4 rounded-3xl p-5">
              <p className="flex items-center gap-2 text-sm font-bold text-text">{platform === 'instagram' ? <Camera size={16} className="text-violet" /> : <Share2 size={16} className="text-violet" />} {t('autopostPage.metaConnectTitle')}</p>
              {social.meta.connected ? <ConnectedChip t={t} label={social.meta.label} onDisc={() => disconnect('facebook')} /> : (
                <>
                  <ol className="mt-3 space-y-1 text-[12px] text-muted">
                    <li><span className="text-violet">1.</span> {t('autopostPage.metaStep1a')}<a href="https://developers.facebook.com/apps" target="_blank" rel="noopener noreferrer" className="text-violet hover:underline">developers.facebook.com <ExternalLink size={11} className="inline" /></a>{t('autopostPage.metaStep1b')}</li>
                    <li><span className="text-violet">2.</span> {t('autopostPage.metaStep2a')}<b className="text-text">Instagram Business</b>{t('autopostPage.metaStep2b')}</li>
                    <li><span className="text-violet">3.</span> {t('autopostPage.metaStep3a')}<b className="text-text">Page Access Token</b>{t('autopostPage.metaStep3b')}<b className="text-text">Page ID</b>{t('autopostPage.metaStep3c')}<b className="text-text">IG User ID</b>{t('autopostPage.metaStep3d')}</li>
                  </ol>
                  <div className="mt-3 space-y-2">
                    <input value={mToken} onChange={(e) => setMToken(e.target.value)} type="password" placeholder="Page Access Token (EAAB…)" className={inputCls} />
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input value={mPage} onChange={(e) => setMPage(e.target.value)} placeholder="Page ID" className={inputCls} />
                      <input value={mIg} onChange={(e) => setMIg(e.target.value)} placeholder={t('autopostPage.igUserIdPh')} className={inputCls} />
                    </div>
                    <Button size="sm" onClick={() => connect({ platform: 'meta', access_token: mToken.trim(), page_id: mPage.trim(), ig_user_id: mIg.trim() }, t('autopostPage.metaConnected'))} disabled={cBusy || mToken.trim().length < 20 || !mPage.trim()}>{cBusy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} {t('autopostPage.connectMeta')}</Button>
                  </div>
                </>
              )}
              {cMsg && <p className={cn('mt-2 rounded-lg px-3 py-1.5 text-xs', cMsg.ok ? 'bg-teal/10 text-teal' : 'bg-danger/10 text-danger')}>{cMsg.text}</p>}
            </div>
          )}

          {platform === 'twitter' && (
            <div className="card mt-4 rounded-3xl p-5">
              <p className="flex items-center gap-2 text-sm font-bold text-text"><Hash size={16} className="text-violet" /> Подключение X (Twitter)</p>
              <p className="mt-1 text-[11px] text-amber">⚠️ Постинг в X требует платного плана X API (Basic ~$100/мес).</p>
              {social.twitter.connected ? <ConnectedChip t={t} label={social.twitter.label} onDisc={() => disconnect('twitter')} /> : (
                <>
                  <ol className="mt-3 space-y-1 text-[12px] text-muted">
                    <li><span className="text-violet">1.</span> Создайте приложение на <a href="https://developer.x.com/en/portal/dashboard" target="_blank" rel="noopener noreferrer" className="text-violet hover:underline">developer.x.com <ExternalLink size={11} className="inline" /></a> (с правами <b className="text-text">Read and Write</b>).</li>
                    <li><span className="text-violet">2.</span> В «Keys and tokens» возьмите 4 значения: <b className="text-text">API Key, API Secret, Access Token, Access Token Secret</b>.</li>
                  </ol>
                  <div className="mt-3 space-y-2">
                    <input value={tw.api_key} onChange={(e) => setTw({ ...tw, api_key: e.target.value })} placeholder="API Key" className={inputCls} />
                    <input value={tw.api_secret} onChange={(e) => setTw({ ...tw, api_secret: e.target.value })} type="password" placeholder="API Secret" className={inputCls} />
                    <input value={tw.access_token} onChange={(e) => setTw({ ...tw, access_token: e.target.value })} placeholder="Access Token" className={inputCls} />
                    <input value={tw.access_secret} onChange={(e) => setTw({ ...tw, access_secret: e.target.value })} type="password" placeholder="Access Token Secret" className={inputCls} />
                    <Button size="sm" onClick={() => connect({ platform: 'twitter', ...tw }, 'X подключён.')} disabled={cBusy || Object.values(tw).some((v) => v.trim().length < 10)}>{cBusy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} Подключить X</Button>
                  </div>
                </>
              )}
              {cMsg && <p className={cn('mt-2 rounded-lg px-3 py-1.5 text-xs', cMsg.ok ? 'bg-teal/10 text-teal' : 'bg-danger/10 text-danger')}>{cMsg.text}</p>}
            </div>
          )}

          {platform === 'reddit' && (
            <div className="card mt-4 rounded-3xl p-5">
              <p className="flex items-center gap-2 text-sm font-bold text-text"><MessageCircle size={16} className="text-violet" /> Подключение Reddit</p>
              <p className="mt-1 text-[11px] text-amber">⚠️ Reddit не любит автопостинг — соблюдайте правила сабреддитов, иначе риск бана.</p>
              {social.reddit.connected ? <ConnectedChip t={t} label={social.reddit.label ? `u/${social.reddit.label}${social.reddit.subreddit ? ` → r/${social.reddit.subreddit}` : ''}` : undefined} onDisc={() => disconnect('reddit')} /> : (
                <>
                  <ol className="mt-3 space-y-1 text-[12px] text-muted">
                    <li><span className="text-violet">1.</span> На <a href="https://www.reddit.com/prefs/apps" target="_blank" rel="noopener noreferrer" className="text-violet hover:underline">reddit.com/prefs/apps <ExternalLink size={11} className="inline" /></a> создайте приложение типа <b className="text-text">script</b>.</li>
                    <li><span className="text-violet">2.</span> Возьмите <b className="text-text">client_id</b> (под названием) и <b className="text-text">secret</b>, укажите логин/пароль бота и сабреддит.</li>
                  </ol>
                  <div className="mt-3 space-y-2">
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input value={rd.client_id} onChange={(e) => setRd({ ...rd, client_id: e.target.value })} placeholder="client_id" className={inputCls} />
                      <input value={rd.client_secret} onChange={(e) => setRd({ ...rd, client_secret: e.target.value })} type="password" placeholder="client_secret" className={inputCls} />
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input value={rd.username} onChange={(e) => setRd({ ...rd, username: e.target.value })} placeholder="username (логин Reddit)" className={inputCls} />
                      <input value={rd.password} onChange={(e) => setRd({ ...rd, password: e.target.value })} type="password" placeholder="password" className={inputCls} />
                    </div>
                    <input value={rd.subreddit} onChange={(e) => setRd({ ...rd, subreddit: e.target.value })} placeholder="сабреддит по умолчанию (напр. test)" className={inputCls} />
                    <Button size="sm" onClick={() => connect({ platform: 'reddit', ...rd }, 'Reddit подключён.')} disabled={cBusy || !rd.client_id.trim() || !rd.client_secret.trim() || !rd.username.trim() || !rd.password.trim()}>{cBusy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} Подключить Reddit</Button>
                  </div>
                </>
              )}
              {cMsg && <p className={cn('mt-2 rounded-lg px-3 py-1.5 text-xs', cMsg.ok ? 'bg-teal/10 text-teal' : 'bg-danger/10 text-danger')}>{cMsg.text}</p>}
            </div>
          )}

          {/* compose */}
          <div className="card mt-4 space-y-4 rounded-3xl p-6">
            {platform === 'telegram' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-1.5">
                  <span className="block text-xs font-medium uppercase tracking-wide text-muted">{t('autopostPage.senderBot')}</span>
                  {bots.length ? (
                    <select value={botId} onChange={(e) => setBotId(e.target.value)} className="glass w-full rounded-xl px-3 py-2 text-sm text-text outline-none focus:border-violet/50">
                      {bots.map((b) => <option key={b.id} value={b.id} className="bg-panel">{b.label || (b.username ? '@' + b.username : t('autopostPage.botFallback'))}</option>)}
                    </select>
                  ) : <p className="text-[12px] text-amber">{t('autopostPage.connectBotHint1')}<Link to="/app/teams" className="underline">{t('autopostPage.connectBotTeam')}</Link>{t('autopostPage.connectBotHint2')}</p>}
                </label>
                <label className="space-y-1.5"><span className="block text-xs font-medium uppercase tracking-wide text-muted">{t('autopostPage.targetChannel')}</span><input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="@my_channel" className="glass w-full rounded-xl px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" /></label>
              </div>
            )}
            {platform === 'reddit' && (
              <label className="block space-y-1.5"><span className="block text-xs font-medium uppercase tracking-wide text-muted">Сабреддит (необязательно — если пусто, берётся по умолчанию)</span><input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="r/test" className="glass w-full rounded-xl px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" /></label>
            )}
            <label className="block space-y-1.5"><span className="block text-xs font-medium uppercase tracking-wide text-muted">{t('autopostPage.postText')}{platform === 'twitter' ? ' (до 280 символов)' : ''}</span>
              <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={4} placeholder={t('autopostPage.postPlaceholder')} className="glass w-full resize-y rounded-xl px-3 py-2.5 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
            </label>
            {(platform === 'facebook' || platform === 'instagram') && (
              <label className="block space-y-1.5"><span className="block text-xs font-medium uppercase tracking-wide text-muted">{t('autopostPage.imageLink')}{platform === 'instagram' ? t('autopostPage.requiredForInstagram') : '(' + t('common.optional') + ')'}</span>
                <input value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} placeholder={t('autopostPage.imageUrlPh')} className="glass w-full rounded-xl px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
                <span className="block text-[11px] text-fog">Ссылка на картинку или видео (mp4/mov). Для Instagram видео публикуется как Reels.</span>
              </label>
            )}
            <div className="flex flex-wrap items-end gap-3">
              <label className="space-y-1.5"><span className="block text-xs font-medium uppercase tracking-wide text-muted">{t('autopostPage.whenPublish')}</span><input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="glass rounded-xl px-3 py-2 text-sm text-text outline-none focus:border-violet/50" /><span className="block text-[10px] text-fog">{timezone}</span></label>
              <Button variant="outline" onClick={sendNow} disabled={busy || !canSend}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} {lang === 'ru' ? 'Отправить сейчас' : lang === 'uz' ? 'Hozir yuborish' : 'Send now'}</Button>
              <Button onClick={schedule} disabled={busy || !canSchedule}>{busy ? <Loader2 size={15} className="animate-spin" /> : <CalendarClock size={15} />} {t('autopostPage.schedule')}</Button>
            </div>
            {!ready && <p className="text-[11px] text-amber">{lang === 'ru' ? 'Сначала подключите выбранную платформу и укажите получателя.' : lang === 'uz' ? 'Avval platformani ulang va qabul qiluvchini kiriting.' : 'Connect the selected platform and choose a destination first.'}</p>}
            {platform === 'twitter' && content.length > 280 && <p className="text-[11px] text-danger">{content.length}/280</p>}
            {msg && <p className={cn('rounded-lg px-3 py-2 text-xs', msg.ok ? 'bg-teal/10 text-teal' : 'bg-danger/10 text-danger')}>{msg.text}</p>}
          </div>
        </>
      )}

      {posts.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-3 text-sm font-semibold text-text">{t('autopostPage.scheduledAndPublished')}</h2>
          <div className="space-y-2">
            {posts.map((p) => {
              const m = statusMeta[p.status] ?? statusMeta.scheduled
              return (
                <div key={p.id} className="card flex items-start gap-3 rounded-2xl p-4">
                  <m.icon size={16} className={cn('mt-0.5 shrink-0', m.cls)} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-text">{p.content}</p>
                    <p className="mt-1 text-[11px] text-muted">{p.platform ?? 'telegram'}{p.target_chat ? ` · ${p.target_chat}` : ''} · {fmt(p.scheduled_at)} · <span className={m.cls}>{t(m.label)}</span>{p.error ? ` · ${p.error}` : ''}</p>
                  </div>
                  {p.status === 'scheduled' && <button onClick={() => cancel(p.id)} className="shrink-0 rounded-lg p-1.5 text-muted hover:bg-white/5 hover:text-danger" aria-label={t('autopostPage.cancelPost')}><Trash2 size={15} /></button>}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
