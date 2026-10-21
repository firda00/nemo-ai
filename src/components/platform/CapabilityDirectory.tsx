import { useCallback, useEffect, useMemo, useState } from 'react'
import { Blocks, ChevronLeft, Link2, Plug, Plus, Search, ShieldCheck, Sparkles, Wrench, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { AGENT_SKILLS } from '../../data/agentSkills'
import { useI18n } from '../../i18n'
import { CustomToolsManager } from './CustomToolsManager'
import { IntegrationCenter, type IntegrationProviderId } from '../settings/IntegrationCenter'
import { cn } from '../../lib/cn'

export type DirectoryTab = 'skills' | 'connectors' | 'plugins'

interface ConnectorItem {
  id: string
  title: string
  description: string
  tools: string[]
  provider: IntegrationProviderId | 'google'
  color: string
}

const CONNECTORS: ConnectorItem[] = [
  { id: 'openrouter', title: 'OpenRouter', description: 'Необязательный единый шлюз для моделей разных компаний.', tools: ['chat', 'image', 'video', 'voice'], provider: 'openrouter', color: '#8B7CF8' },
  { id: 'openai', title: 'OpenAI', description: 'GPT Image и голос напрямую, без баланса OpenRouter.', tools: ['generate_image', 'text_to_speech'], provider: 'openai', color: '#10A37F' },
  { id: 'anthropic', title: 'Anthropic', description: 'Claude для сложного анализа и текста.', tools: ['chat', 'reasoning'], provider: 'anthropic', color: '#D97757' },
  { id: 'gemini', title: 'Google AI', description: 'Gemini, Imagen и Veo через отдельный API-ключ.', tools: ['chat', 'generate_image', 'generate_video'], provider: 'gemini', color: '#4285F4' },
  { id: 'groq', title: 'Groq', description: 'Быстрый маршрут для простых вопросов.', tools: ['fast_chat'], provider: 'groq', color: '#F55036' },
  { id: 'replicate', title: 'Replicate', description: 'Прямой запуск моделей видео и изображений.', tools: ['generate_video', 'generate_image'], provider: 'replicate', color: '#A78BFA' },
  { id: 'fal', title: 'fal.ai', description: 'Каталог моделей изображений и видео.', tools: ['generate_image', 'generate_video'], provider: 'fal', color: '#F5C542' },
  { id: 'heygen', title: 'HeyGen', description: 'Видео с говорящими аватарами.', tools: ['avatar_video'], provider: 'heygen', color: '#13C5B4' },
  { id: 'elevenlabs', title: 'ElevenLabs', description: 'Озвучка, клонирование голоса и дубляж.', tools: ['text_to_speech', 'dubbing'], provider: 'elevenlabs', color: '#F59F00' },
  { id: 'deepgram', title: 'Deepgram', description: 'Распознавание речи и подготовка субтитров.', tools: ['transcribe', 'subtitles'], provider: 'deepgram', color: '#6D5EF5' },
  { id: 'bland', title: 'Bland.ai', description: 'Исходящие звонки голосового агента.', tools: ['make_call'], provider: 'bland', color: '#EC4899' },
  { id: 'vapi', title: 'Vapi', description: 'Телефонные AI-агенты и звонки.', tools: ['make_call'], provider: 'vapi', color: '#22C55E' },
  { id: 'google', title: 'Google Workspace', description: 'Drive, Gmail, Calendar и Sheets для рабочих задач агента.', tools: ['search_files', 'read_file', 'send_draft', 'calendar_read', 'sheet_read'], provider: 'google', color: '#4285F4' },
  { id: 'telegram', title: 'Telegram', description: 'Несколько ботов, входящие диалоги, публикации и воронки.', tools: ['receive_message', 'send_message', 'schedule_post'], provider: 'telegram', color: '#2AABEE' },
  { id: 'hubspot', title: 'HubSpot', description: 'Контакты, сделки и безопасная передача лидов в CRM.', tools: ['find_contact', 'create_contact', 'create_deal'], provider: 'hubspot', color: '#FF7A59' },
  { id: 'notion', title: 'Notion', description: 'Поиск и чтение рабочих страниц по запросу агента.', tools: ['search_pages', 'read_page'], provider: 'notion', color: '#A7ADC0' },
  { id: 'slack', title: 'Slack', description: 'Чтение каналов и подготовка сообщений с подтверждением.', tools: ['search_messages', 'read_thread', 'draft_message'], provider: 'slack', color: '#36C5F0' },
  { id: 'browser', title: 'Browser agent', description: 'Открывает публичные страницы и выполняет ограниченную задачу.', tools: ['open_page', 'extract_text', 'complete_task'], provider: 'hyperbrowser', color: '#22B8CF' },
]

const TAB_ICONS: Record<DirectoryTab, typeof Sparkles> = { skills: Sparkles, connectors: Link2, plugins: Plug }

const COPY = {
  ru: {
    tabs: { skills: 'Навыки', connectors: 'Подключения', plugins: 'Плагины' },
    eyebrow: 'Каталог возможностей', subtitle: 'Всё, что агенты могут использовать в работе.', search: 'Найти навык, сервис или плагин…',
    connectorIntro: 'Единый центр ключей: подключайте OpenAI, Replicate, Google AI, голос, звонки и рабочие сервисы отдельно. Расходы идут напрямую через выбранного провайдера; OpenRouter не обязателен.',
    access: 'Доступные действия', authTitle: 'Доступ только по запросу', authText: 'Nemo подключает сервис только после вашего действия. Секреты хранятся на сервере и не попадают во frontend.', setup: 'Настроить подключение',
    skillsTitle: 'Навыки уже доступны агентам', skillsText: 'Выберите нужные навыки в настройках конкретного агента. Загруженные навыки остаются приватными.', addSkill: 'Настроить навыки',
    pluginsTitle: 'Проверяемые плагины', pluginsText: 'HTTPS и MCP-подключения проверяются перед сохранением. Плагин не получает серверные права автоматически.', allTools: 'Расширенные настройки', empty: 'Ничего не найдено', close: 'Закрыть', back: 'Назад', footer: 'Nemo подключает возможности к задаче, а не перегружает ими рабочий стол.',
  },
  uz: {
    tabs: { skills: 'Ko‘nikmalar', connectors: 'Ulanishlar', plugins: 'Plaginlar' },
    eyebrow: 'Imkoniyatlar katalogi', subtitle: 'Agentlar ishda foydalanishi mumkin bo‘lgan barcha vositalar.', search: 'Ko‘nikma, servis yoki plaginni toping…',
    connectorIntro: 'Oddiy vazifalar tashqi servislarsiz ishlaydi. Agentga fayl, taqvim, CRM yoki kanal kerak bo‘lsa, Nemo foydalanish vaqtida ruxsat so‘raydi.',
    access: 'Mavjud amallar', authTitle: 'Faqat so‘rov bo‘yicha ruxsat', authText: 'Nemo servisni faqat sizning harakatingizdan keyin ulaydi. Maxfiy ma’lumotlar serverda saqlanadi.', setup: 'Ulanishni sozlash',
    skillsTitle: 'Ko‘nikmalar agentlar uchun tayyor', skillsText: 'Kerakli ko‘nikmalarni agent sozlamalarida tanlang. Yuklangan ko‘nikmalar maxfiy qoladi.', addSkill: 'Ko‘nikmalarni sozlash',
    pluginsTitle: 'Tekshiriladigan plaginlar', pluginsText: 'HTTPS va MCP ulanishlari saqlashdan oldin tekshiriladi. Plagin avtomatik ravishda server huquqlarini olmaydi.', allTools: 'Kengaytirilgan sozlamalar', empty: 'Hech narsa topilmadi', close: 'Yopish', back: 'Orqaga', footer: 'Nemo imkoniyatlarni ish stoliga emas, vazifaga ulaydi.',
  },
  en: {
    tabs: { skills: 'Skills', connectors: 'Connections', plugins: 'Plugins' },
    eyebrow: 'Capability directory', subtitle: 'Everything agents can use while working.', search: 'Find a skill, service, or plugin…',
    connectorIntro: 'Everyday tasks work without external services. When an agent needs a file, calendar, CRM, or channel, Nemo asks for access at the moment of use.',
    access: 'Available actions', authTitle: 'Access only when requested', authText: 'Nemo connects a service only after your action. Secrets stay on the server and never reach the frontend.', setup: 'Configure connection',
    skillsTitle: 'Skills are ready for agents', skillsText: 'Choose skills in each agent’s settings. Uploaded skills remain private.', addSkill: 'Configure skills',
    pluginsTitle: 'Verified plugins', pluginsText: 'HTTPS and MCP connections are checked before saving. Plugins do not receive server permissions automatically.', allTools: 'Advanced settings', empty: 'No results found', close: 'Close', back: 'Back', footer: 'Nemo attaches capabilities to a task instead of cluttering your workspace.',
  },
}

export function CapabilityDirectory({ open, onClose, initialTab = 'connectors' }: { open: boolean; onClose: () => void; initialTab?: DirectoryTab }) {
  const { t, lang } = useI18n()
  const copy = COPY[lang]
  const [tab, setTab] = useState<DirectoryTab>(initialTab)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const selected = useMemo(() => CONNECTORS.find((item) => item.id === selectedId) ?? null, [selectedId])
  const connectors = useMemo(() => CONNECTORS.filter((item) => `${item.title} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase())), [query])
  const skills = useMemo(() => AGENT_SKILLS.filter((skill) => `${t(`agentEdit.skill_${skill.id}`)} ${t(`agentEdit.skill_${skill.id}Desc`)}`.toLowerCase().includes(query.trim().toLowerCase())), [query, t])
  const tabs = (Object.keys(TAB_ICONS) as DirectoryTab[]).map((id) => ({ id, title: copy.tabs[id], icon: TAB_ICONS[id], count: id === 'skills' ? AGENT_SKILLS.length : id === 'connectors' ? CONNECTORS.length : undefined }))
  const closeDirectory = useCallback(() => { setSelectedId(null); setQuery(''); onClose() }, [onClose])

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') closeDirectory() }
    window.addEventListener('keydown', closeOnEscape)
    return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', closeOnEscape) }
  }, [closeDirectory, open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[#07101f]/75 p-0 backdrop-blur-md sm:p-5" role="dialog" aria-modal="true" aria-label="Nemo Directory">
      <button className="absolute inset-0 cursor-default" onClick={closeDirectory} aria-label={copy.close} />
      <div className="relative grid h-full w-full overflow-hidden bg-panel shadow-[0_28px_90px_rgba(5,12,28,.45)] sm:h-[min(760px,calc(100dvh-2.5rem))] sm:max-w-6xl sm:grid-cols-[14rem_minmax(0,1fr)] sm:rounded-[1.75rem] sm:border sm:border-white/10">
        <aside className="hidden border-r border-ice/10 bg-black/[0.12] px-3 py-5 sm:flex sm:flex-col">
          <div className="px-3"><p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan">{copy.eyebrow}</p><h2 className="mt-1 text-xl font-semibold tracking-tight text-text">Directory</h2><p className="mt-2 text-xs leading-5 text-muted">{copy.subtitle}</p></div>
          <nav className="mt-7 space-y-1" aria-label="Directory">
            {tabs.map((item) => <button key={item.id} onClick={() => { setTab(item.id); setSelectedId(null); setQuery('') }} className={cn('group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium transition duration-200 active:scale-[0.98]', tab === item.id ? 'bg-white/[0.09] text-text shadow-inner shadow-white/[0.03]' : 'text-muted hover:bg-white/[0.045] hover:text-text')}><item.icon size={17} className={tab === item.id ? 'text-cyan' : 'text-fog group-hover:text-muted'} /><span className="flex-1">{item.title}</span>{item.count !== undefined && <span className="text-[10px] tabular-nums text-fog">{item.count}</span>}</button>)}
          </nav>
          <p className="mt-auto px-3 text-[11px] leading-5 text-fog">{copy.footer}</p>
        </aside>

        <section className="min-w-0 overflow-y-auto">
          <header className="sticky top-0 z-10 border-b border-ice/10 bg-panel/95 px-4 py-4 backdrop-blur-xl sm:px-7">
            <div className="flex items-center justify-between gap-4"><div className="flex min-w-0 items-center gap-2">{selected && <button onClick={() => setSelectedId(null)} className="rounded-xl p-2 text-muted transition hover:bg-white/5 hover:text-text" aria-label={copy.back}><ChevronLeft size={19} /></button>}<div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-fog sm:hidden">Directory</p><h3 className="truncate text-lg font-semibold tracking-tight text-text">{selected?.title ?? copy.tabs[tab]}</h3></div></div><button onClick={closeDirectory} className="rounded-xl border border-transparent p-2 text-muted transition hover:border-ice/10 hover:bg-white/5 hover:text-text active:scale-95" aria-label={copy.close}><X size={19} /></button></div>
            {!selected && tab !== 'plugins' && <label className="relative mt-4 block"><Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-fog" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.search} className="w-full rounded-xl border border-ice/10 bg-black/10 py-2.5 pl-10 pr-3 text-sm text-text outline-none transition placeholder:text-fog focus:border-cyan/40 focus:ring-2 focus:ring-cyan/10" /></label>}
            {!selected && <div className="mt-3 flex gap-1 overflow-x-auto sm:hidden">{tabs.map((item) => <button key={item.id} onClick={() => { setTab(item.id); setQuery('') }} className={cn('shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium', tab === item.id ? 'bg-cyan/10 text-text' : 'text-muted')}>{item.title}</button>)}</div>}
          </header>

          <div className="p-4 pb-10 sm:p-7 sm:pb-12">
            {tab === 'connectors' && !selected && <><div className="rounded-2xl border border-cyan/15 bg-cyan/[0.045] px-4 py-3.5 text-sm leading-6 text-muted">{copy.connectorIntro}</div>{connectors.length ? <div className="mt-5 grid gap-3 md:grid-cols-2">{connectors.map((item) => <button key={item.id} onClick={() => setSelectedId(item.id)} className="group flex min-h-28 items-start gap-3 rounded-2xl bg-white/[0.035] p-4 text-left ring-1 ring-inset ring-white/[0.07] transition duration-200 hover:-translate-y-0.5 hover:bg-white/[0.065] hover:ring-cyan/25 active:translate-y-0"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: `${item.color}1f`, color: item.color }}><Blocks size={18} /></span><span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-text">{item.title}</span><span className="mt-1.5 block text-xs leading-5 text-muted">{item.description}</span></span><span className="rounded-lg p-2 text-fog transition group-hover:bg-cyan/10 group-hover:text-cyan"><Plus size={15} /></span></button>)}</div> : <EmptyDirectory text={copy.empty} />}</>}

            {tab === 'connectors' && selected && <div className="mx-auto max-w-3xl"><div className="flex items-start gap-4"><span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl" style={{ background: `${selected.color}1f`, color: selected.color }}><Blocks size={22} /></span><div><h4 className="text-xl font-semibold tracking-tight text-text">{selected.title}</h4><p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{selected.description}</p></div></div><div className="mt-7 border-t border-ice/10 pt-5"><p className="text-sm font-semibold text-text">{copy.access}</p><div className="mt-3 flex flex-wrap gap-2">{selected.tools.map((tool) => <span key={tool} className="rounded-lg bg-white/[0.045] px-2.5 py-1.5 font-mono text-[11px] text-muted ring-1 ring-inset ring-white/[0.07]">{tool}</span>)}</div></div><div className="mt-6 rounded-2xl border border-teal/15 bg-teal/[0.045] p-4"><p className="flex items-center gap-2 text-sm font-semibold text-text"><ShieldCheck size={16} className="text-teal" />{copy.authTitle}</p><p className="mt-1.5 text-xs leading-5 text-muted">{copy.authText}</p></div><div className="mt-6"><IntegrationCenter focusProvider={selected.provider} /></div></div>}

            {tab === 'skills' && <><div className="flex flex-col gap-4 rounded-2xl border border-violet/15 bg-violet/[0.04] p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-semibold text-text">{copy.skillsTitle}</p><p className="mt-1 max-w-2xl text-xs leading-5 text-muted">{copy.skillsText}</p></div><Link to="/app/agents" onClick={closeDirectory} className="btn shrink-0 bg-brand px-3 py-2 text-xs text-white"><Plus size={14} />{copy.addSkill}</Link></div>{skills.length ? <div className="mt-5 grid gap-3 md:grid-cols-2">{skills.map((skill) => <article key={skill.id} className="rounded-2xl bg-white/[0.035] p-4 ring-1 ring-inset ring-white/[0.07]"><span className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: `${skill.color}1f`, color: skill.color }}><skill.icon size={16} /></span><p className="mt-3 text-sm font-semibold text-text">{t(`agentEdit.skill_${skill.id}`)}</p><p className="mt-1 text-xs leading-5 text-muted">{t(`agentEdit.skill_${skill.id}Desc`)}</p></article>)}</div> : <EmptyDirectory text={copy.empty} />}</>}

            {tab === 'plugins' && <div><div className="mb-5 rounded-2xl border border-amber/15 bg-amber/[0.04] p-4"><p className="flex items-center gap-2 text-sm font-semibold text-text"><Wrench size={16} className="text-amber" />{copy.pluginsTitle}</p><p className="mt-1.5 max-w-3xl text-xs leading-5 text-muted">{copy.pluginsText}</p></div><CustomToolsManager /></div>}
          </div>
        </section>
      </div>
    </div>
  )
}

function EmptyDirectory({ text }: { text: string }) {
  return <div className="mt-8 rounded-2xl border border-dashed border-ice/10 px-4 py-12 text-center text-sm text-muted">{text}</div>
}
