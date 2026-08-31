import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, CheckCircle2, Eye, EyeOff, Link2, Loader2, PlugZap, RefreshCw, ShoppingBag, Unplug, Webhook } from 'lucide-react'
import { Button } from '../ui/Button'
import { isSupabaseEnabled, supabase } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'
import { GoogleSetup } from '../platform/GoogleSetup'

type ProviderId = 'telegram' | 'uzum' | 'moysklad' | 'amocrm' | 'custom_webhook'
type Draft = { primary: string; secondary: string }

const COPY = {
  ru: { title: 'Центр интеграций', desc: 'Подключайте рабочие сервисы. Секреты шифруются на сервере и никогда не возвращаются в браузер.', connected: 'Подключено', off: 'Не настроено', connect: 'Подключить и проверить', disconnect: 'Отключить', saving: 'Проверяем…', refresh: 'Обновить статусы', liveOnly: 'Подключение доступно после входа в live-воркспейс.', saved: 'Интеграция проверена и подключена.', failed: 'Не удалось проверить подключение.', writeOnly: 'Сохранённый секрет скрыт. Для замены введите новый.', telegram: 'Telegram Bot', telegramDesc: 'Токен BotFather проверяется через Telegram getMe.', uzum: 'Uzum Market', uzumDesc: 'Seller API-ключ проверяется read-only запросом.', moysklad: 'МойСклад', moyskladDesc: 'Токен API для товаров, остатков и заказов.', amo: 'amoCRM', amoDesc: 'Поддомен и access token для CRM.', webhook: 'Custom Webhook', webhookDesc: 'HTTPS endpoint и секрет подписи для n8n / Make.', primary: 'Секрет / API-ключ', url: 'HTTPS URL', subdomain: 'Поддомен', token: 'Access token', signing: 'Секрет подписи' },
  uz: { title: 'Integratsiyalar markazi', desc: 'Ish servislarini ulang. Sirlar serverda shifrlanadi va brauzerga qaytarilmaydi.', connected: 'Ulangan', off: 'Sozlanmagan', connect: 'Ulash va tekshirish', disconnect: 'Uzish', saving: 'Tekshirilmoqda…', refresh: 'Holatlarni yangilash', liveOnly: 'Ulanish live ish maydoniga kirgandan keyin mavjud.', saved: 'Integratsiya tekshirildi va ulandi.', failed: 'Ulanishni tekshirib bo‘lmadi.', writeOnly: 'Saqlangan sir yashirilgan. Almashtirish uchun yangisini kiriting.', telegram: 'Telegram Bot', telegramDesc: 'BotFather tokeni Telegram getMe orqali tekshiriladi.', uzum: 'Uzum Market', uzumDesc: 'Seller API kaliti read-only so‘rov bilan tekshiriladi.', moysklad: 'MoySklad', moyskladDesc: 'Mahsulotlar, qoldiq va buyurtmalar uchun API token.', amo: 'amoCRM', amoDesc: 'CRM uchun subdomen va access token.', webhook: 'Custom Webhook', webhookDesc: 'n8n / Make uchun HTTPS endpoint va imzo siri.', primary: 'Sir / API kalit', url: 'HTTPS URL', subdomain: 'Subdomen', token: 'Access token', signing: 'Imzo siri' },
  en: { title: 'Integration center', desc: 'Connect work services. Secrets are encrypted server-side and are never returned to the browser.', connected: 'Connected', off: 'Not configured', connect: 'Connect and verify', disconnect: 'Disconnect', saving: 'Checking…', refresh: 'Refresh statuses', liveOnly: 'Connections are available after signing in to a live workspace.', saved: 'Integration verified and connected.', failed: 'Could not verify the connection.', writeOnly: 'The stored secret is hidden. Enter a new one to rotate it.', telegram: 'Telegram Bot', telegramDesc: 'The BotFather token is verified through Telegram getMe.', uzum: 'Uzum Market', uzumDesc: 'The seller API key is verified with a read-only request.', moysklad: 'MoySklad', moyskladDesc: 'API token for products, inventory and orders.', amo: 'amoCRM', amoDesc: 'CRM subdomain and access token.', webhook: 'Custom Webhook', webhookDesc: 'HTTPS endpoint and signing secret for n8n / Make.', primary: 'Secret / API key', url: 'HTTPS URL', subdomain: 'Subdomain', token: 'Access token', signing: 'Signing secret' },
} as const

export function IntegrationCenter({ onChanged }: { onChanged?: () => void | Promise<void> }) {
  const { lang } = useI18n()
  const c = COPY[lang]
  const [connected, setConnected] = useState<Set<string>>(new Set())
  const [drafts, setDrafts] = useState<Record<ProviderId, Draft>>(() => ({ telegram: { primary: '', secondary: '' }, uzum: { primary: '', secondary: '' }, moysklad: { primary: '', secondary: '' }, amocrm: { primary: '', secondary: '' }, custom_webhook: { primary: '', secondary: '' } }))
  const [busy, setBusy] = useState<ProviderId | 'status' | null>(null)
  const [visible, setVisible] = useState<Set<ProviderId>>(new Set())
  const [message, setMessage] = useState('')

  const providers = useMemo(() => [
    { id: 'telegram' as const, title: c.telegram, desc: c.telegramDesc, icon: Bot, primary: c.primary, placeholder: '123456789:AA…' },
    { id: 'uzum' as const, title: c.uzum, desc: c.uzumDesc, icon: ShoppingBag, primary: c.primary, placeholder: 'uzum_…' },
    { id: 'moysklad' as const, title: c.moysklad, desc: c.moyskladDesc, icon: ShoppingBag, primary: c.token, placeholder: 'eyJ…' },
    { id: 'amocrm' as const, title: c.amo, desc: c.amoDesc, icon: Link2, primary: c.subdomain, secondary: c.token, placeholder: 'company', secondPlaceholder: 'eyJ…' },
    { id: 'custom_webhook' as const, title: c.webhook, desc: c.webhookDesc, icon: Webhook, primary: c.url, secondary: c.signing, placeholder: 'https://…', secondPlaceholder: 'whsec_…' },
  ], [c])

  const refresh = useCallback(async () => {
    if (!supabase) return
    setBusy('status')
    try {
      const { data } = await supabase.functions.invoke('connect-provider', { body: { action: 'status' } })
      setConnected(new Set((data as { connected?: string[] } | null)?.connected ?? []))
    } finally { setBusy(null) }
  }, [])

  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(timer) }, [refresh])
  const update = (id: ProviderId, key: keyof Draft, value: string) => setDrafts((current) => ({ ...current, [id]: { ...current[id], [key]: value } }))
  const secretFor = (id: ProviderId) => id === 'amocrm' || id === 'custom_webhook' ? `${drafts[id].primary.trim()}|${drafts[id].secondary.trim()}` : drafts[id].primary.trim()

  const connect = async (id: ProviderId) => {
    if (!supabase) { setMessage(c.liveOnly); return }
    setBusy(id); setMessage('')
    try {
      const { data, error } = await supabase.functions.invoke('connect-provider', { body: { action: 'connect', provider: id, api_key: secretFor(id) } })
      const result = data as { ok?: boolean; error?: string } | null
      if (error || !result?.ok) throw new Error(result?.error || c.failed)
      setConnected((current) => new Set(current).add(id)); setDrafts((current) => ({ ...current, [id]: { primary: '', secondary: '' } })); setMessage(c.saved); await onChanged?.()
    } catch (error) { setMessage(error instanceof Error ? error.message : c.failed) } finally { setBusy(null) }
  }
  const disconnect = async (id: ProviderId) => {
    if (!supabase) return
    setBusy(id); setMessage('')
    try { await supabase.functions.invoke('connect-provider', { body: { action: 'disconnect', provider: id } }); setConnected((current) => { const next = new Set(current); next.delete(id); return next }); await onChanged?.() } finally { setBusy(null) }
  }

  return <section className="card rounded-3xl p-5 sm:p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-start gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-accent-cyan/15 to-violet/15 text-accent-cyan"><PlugZap size={19} /></span><div><h2 className="text-lg font-bold text-text">{c.title}</h2><p className="mt-1 max-w-3xl text-xs leading-5 text-muted">{c.desc}</p></div></div><Button size="sm" variant="secondary" onClick={() => void refresh()} loading={busy === 'status'} leftIcon={<RefreshCw size={14} />}>{c.refresh}</Button></div>
    <div className="mt-5 rounded-2xl border border-ice/10 bg-black/10 p-4"><GoogleSetup simple onConnected={() => { void onChanged?.() }} /></div>
    <div className="mt-3 grid gap-3 lg:grid-cols-2">{providers.map((provider) => { const isConnected = connected.has(provider.id); const show = visible.has(provider.id); const Icon = provider.icon; return <article key={provider.id} className="rounded-2xl border border-ice/10 bg-black/10 p-4"><div className="flex items-start gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.04] text-violet"><Icon size={16} /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-bold text-text">{provider.title}</h3><span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[9px] font-bold uppercase tracking-wide', isConnected ? 'border-teal/20 bg-teal/10 text-teal' : 'border-ice/10 text-fog')}>{isConnected && <CheckCircle2 size={11} />}{isConnected ? c.connected : c.off}</span></div><p className="mt-1 text-[11px] leading-5 text-muted">{provider.desc}</p></div></div>
      {isConnected ? <div className="mt-4"><p className="mb-3 text-[10px] text-fog">{c.writeOnly}</p><Button size="sm" variant="secondary" loading={busy === provider.id} onClick={() => void disconnect(provider.id)} leftIcon={<Unplug size={13} />}>{c.disconnect}</Button></div> : <div className="mt-4 space-y-2"><label className="block text-[10px] font-semibold uppercase tracking-wide text-muted">{provider.primary}</label><div className="relative"><input type={show || provider.id === 'custom_webhook' || provider.id === 'amocrm' ? 'text' : 'password'} value={drafts[provider.id].primary} onChange={(event) => update(provider.id, 'primary', event.target.value)} placeholder={provider.placeholder} className="w-full rounded-xl border border-ice/10 bg-black/15 px-3 py-2.5 pr-10 text-xs text-text outline-none focus:border-accent-cyan/40" autoComplete="new-password" spellCheck={false} />{provider.id !== 'custom_webhook' && provider.id !== 'amocrm' && <button type="button" aria-label={show ? 'hide' : 'show'} onClick={() => setVisible((current) => { const next = new Set(current); if (show) next.delete(provider.id); else next.add(provider.id); return next })} className="absolute right-3 top-1/2 -translate-y-1/2 text-fog hover:text-text">{show ? <EyeOff size={14} /> : <Eye size={14} />}</button>}</div>{provider.secondary && <><label className="block pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted">{provider.secondary}</label><input type="password" value={drafts[provider.id].secondary} onChange={(event) => update(provider.id, 'secondary', event.target.value)} placeholder={provider.secondPlaceholder} className="w-full rounded-xl border border-ice/10 bg-black/15 px-3 py-2.5 text-xs text-text outline-none focus:border-accent-cyan/40" autoComplete="new-password" /></>}<Button size="sm" disabled={!isSupabaseEnabled || !drafts[provider.id].primary.trim() || Boolean(provider.secondary && !drafts[provider.id].secondary.trim())} loading={busy === provider.id} onClick={() => void connect(provider.id)} leftIcon={busy === provider.id ? <Loader2 size={13} /> : <PlugZap size={13} />}>{busy === provider.id ? c.saving : c.connect}</Button></div>}</article> })}</div>
    {message && <p role="status" className="mt-4 rounded-xl border border-ice/10 bg-black/10 px-3 py-2 text-xs text-muted">{message}</p>}
  </section>
}
