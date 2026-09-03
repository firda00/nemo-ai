import { useEffect, useState } from 'react'
import { Blocks, Code2, CreditCard, Building2, FileText, MessagesSquare, Loader2, CheckCircle2, KeyRound, Unplug, ExternalLink, ShieldCheck, Wrench, Play, Phone, Globe, Mic, Video, Image as ImageIcon, ShoppingBag, Sparkles, Clock, Library } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { Button } from '../../components/ui/Button'
import { GoogleSetup } from '../../components/platform/GoogleSetup'
import { CustomToolsManager } from '../../components/platform/CustomToolsManager'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'
import { AGENT_SKILLS } from '../../data/agentSkills'
import { CapabilityDirectory } from '../../components/platform/CapabilityDirectory'
import { KnowledgeIntegrationNav } from '../../components/platform/KnowledgeIntegrationNav'

/**
 * Integrations — connect a third-party service once; it becomes a TOOL the AI agent can
 * use (e.g. GitHub for developers, a CRM for sales). Keys are stored server-only
 * (write-only) via connect-provider. Tool execution during a run is wired per integration.
 */
interface Integ { id: string; icon: typeof Code2; color: string; title: string; category: string; what: string; steps: string[]; link: string; placeholder: string; implemented?: boolean }
const INTEGRATIONS: Integ[] = [
  { id: 'github', icon: Code2, color: '#8B7CF8', category: 'Разработка', title: 'GitHub', what: 'githubWhat', placeholder: 'ghp_… (Personal Access Token)', link: 'https://github.com/settings/tokens', implemented: false,
    steps: ['githubS1', 'githubS2', 'githubS3'] },
  // Held back deliberately, not for lack of an executor: a Stripe SECRET key is full account
  // access (refunds, payouts, customer data) and we ask for it on a bare-IP host with no legal
  // entity, DPA or KMS-encrypted storage. Re-enable only with restricted keys (explicit scopes)
  // or Stripe Connect OAuth, once the product is on its own domain.
  { id: 'stripe', icon: CreditCard, color: '#635BFF', category: 'Оплата', title: 'Stripe', what: 'stripeWhat', placeholder: 'sk_live_… or sk_test_…', link: 'https://dashboard.stripe.com/apikeys', implemented: false,
    steps: ['stripeS1', 'stripeS2', 'stripeS3'] },
  { id: 'hubspot', icon: Building2, color: '#FF7A59', category: 'CRM', title: 'HubSpot', what: 'hubspotWhat', placeholder: 'Private App token', link: 'https://developers.hubspot.com/docs/api/private-apps',
    steps: ['hubspotS1', 'hubspotS2', 'hubspotS3'] },
  { id: 'amocrm', icon: Building2, color: '#3CB6E3', category: 'CRM', title: 'amoCRM', what: 'amocrmWhat', placeholder: 'Long-lived token', link: 'https://www.amocrm.ru/developers',
    steps: ['amocrmS1', 'amocrmS2', 'amocrmS3'] },
  { id: 'bitrix24', icon: Building2, color: '#2FB5F0', category: 'CRM', title: 'Bitrix24', what: 'bitrix24What', placeholder: 'Incoming webhook key', link: 'https://helpdesk.bitrix24.ru/open/12357070/',
    steps: ['bitrix24S1', 'bitrix24S2', 'bitrix24S3'] },
  { id: 'notion', icon: FileText, color: '#EAECF6', category: 'Продуктивность', title: 'Notion', what: 'notionWhat', placeholder: 'secret_… (Internal Integration)', link: 'https://www.notion.so/my-integrations',
    steps: ['notionS1', 'notionS2', 'notionS3'] },
  { id: 'slack', icon: MessagesSquare, color: '#13C5B4', category: 'Продуктивность', title: 'Slack', what: 'slackWhat', placeholder: 'xoxb-… (Bot Token)', link: 'https://api.slack.com/apps',
    steps: ['slackS1', 'slackS2', 'slackS3'] },
  { id: 'bland', icon: Phone, color: '#5B7CF6', category: 'Звонки', title: 'Bland.ai', what: 'blandWhat', placeholder: 'Bland API key', link: 'https://app.bland.ai',
    steps: ['blandS1', 'blandS2', 'blandS3'] },
  { id: 'vapi', icon: Phone, color: '#13C5B4', category: 'Звонки', title: 'Vapi', what: 'vapiWhat', placeholder: 'Vapi API key', link: 'https://dashboard.vapi.ai', implemented: false,
    steps: ['vapiS1', 'vapiS2', 'vapiS3'] },
  { id: 'hyperbrowser', icon: Globe, color: '#22D3EE', category: 'Браузер-агент', title: 'Hyperbrowser', what: 'hyperbrowserWhat', placeholder: 'Hyperbrowser API key (optional)', link: 'https://app.hyperbrowser.ai',
    steps: ['hyperbrowserS1', 'hyperbrowserS2', 'hyperbrowserS3'] },
  // Медиа · голос · видео (дубляж, аватары, изображения)
  { id: 'elevenlabs', icon: Mic, color: '#EC6CB0', category: 'Медиа · голос · видео', title: 'ElevenLabs', what: 'elevenlabsWhat', placeholder: 'ElevenLabs API key', link: 'https://elevenlabs.io/app/settings/api-keys',
    steps: ['elevenlabsS1', 'elevenlabsS2', 'elevenlabsS3'] },
  { id: 'heygen', icon: Video, color: '#5B7CF6', category: 'Медиа · голос · видео', title: 'HeyGen', what: 'heygenWhat', placeholder: 'HeyGen API key', link: 'https://app.heygen.com/settings',
    steps: ['heygenS1', 'heygenS2', 'heygenS3'] },
  { id: 'did', icon: Video, color: '#22D3EE', category: 'Медиа · голос · видео', title: 'D-ID', what: 'didWhat', placeholder: 'D-ID API key', link: 'https://studio.d-id.com/account-settings', implemented: false,
    steps: ['didS1', 'didS2', 'didS3'] },
  { id: 'synthesia', icon: Video, color: '#F4A640', category: 'Медиа · голос · видео', title: 'Synthesia', what: 'synthesiaWhat', placeholder: 'Synthesia API key', link: 'https://www.synthesia.io', implemented: false,
    steps: ['synthesiaS1', 'synthesiaS2', 'synthesiaS3'] },
  { id: 'replicate', icon: ImageIcon, color: '#8B7CF8', category: 'Медиа · голос · видео', title: 'Replicate', what: 'replicateWhat', placeholder: 'r8_… (Replicate token)', link: 'https://replicate.com/account/api-tokens',
    steps: ['replicateS1', 'replicateS2', 'replicateS3'] },
  { id: 'stability', icon: ImageIcon, color: '#13C5B4', category: 'Медиа · голос · видео', title: 'Stability AI', what: 'stabilityWhat', placeholder: 'sk-… (Stability key)', link: 'https://platform.stability.ai/account/keys', implemented: false,
    steps: ['stabilityS1', 'stabilityS2', 'stabilityS3'] },
  // Маркетплейсы (API продавца → данные для маркетплейс-агента)
  { id: 'uzum', icon: ShoppingBag, color: '#7000FF', category: 'Маркетплейсы', title: 'Uzum Market', what: 'uzumWhat', placeholder: 'Uzum Seller API key', link: 'https://seller.uzum.uz/seller/api-keys',
    steps: ['uzumS1', 'uzumS2', 'uzumS3'] },
  { id: 'wildberries', icon: ShoppingBag, color: '#CB11AB', category: 'Маркетплейсы', title: 'Wildberries', what: 'wildberriesWhat', placeholder: 'WB API token', link: 'https://seller.wildberries.ru',
    steps: ['wildberriesS1', 'wildberriesS2', 'wildberriesS3'] },
  { id: 'ozon', icon: ShoppingBag, color: '#005BFF', category: 'Маркетплейсы', title: 'Ozon', what: 'ozonWhat', placeholder: 'Ozon Api-Key', link: 'https://seller.ozon.ru',
    steps: ['ozonS1', 'ozonS2', 'ozonS3'] },
  { id: 'kaspi', icon: ShoppingBag, color: '#F14635', category: 'Маркетплейсы', title: 'Kaspi', what: 'kaspiWhat', placeholder: 'Kaspi API token', link: 'https://kaspi.kz/merchantcabinet', implemented: false,
    steps: ['kaspiS1', 'kaspiS2', 'kaspiS3'] },
  { id: 'airtable', icon: FileText, color: '#FCB400', category: 'Продуктивность', title: 'Airtable', what: 'airtableWhat', placeholder: 'pat… (Airtable token)', link: 'https://airtable.com/create/tokens',
    steps: ['airtableS1', 'airtableS2', 'airtableS3'] },
]
const CATEGORIES = ['Медиа · голос · видео', 'Маркетплейсы', 'CRM', 'Оплата', 'Продуктивность', 'Разработка', 'Звонки', 'Браузер-агент']
// Maps the internal (comparison-key) category value → i18n key for display only.
const CAT_LABEL: Record<string, string> = {
  'Медиа · голос · видео': 'catMedia',
  'Маркетплейсы': 'catMarketplace',
  'CRM': 'catCrm',
  'Оплата': 'catPayment',
  'Продуктивность': 'catProductivity',
  'Разработка': 'catDev',
  'Звонки': 'catCalls',
  'Браузер-агент': 'catBrowser',
}
// Placeholders that need translation (the rest are Latin-only token formats, left as-is).
const PH_KEY: Record<string, string> = { stripe: 'stripePh', amocrm: 'amocrmPh', bitrix24: 'bitrix24Ph', hyperbrowser: 'hyperbrowserPh' }

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function IntegrationsToolsPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useI18n()
  const [searchParams] = useSearchParams()
  const [connected, setConnected] = useState<string[]>([])
  const [loading, setLoading] = useState(isSupabaseEnabled)
  const [keyIn, setKeyIn] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({})
  // agent tool tester
  const [instr, setInstr] = useState('')
  const [toolBusy, setToolBusy] = useState(false)
  const [toolRes, setToolRes] = useState<{ ok: boolean; tool?: string; result?: string; text?: string } | null>(null)
  // call tester
  const [callPhone, setCallPhone] = useState('')
  const [callTask, setCallTask] = useState('')
  const [callBusy, setCallBusy] = useState(false)
  const [callRes, setCallRes] = useState<{ ok: boolean; text: string } | null>(null)
  // browser-task tester
  const [brUrl, setBrUrl] = useState('')
  const [brTask, setBrTask] = useState('')
  const [brBusy, setBrBusy] = useState(false)
  const [brRes, setBrRes] = useState<{ ok: boolean; text: string } | null>(null)
  const [directoryOpen, setDirectoryOpen] = useState(false)

  const refresh = async () => {
    if (!supabase) return
    const { data } = await supabase.functions.invoke('connect-provider', { body: { action: 'status' } })
    const p = data as { connected?: string[] } | null
    if (p?.connected) setConnected(p.connected)
  }
  useEffect(() => { if (!isSupabaseEnabled || !supabase) return; (async () => { try { await refresh() } catch { /* ignore */ } setLoading(false) })() }, [])
  useEffect(() => {
    if (loading) return
    const id = searchParams.get('integration')
    if (!id) return
    window.setTimeout(() => document.getElementById(`integration-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50)
  }, [loading, searchParams])

  const connect = async (id: string) => {
    if (!supabase || busy) return
    if (INTEGRATIONS.find((item) => item.id === id)?.implemented === false) return
    setBusy(id); setMsg((m) => ({ ...m, [id]: undefined as any }))
    try {
      const { data } = await supabase.functions.invoke('connect-provider', { body: { action: 'connect', provider: id, api_key: (keyIn[id] ?? '').trim() } })
      const p = data as { ok?: boolean; error?: string } | null
      if (!p?.ok) { setMsg((m) => ({ ...m, [id]: { ok: false, text: p?.error ?? t('integrationsToolsPage.connectFailed') } })); return }
      setKeyIn((k) => ({ ...k, [id]: '' })); setMsg((m) => ({ ...m, [id]: { ok: true, text: t('integrationsToolsPage.connectedToast') } })); await refresh()
    } catch { setMsg((m) => ({ ...m, [id]: { ok: false, text: t('integrationsToolsPage.errorGeneric') } })) } finally { setBusy(null) }
  }
  const disconnect = async (id: string) => {
    if (!supabase || busy) return
    setBusy(id); setMsg((m) => ({ ...m, [id]: undefined as any }))
    try { await supabase.functions.invoke('connect-provider', { body: { action: 'disconnect', provider: id } }); await refresh() } finally { setBusy(null) }
  }
  const runBrowser = async () => {
    if (!supabase || brBusy || brTask.trim().length < 5) return
    setBrBusy(true); setBrRes(null)
    try {
      const { data } = await supabase.functions.invoke('browser-task', { body: { action: 'run', task: brTask.trim(), url: brUrl.trim() } })
      const p = data as any
      if (p?.code === 'NO_KEY') setBrRes({ ok: false, text: p.message })
      else if (p?.pending) setBrRes({ ok: true, text: p.message || t('integrationsToolsPage.browserPending') })
      else setBrRes({ ok: Boolean(p?.ok), text: p?.result || p?.error || t('integrationsToolsPage.done') })
    } catch { setBrRes({ ok: false, text: t('integrationsToolsPage.errorGeneric') }) } finally { setBrBusy(false) }
  }
  const runTool = async () => {
    if (!supabase || toolBusy || instr.trim().length < 3) return
    setToolBusy(true); setToolRes(null)
    try {
      const { data } = await supabase.functions.invoke('agent-tool', { body: { instruction: instr.trim() } })
      const p = data as any
      if (p?.code === 'NO_TOOLS') { setToolRes({ ok: false, text: p.message }); setDirectoryOpen(true) }
      else setToolRes({ ok: Boolean(p?.ok), tool: p?.tool, result: p?.result ?? p?.error, text: p?.tool ? undefined : (p?.result ?? p?.error) })
    } catch { setToolRes({ ok: false, text: t('integrationsToolsPage.errorGeneric') }) } finally { setToolBusy(false) }
  }
  const runCall = async () => {
    if (!supabase || callBusy || callPhone.trim().length < 7 || callTask.trim().length < 3) return
    setCallBusy(true); setCallRes(null)
    try {
      const { data } = await supabase.functions.invoke('make-call', { body: { phone: callPhone.trim(), task: callTask.trim() } })
      const p = data as any
      if (p?.ok) setCallRes({ ok: true, text: t('integrationsToolsPage.callStarted', { id: p.call_id }) })
      else setCallRes({ ok: false, text: p?.message ?? p?.error ?? t('integrationsToolsPage.callFailed') })
    } catch { setCallRes({ ok: false, text: t('integrationsToolsPage.callError') }) } finally { setCallBusy(false) }
  }

  return (
    <div className={embedded ? 'w-full' : 'container-page max-w-5xl py-8'}>
      {!embedded && <KnowledgeIntegrationNav active="tools" />}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet/15 text-violet"><Blocks size={20} /></span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-text">{t('integrationsToolsPage.title')}</h1>
          <p className="text-sm text-muted">{t('integrationsToolsPage.introA')}<b className="text-text">{t('integrationsToolsPage.introToolBold')}</b>{t('integrationsToolsPage.introB')}</p>
        </div>
        </div>
        <Button onClick={() => setDirectoryOpen(true)} variant="outline"><Library size={16} /> Directory</Button>
      </div>

      <CapabilityDirectory open={directoryOpen} onClose={() => setDirectoryOpen(false)} />

      <div className="card mt-5 flex items-start gap-2 rounded-2xl border border-violet/15 bg-violet/[0.05] p-4 text-[12.5px] leading-relaxed text-muted">
        <Wrench size={15} className="mt-0.5 shrink-0 text-violet" />
        <span>{t('integrationsToolsPage.wrenchNote')}</span>
      </div>

      {/* Built-in AI skills — keyless, toggled per agent (no setup) */}
      <div className="card mt-4 rounded-3xl p-6">
        <h3 className="flex items-center gap-2 text-sm font-bold text-text"><Sparkles size={15} className="text-violet" /> {t('agentEdit.skillsCatalogTitle')}</h3>
        <p className="mt-1 text-[12px] text-muted">{t('agentEdit.skillsCatalogDesc')}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {AGENT_SKILLS.map((s) => (
            <div key={s.id} className="rounded-2xl border border-ice/10 bg-black/20 p-3.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: `${s.color}22`, color: s.color }}><s.icon size={16} /></span>
              <p className="mt-2 text-[13px] font-semibold text-text">{t(`agentEdit.skill_${s.id}`)}</p>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted">{t(`agentEdit.skill_${s.id}Desc`)}</p>
            </div>
          ))}
        </div>
        <Link to="/app/agents" className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-violet hover:underline"><Sparkles size={12} /> {t('agentEdit.skillsEnableHint')}</Link>
      </div>

      {/* agent tool tester — proves the connected integration is a real tool */}
      <div className="card mt-4 rounded-3xl p-6">
        <h3 className="flex items-center gap-2 text-sm font-bold text-text"><Play size={15} className="text-violet" /> {t('integrationsToolsPage.toolTesterTitle')}</h3>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input value={instr} onChange={(e) => setInstr(e.target.value)} placeholder={t('integrationsToolsPage.toolTesterPlaceholder')} className="flex-1 rounded-xl border border-ice/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
          <Button onClick={runTool} disabled={toolBusy || instr.trim().length < 3}>{toolBusy ? <><Loader2 size={15} className="animate-spin" /> {t('integrationsToolsPage.running')}</> : <><Play size={15} /> {t('integrationsToolsPage.run')}</>}</Button>
        </div>
        {toolRes && (
          <div className={cn('mt-3 rounded-xl px-3 py-2.5 text-[13px]', toolRes.ok ? 'bg-teal/10 text-teal' : 'bg-danger/10 text-danger')}>
            {toolRes.tool && <p className="mb-1 text-[11px] text-muted">{t('integrationsToolsPage.toolLabel')}<span className="text-violet">{toolRes.tool}</span></p>}
            {toolRes.result || toolRes.text}
          </div>
        )}
      </div>

      {/* browser-agent tester — the agent visits a site and does the task */}
      <div className="card mt-4 rounded-3xl p-6">
        <h3 className="flex items-center gap-2 text-sm font-bold text-text"><Globe size={15} className="text-cyan" /> {t('integrationsToolsPage.browserTitle')}</h3>
        <p className="mt-1 text-[12px] text-fog"><b className="text-text">{t('integrationsToolsPage.browserIncludedBold')}</b>{t('integrationsToolsPage.browserDesc')}</p>
        <div className="mt-3 space-y-2">
          <input value={brUrl} onChange={(e) => setBrUrl(e.target.value)} placeholder={t('integrationsToolsPage.browserUrlPlaceholder')} className="w-full rounded-xl border border-ice/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
          <div className="flex flex-col gap-2 sm:flex-row">
            <input value={brTask} onChange={(e) => setBrTask(e.target.value)} placeholder={t('integrationsToolsPage.browserTaskPlaceholder')} className="flex-1 rounded-xl border border-ice/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
            <Button onClick={runBrowser} disabled={brBusy || brTask.trim().length < 5}>{brBusy ? <><Loader2 size={15} className="animate-spin" /> {t('integrationsToolsPage.browserRunning')}</> : <><Globe size={15} /> {t('integrationsToolsPage.run')}</>}</Button>
          </div>
        </div>
        {brRes && <div className={cn('mt-3 rounded-xl px-3 py-2.5 text-[13px]', brRes.ok ? 'bg-teal/10 text-teal' : 'bg-danger/10 text-danger')}>{brRes.text}</div>}
      </div>

      {/* My tools — user-defined HTTP endpoints + MCP servers become agent tools */}
      <div className="mt-6">
        <div className="card mb-3 flex items-start gap-2 rounded-2xl border border-cyan/15 bg-cyan/[0.05] p-4 text-[12.5px] leading-relaxed text-muted">
          <Blocks size={15} className="mt-0.5 shrink-0 text-cyan" />
          <span><b className="text-text">{t('agentEdit.mcpCalloutTitle')}</b> — {t('agentEdit.mcpCalloutDesc')}</span>
        </div>
        <CustomToolsManager />
      </div>

      {/* Google ecosystem — OAuth connect; unlocks Gmail / Calendar / Sheets as agent tools */}
      <div className="mt-6">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-fog">{t('integrationsToolsPage.googleSection')}</p>
        <div className="card rounded-3xl p-5">
          <p className="mb-3 text-[13px] text-muted">{t('integrationsToolsPage.googleLead')}<b className="text-text">{t('integrationsToolsPage.googleGmail')}</b>, <b className="text-text">{t('integrationsToolsPage.googleCalendar')}</b>{t('integrationsToolsPage.googleAnd')}<b className="text-text">{t('integrationsToolsPage.googleSheets')}</b>{t('integrationsToolsPage.googleTail')}</p>
          <GoogleSetup />
        </div>
      </div>

      {loading ? (
        <div className="card mt-4 flex items-center gap-2 rounded-3xl p-6 text-sm text-muted"><Loader2 size={15} className="animate-spin" /> {t('common.loading')}</div>
      ) : (
        CATEGORIES.map((cat) => (
          <div key={cat} className="mt-6">
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-fog">{t(`integrationsToolsPage.${CAT_LABEL[cat]}`)}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              {INTEGRATIONS.filter((i) => i.category === cat).map((it) => {
                const on = connected.includes(it.id)
                const m = msg[it.id]
                return (
                  <div id={`integration-${it.id}`} key={it.id} className="card scroll-mt-24 rounded-3xl p-5">
                    <div className="flex items-center gap-2">
                      <span className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: `${it.color}22`, color: it.color }}><it.icon size={18} /></span>
                      <h3 className="flex-1 text-sm font-bold text-text">{it.title}</h3>
                      {on
                        ? <span className="inline-flex items-center gap-1 rounded-pill bg-teal/10 px-2 py-0.5 text-[10px] text-teal"><CheckCircle2 size={11} /> {t('integrationsToolsPage.badgeConnected')}</span>
                        : it.implemented === false
                          ? <span className="inline-flex items-center gap-1 rounded-pill bg-amber/10 px-2 py-0.5 text-[10px] text-amber"><Clock size={11} /> {t('platform.integrations.soon')}</span>
                          : <span className="rounded-pill bg-white/[0.05] px-2 py-0.5 text-[10px] text-muted">{t('integrationsToolsPage.badgeTool')}</span>}
                    </div>
                    <p className="mt-3 text-[13px] text-muted">{t(`integrationsToolsPage.${it.what}`)}</p>
                    {on ? (
                      <div className="mt-3 flex items-center gap-2">
                        <span className="inline-flex items-center gap-1.5 rounded-xl border border-teal/20 bg-teal/[0.06] px-3 py-1.5 text-xs text-text"><KeyRound size={13} className="text-teal" /> {t('integrationsToolsPage.connectedChip')}</span>
                        <Button size="sm" variant="ghost" onClick={() => disconnect(it.id)} disabled={busy === it.id}>{busy === it.id ? <Loader2 size={13} className="animate-spin" /> : <Unplug size={13} />} {t('integrationsToolsPage.disconnect')}</Button>
                      </div>
                    ) : it.implemented === false ? (
                      <p className="mt-3 rounded-xl border border-amber/20 bg-amber/[0.06] px-3 py-2 text-[12px] leading-relaxed text-amber">{t('integrationsToolsPage.runtimeNotReady')}</p>
                    ) : (
                      <>
                        <ol className="mt-3 space-y-1 text-[12px] text-muted">{it.steps.map((s, i) => <li key={i} className="flex gap-2"><span className="text-violet">{i + 1}.</span> {t(`integrationsToolsPage.${s}`)}</li>)}</ol>
                        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                          <input value={keyIn[it.id] ?? ''} onChange={(e) => setKeyIn((k) => ({ ...k, [it.id]: e.target.value }))} type="password" placeholder={PH_KEY[it.id] ? t(`integrationsToolsPage.${PH_KEY[it.id]}`) : it.placeholder} className="flex-1 rounded-xl border border-ice/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
                          <Button size="sm" onClick={() => connect(it.id)} disabled={busy === it.id || (keyIn[it.id] ?? '').trim().length < 10}>{busy === it.id ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />} {t('integrationsToolsPage.connect')}</Button>
                        </div>
                      </>
                    )}
                    {m && <p className={cn('mt-2 rounded-lg px-3 py-1.5 text-xs', m.ok ? 'bg-teal/10 text-teal' : 'bg-danger/10 text-danger')}>{m.text}</p>}
                    <a href={it.link} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 text-[12px] text-violet hover:underline">{t('integrationsToolsPage.openLink', { name: it.title })} <ExternalLink size={11} /></a>
                  </div>
                )
              })}
            </div>
          </div>
        ))
      )}

      {/* call tester (Bland.ai) */}
      <div className="card mt-6 rounded-3xl p-6">
        <h3 className="flex items-center gap-2 text-sm font-bold text-text"><Phone size={15} className="text-violet" /> {t('integrationsToolsPage.callTitle')}</h3>
        <p className="mt-1 text-[12px] text-muted">{t('integrationsToolsPage.callDesc')}</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-[220px_1fr_auto]">
          <input value={callPhone} onChange={(e) => setCallPhone(e.target.value)} placeholder="+998901234567" className="rounded-xl border border-ice/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
          <input value={callTask} onChange={(e) => setCallTask(e.target.value)} placeholder={t('integrationsToolsPage.callTaskPlaceholder')} className="rounded-xl border border-ice/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
          <Button onClick={runCall} disabled={callBusy || callPhone.trim().length < 7 || callTask.trim().length < 3}>{callBusy ? <Loader2 size={15} className="animate-spin" /> : <Phone size={15} />} {t('integrationsToolsPage.callBtn')}</Button>
        </div>
        {callRes && <p className={cn('mt-2 rounded-lg px-3 py-2 text-xs', callRes.ok ? 'bg-teal/10 text-teal' : 'bg-danger/10 text-danger')}>{callRes.text}</p>}
      </div>

      <p className="mt-6 flex items-center gap-1.5 text-[11px] text-fog"><ShieldCheck size={13} className="text-teal" /> {t('integrationsToolsPage.securityNote')}</p>
    </div>
  )
}
