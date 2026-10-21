import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, BrainCircuit, CheckCircle2, Eye, EyeOff, Image, Link2, Loader2, Mic2, PhoneCall, PlugZap, RefreshCw, ShoppingBag, Unplug, Video, Webhook } from 'lucide-react'
import { Button } from '../ui/Button'
import { isSupabaseEnabled, supabase } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'
import { GoogleSetup } from '../platform/GoogleSetup'

export type IntegrationProviderId = 'openrouter' | 'openai' | 'anthropic' | 'gemini' | 'groq' | 'replicate' | 'fal' | 'heygen' | 'elevenlabs' | 'deepgram' | 'bland' | 'vapi' | 'telegram' | 'uzum' | 'moysklad' | 'amocrm' | 'custom_webhook' | 'hubspot' | 'notion' | 'slack' | 'hyperbrowser'
type Draft = { primary: string; secondary: string }

const COPY = {
  ru: { title: 'Ключи и подключения', desc: 'Все ключи хранятся в одном месте, шифруются на сервере и никогда не возвращаются в браузер.', connected: 'Ключ сохранён', off: 'Не настроено', connect: 'Сохранить безопасно', disconnect: 'Удалить ключ', saving: 'Сохраняем…', refresh: 'Обновить статусы', liveOnly: 'Подключение доступно после входа в live-воркспейс.', saved: 'Ключ сохранён. Nemo будет использовать его только для подходящей задачи.', failed: 'Не удалось сохранить подключение.', writeOnly: 'Сохранённый секрет скрыт. Для замены удалите его и добавьте новый.', telegram: 'Telegram Bot', telegramDesc: 'Токен BotFather проверяется через Telegram getMe.', uzum: 'Uzum Market', uzumDesc: 'Seller API-ключ проверяется read-only запросом.', moysklad: 'МойСклад', moyskladDesc: 'Токен API для товаров, остатков и заказов.', amo: 'amoCRM', amoDesc: 'Поддомен и access token для CRM.', webhook: 'Custom Webhook', webhookDesc: 'HTTPS endpoint и секрет подписи для n8n / Make.', primary: 'Секрет / API-ключ', url: 'HTTPS URL', subdomain: 'Поддомен', token: 'Access token', signing: 'Секрет подписи', soon: 'Скоро', notReady: 'Ключ нельзя сохранить до появления рабочего исполнителя — это защищает от ложного статуса «подключено».', refreshFailed: 'Не удалось обновить статусы ключей.', disconnectFailed: 'Не удалось удалить ключ.', descOpenrouter: 'Единый шлюз моделей. Не обязателен: можно подключать провайдеров напрямую.', descOpenai: 'GPT Image по явному выбору модели. Ключ используется только для прямых запусков.', descAnthropic: 'Claude для сложных текстовых задач. Прямой исполнитель ещё подключается.', descGemini: 'Gemini, Imagen и Veo. Прямой исполнитель ещё подключается.', descGroq: 'Быстрые текстовые модели. Прямой исполнитель ещё подключается.', descReplicate: 'Прямой запуск minimax/video-01 по явному выбору модели.', descFal: 'Модели изображений и видео. Прямой исполнитель ещё подключается.', descHeygen: 'Видео с говорящими аватарами.', descElevenlabs: 'Озвучка, голоса и дубляж.', descDeepgram: 'Распознавание речи и субтитры. Прямой исполнитель ещё подключается.', descBland: 'Исходящие голосовые звонки агента.', descVapi: 'Телефонные AI-агенты. Прямой исполнитель ещё подключается.' },
  uz: { title: 'Kalitlar va ulanishlar', desc: 'Barcha kalitlar bir joyda saqlanadi, serverda shifrlanadi va brauzerga hech qachon qaytarilmaydi.', connected: 'Kalit saqlandi', off: 'Sozlanmagan', connect: 'Xavfsiz saqlash', disconnect: 'Kalitni o‘chirish', saving: 'Saqlanmoqda…', refresh: 'Holatlarni yangilash', liveOnly: 'Ulanish live ish maydoniga kirgandan keyin mavjud.', saved: 'Kalit saqlandi. Nemo undan faqat mos vazifa uchun foydalanadi.', failed: 'Ulanishni saqlab bo‘lmadi.', writeOnly: 'Saqlangan sir yashirilgan. Almashtirish uchun avval o‘chirib, yangisini qo‘shing.', telegram: 'Telegram Bot', telegramDesc: 'BotFather tokeni Telegram getMe orqali tekshiriladi.', uzum: 'Uzum Market', uzumDesc: 'Seller API kaliti read-only so‘rov bilan tekshiriladi.', moysklad: 'MoySklad', moyskladDesc: 'Mahsulotlar, qoldiq va buyurtmalar uchun API token.', amo: 'amoCRM', amoDesc: 'CRM uchun subdomen va access token.', webhook: 'Custom Webhook', webhookDesc: 'n8n / Make uchun HTTPS endpoint va imzo siri.', primary: 'Sir / API kalit', url: 'HTTPS URL', subdomain: 'Subdomen', token: 'Access token', signing: 'Imzo siri', soon: 'Tez orada', notReady: 'Ishlaydigan ijrochi tayyor bo‘lgunga qadar kalit saqlanmaydi — bu yolg‘on «ulangan» holatdan himoya qiladi.', refreshFailed: 'Kalit holatlarini yangilab bo‘lmadi.', disconnectFailed: 'Kalitni o‘chirib bo‘lmadi.', descOpenrouter: 'Modellarning yagona shlyuzi. Majburiy emas: provayderlarni to‘g‘ridan-to‘g‘ri ulash mumkin.', descOpenai: 'GPT Image faqat model aniq tanlanganda. Kalit faqat to‘g‘ridan-to‘g‘ri ishga tushirish uchun ishlatiladi.', descAnthropic: 'Murakkab matn vazifalari uchun Claude. To‘g‘ridan-to‘g‘ri ijrochi hali ulanmoqda.', descGemini: 'Gemini, Imagen va Veo. To‘g‘ridan-to‘g‘ri ijrochi hali ulanmoqda.', descGroq: 'Tezkor matn modellari. To‘g‘ridan-to‘g‘ri ijrochi hali ulanmoqda.', descReplicate: 'minimax/video-01 faqat model aniq tanlanganda to‘g‘ridan-to‘g‘ri ishga tushiriladi.', descFal: 'Rasm va video modellari. To‘g‘ridan-to‘g‘ri ijrochi hali ulanmoqda.', descHeygen: 'Gapiruvchi avatarli videolar.', descElevenlabs: 'Ovoz sintezi, ovozlar va dublyaj.', descDeepgram: 'Nutqni aniqlash va subtitrlar. To‘g‘ridan-to‘g‘ri ijrochi hali ulanmoqda.', descBland: 'Agentning chiquvchi ovozli qo‘ng‘iroqlari.', descVapi: 'Telefon AI-agentlari. To‘g‘ridan-to‘g‘ri ijrochi hali ulanmoqda.' },
  en: { title: 'Keys and connections', desc: 'All keys live in one place, are encrypted server-side and are never returned to the browser.', connected: 'Key saved', off: 'Not configured', connect: 'Save securely', disconnect: 'Remove key', saving: 'Saving…', refresh: 'Refresh statuses', liveOnly: 'Connections are available after signing in to a live workspace.', saved: 'Key saved. Nemo will use it only for the matching task.', failed: 'Could not save the connection.', writeOnly: 'The stored secret is hidden. Remove it and add a new one to rotate it.', telegram: 'Telegram Bot', telegramDesc: 'The BotFather token is verified through Telegram getMe.', uzum: 'Uzum Market', uzumDesc: 'The seller API key is verified with a read-only request.', moysklad: 'MoySklad', moyskladDesc: 'API token for products, inventory and orders.', amo: 'amoCRM', amoDesc: 'CRM subdomain and access token.', webhook: 'Custom Webhook', webhookDesc: 'HTTPS endpoint and signing secret for n8n / Make.', primary: 'Secret / API key', url: 'HTTPS URL', subdomain: 'Subdomain', token: 'Access token', signing: 'Signing secret', soon: 'Soon', notReady: 'A key cannot be saved until a working executor exists — this protects you from a false “connected” status.', refreshFailed: 'Could not refresh key statuses.', disconnectFailed: 'Could not remove the key.', descOpenrouter: 'A single model gateway. Optional: providers can also be connected directly.', descOpenai: 'GPT Image only when the model is chosen explicitly. The key is used for direct runs only.', descAnthropic: 'Claude for complex text tasks. The direct executor is still being wired up.', descGemini: 'Gemini, Imagen and Veo. The direct executor is still being wired up.', descGroq: 'Fast text models. The direct executor is still being wired up.', descReplicate: 'Direct runs of minimax/video-01 only when the model is chosen explicitly.', descFal: 'Image and video models. The direct executor is still being wired up.', descHeygen: 'Videos with talking avatars.', descElevenlabs: 'Voiceover, voices and dubbing.', descDeepgram: 'Speech recognition and subtitles. The direct executor is still being wired up.', descBland: 'Outbound voice calls for the agent.', descVapi: 'Phone AI agents. The direct executor is still being wired up.' },
} as const

export function IntegrationCenter({ onChanged, focusProvider }: { onChanged?: () => void | Promise<void>; focusProvider?: IntegrationProviderId | 'google' }) {
  const { lang } = useI18n()
  const c = COPY[lang]
  const [connected, setConnected] = useState<Set<string>>(new Set())
  const [drafts, setDrafts] = useState<Record<IntegrationProviderId, Draft>>(() => Object.fromEntries([
    'openrouter', 'openai', 'anthropic', 'gemini', 'groq', 'replicate', 'fal', 'heygen', 'elevenlabs', 'deepgram', 'bland', 'vapi', 'telegram', 'uzum', 'moysklad', 'amocrm', 'custom_webhook', 'hubspot', 'notion', 'slack', 'hyperbrowser',
  ].map((id) => [id, { primary: '', secondary: '' }])) as Record<IntegrationProviderId, Draft>)
  const [busy, setBusy] = useState<IntegrationProviderId | 'status' | null>(null)
  // mirrors `busy` for the concurrency guard — state reads inside async handlers go stale
  const busyRef = useRef<IntegrationProviderId | 'status' | null>(null)
  const [visible, setVisible] = useState<Set<IntegrationProviderId>>(new Set())
  const [message, setMessage] = useState('')

  const providers = useMemo(() => [
    { id: 'openrouter' as const, title: 'OpenRouter', desc: c.descOpenrouter, icon: BrainCircuit, primary: c.primary, placeholder: 'sk-or-…' },
    { id: 'openai' as const, title: 'OpenAI', desc: c.descOpenai, icon: Image, primary: c.primary, placeholder: 'sk-…' },
    { id: 'anthropic' as const, title: 'Anthropic', desc: c.descAnthropic, icon: BrainCircuit, primary: c.primary, placeholder: 'sk-ant-…', ready: false },
    { id: 'gemini' as const, title: 'Google AI', desc: c.descGemini, icon: Video, primary: c.primary, placeholder: 'AIza…', ready: false },
    { id: 'groq' as const, title: 'Groq', desc: c.descGroq, icon: BrainCircuit, primary: c.primary, placeholder: 'gsk_…', ready: false },
    { id: 'replicate' as const, title: 'Replicate', desc: c.descReplicate, icon: Video, primary: c.primary, placeholder: 'r8_…' },
    { id: 'fal' as const, title: 'fal.ai', desc: c.descFal, icon: Image, primary: c.primary, placeholder: 'fal_…', ready: false },
    { id: 'heygen' as const, title: 'HeyGen', desc: c.descHeygen, icon: Video, primary: c.primary, placeholder: 'HeyGen API key' },
    { id: 'elevenlabs' as const, title: 'ElevenLabs', desc: c.descElevenlabs, icon: Mic2, primary: c.primary, placeholder: 'ElevenLabs API key' },
    { id: 'deepgram' as const, title: 'Deepgram', desc: c.descDeepgram, icon: Mic2, primary: c.primary, placeholder: 'Deepgram API key', ready: false },
    { id: 'bland' as const, title: 'Bland.ai', desc: c.descBland, icon: PhoneCall, primary: c.primary, placeholder: 'Bland API key' },
    { id: 'vapi' as const, title: 'Vapi', desc: c.descVapi, icon: PhoneCall, primary: c.primary, placeholder: 'Vapi API key', ready: false },
    { id: 'telegram' as const, title: c.telegram, desc: c.telegramDesc, icon: Bot, primary: c.primary, placeholder: '123456789:AA…' },
    { id: 'uzum' as const, title: c.uzum, desc: c.uzumDesc, icon: ShoppingBag, primary: c.primary, placeholder: 'uzum_…' },
    { id: 'moysklad' as const, title: c.moysklad, desc: c.moyskladDesc, icon: ShoppingBag, primary: c.token, placeholder: 'eyJ…' },
    { id: 'amocrm' as const, title: c.amo, desc: c.amoDesc, icon: Link2, primary: c.subdomain, secondary: c.token, placeholder: 'company', secondPlaceholder: 'eyJ…' },
    { id: 'custom_webhook' as const, title: c.webhook, desc: c.webhookDesc, icon: Webhook, primary: c.url, secondary: c.signing, placeholder: 'https://…', secondPlaceholder: 'whsec_…' },
    { id: 'hubspot' as const, title: 'HubSpot', desc: 'Контакты и сделки CRM для задач агента.', icon: Link2, primary: c.token, placeholder: 'pat-…' },
    { id: 'notion' as const, title: 'Notion', desc: 'Поиск и чтение страниц рабочего пространства.', icon: Link2, primary: c.token, placeholder: 'secret_…' },
    { id: 'slack' as const, title: 'Slack', desc: 'Каналы, треды и подготовка сообщений.', icon: Link2, primary: c.token, placeholder: 'xoxb-…' },
    { id: 'hyperbrowser' as const, title: 'Browser agent', desc: 'Облачная браузерная сессия для задач агента.', icon: Link2, primary: c.primary, placeholder: 'Hyperbrowser API key' },
  ], [c])
  const visibleProviders = focusProvider === 'google'
    ? []
    : focusProvider
      ? providers.filter((provider) => provider.id === focusProvider)
      : providers

  const refresh = useCallback(async () => {
    if (!supabase || busyRef.current) return
    busyRef.current = 'status'; setBusy('status')
    try {
      const { data, error } = await supabase.functions.invoke('connect-provider', { body: { action: 'status' } })
      const result = data as { ok?: boolean; connected?: string[] } | null
      // on failure keep the last known statuses instead of clearing them
      if (error || !result?.ok) { setMessage(c.refreshFailed); return }
      setConnected(new Set(result.connected ?? []))
    } catch { setMessage(c.refreshFailed) } finally { busyRef.current = null; setBusy(null) }
  }, [c])

  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(timer) }, [refresh])
  const update = (id: IntegrationProviderId, key: keyof Draft, value: string) => setDrafts((current) => ({ ...current, [id]: { ...current[id], [key]: value } }))
  const secretFor = (id: IntegrationProviderId) => id === 'amocrm' || id === 'custom_webhook' ? `${drafts[id].primary.trim()}|${drafts[id].secondary.trim()}` : drafts[id].primary.trim()

  const connect = async (id: IntegrationProviderId) => {
    if (!supabase) { setMessage(c.liveOnly); return }
    if (busyRef.current) return
    busyRef.current = id; setBusy(id); setMessage('')
    let saved = false
    try {
      const { data, error } = await supabase.functions.invoke('connect-provider', { body: { action: 'connect', provider: id, api_key: secretFor(id) } })
      const result = data as { ok?: boolean; error?: string } | null
      if (error || !result?.ok) throw new Error(result?.error || c.failed)
      saved = true
      setConnected((current) => new Set(current).add(id)); setDrafts((current) => ({ ...current, [id]: { primary: '', secondary: '' } })); setMessage(c.saved)
      await onChanged?.()
    } catch (error) {
      // a failed onChanged refresh must not read as a failed save
      if (!saved) setMessage(error instanceof Error ? error.message : c.failed)
    } finally { busyRef.current = null; setBusy(null) }
  }
  const disconnect = async (id: IntegrationProviderId) => {
    if (!supabase || busyRef.current) return
    busyRef.current = id; setBusy(id); setMessage('')
    let removed = false
    try {
      const { data, error } = await supabase.functions.invoke('connect-provider', { body: { action: 'disconnect', provider: id } })
      const result = data as { ok?: boolean; error?: string } | null
      // only drop the badge once the server confirms the key row is gone
      if (error || !result?.ok) throw new Error(result?.error || c.disconnectFailed)
      removed = true
      setConnected((current) => { const next = new Set(current); next.delete(id); return next })
      await onChanged?.()
    } catch (error) {
      if (!removed) setMessage(error instanceof Error ? error.message : c.disconnectFailed)
    } finally { busyRef.current = null; setBusy(null) }
  }

  return <section className={focusProvider ? '' : 'card rounded-3xl p-5 sm:p-6'}>{!focusProvider && <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-start gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-accent-cyan/15 to-violet/15 text-accent-cyan"><PlugZap size={19} /></span><div><h2 className="text-lg font-bold text-text">{c.title}</h2><p className="mt-1 max-w-3xl text-xs leading-5 text-muted">{c.desc}</p></div></div><Button size="sm" variant="secondary" onClick={() => void refresh()} loading={busy === 'status'} disabled={busy !== null && busy !== 'status'} leftIcon={<RefreshCw size={14} />}>{c.refresh}</Button></div>}
    {(!focusProvider || focusProvider === 'google') && <div className={cn('rounded-2xl border border-ice/10 bg-black/10 p-4', !focusProvider && 'mt-5')}><GoogleSetup simple onConnected={() => { void onChanged?.() }} /></div>}
    <div className={cn('grid gap-3', !focusProvider && 'mt-3 lg:grid-cols-2')}>{visibleProviders.map((provider) => { const isConnected = connected.has(provider.id); const isReady = !('ready' in provider) || provider.ready !== false; const show = visible.has(provider.id); const Icon = provider.icon; return <article key={provider.id} className="rounded-2xl border border-ice/10 bg-black/10 p-4"><div className="flex items-start gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.04] text-violet"><Icon size={16} /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-bold text-text">{provider.title}</h3><span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[9px] font-bold uppercase tracking-wide', isConnected ? 'border-teal/20 bg-teal/10 text-teal' : isReady ? 'border-ice/10 text-fog' : 'border-amber/20 bg-amber/10 text-amber')}>{isConnected && <CheckCircle2 size={11} />}{isConnected ? c.connected : isReady ? c.off : c.soon}</span></div><p className="mt-1 text-[11px] leading-5 text-muted">{provider.desc}</p></div></div>
      {isConnected ? <div className="mt-4"><p className="mb-3 text-[10px] text-fog">{c.writeOnly}</p><Button size="sm" variant="secondary" loading={busy === provider.id} disabled={busy !== null && busy !== provider.id} onClick={() => void disconnect(provider.id)} leftIcon={<Unplug size={13} />}>{c.disconnect}</Button></div> : isReady ? <div className="mt-4 space-y-2"><label className="block text-[10px] font-semibold uppercase tracking-wide text-muted">{provider.primary}</label><div className="relative"><input type={show || provider.id === 'custom_webhook' || provider.id === 'amocrm' ? 'text' : 'password'} value={drafts[provider.id].primary} onChange={(event) => update(provider.id, 'primary', event.target.value)} placeholder={provider.placeholder} className="w-full rounded-xl border border-ice/10 bg-black/15 px-3 py-2.5 pr-10 text-xs text-text outline-none focus:border-accent-cyan/40" autoComplete="new-password" spellCheck={false} />{provider.id !== 'custom_webhook' && provider.id !== 'amocrm' && <button type="button" aria-label={show ? 'hide' : 'show'} onClick={() => setVisible((current) => { const next = new Set(current); if (show) next.delete(provider.id); else next.add(provider.id); return next })} className="absolute right-3 top-1/2 -translate-y-1/2 text-fog hover:text-text">{show ? <EyeOff size={14} /> : <Eye size={14} />}</button>}</div>{provider.secondary && <><label className="block pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted">{provider.secondary}</label><input type="password" value={drafts[provider.id].secondary} onChange={(event) => update(provider.id, 'secondary', event.target.value)} placeholder={provider.secondPlaceholder} className="w-full rounded-xl border border-ice/10 bg-black/15 px-3 py-2.5 text-xs text-text outline-none focus:border-accent-cyan/40" autoComplete="new-password" /></>}<Button size="sm" disabled={!isSupabaseEnabled || !drafts[provider.id].primary.trim() || Boolean(provider.secondary && !drafts[provider.id].secondary.trim()) || (busy !== null && busy !== provider.id)} loading={busy === provider.id} onClick={() => void connect(provider.id)} leftIcon={busy === provider.id ? <Loader2 size={13} /> : <PlugZap size={13} />}>{busy === provider.id ? c.saving : c.connect}</Button></div> : <div className="mt-4 rounded-xl border border-amber/15 bg-amber/[0.05] px-3 py-2 text-[11px] leading-5 text-muted">{c.notReady}</div>}</article> })}</div>
    {message && <p role="status" className="mt-4 rounded-xl border border-ice/10 bg-black/10 px-3 py-2 text-xs text-muted">{message}</p>}
  </section>
}
