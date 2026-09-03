import { useMemo, useState } from 'react'
import { Blocks, ChevronLeft, ExternalLink, KeyRound, Link2, Plug, Plus, ShieldCheck, Sparkles, Wrench, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { AGENT_SKILLS } from '../../data/agentSkills'
import { useI18n } from '../../i18n'
import { GoogleSetup } from './GoogleSetup'
import { CustomToolsManager } from './CustomToolsManager'
import { cn } from '../../lib/cn'

type DirectoryTab = 'skills' | 'connectors' | 'plugins'

interface ConnectorItem {
  id: string
  title: string
  description: string
  tools: string[]
  auth: 'oauth' | 'key' | 'setup'
  href?: string
  color: string
}

const CONNECTORS: ConnectorItem[] = [
  { id: 'google', title: 'Google Workspace', description: 'Drive, Gmail, Calendar и Sheets для рабочих задач агента.', tools: ['search_files', 'read_file', 'send_draft', 'calendar_read', 'sheet_read'], auth: 'oauth', color: '#4285F4' },
  { id: 'telegram', title: 'Telegram', description: 'Несколько ботов, входящие диалоги, публикации и воронки.', tools: ['receive_message', 'send_message', 'schedule_post'], auth: 'setup', href: '/app/settings?tab=integrations&section=services&integration=telegram', color: '#2AABEE' },
  { id: 'hubspot', title: 'HubSpot', description: 'Контакты, сделки и безопасная передача лидов в CRM.', tools: ['find_contact', 'create_contact', 'create_deal'], auth: 'key', href: '/app/settings?tab=integrations&section=skills&integration=hubspot', color: '#FF7A59' },
  { id: 'notion', title: 'Notion', description: 'Поиск и чтение рабочих страниц по запросу агента.', tools: ['search_pages', 'read_page'], auth: 'key', href: '/app/settings?tab=integrations&section=skills&integration=notion', color: '#EAECF6' },
  { id: 'slack', title: 'Slack', description: 'Чтение каналов и подготовка сообщений с подтверждением.', tools: ['search_messages', 'read_thread', 'draft_message'], auth: 'key', href: '/app/settings?tab=integrations&section=skills&integration=slack', color: '#36C5F0' },
  { id: 'browser', title: 'Browser agent', description: 'Открывает публичные страницы и выполняет ограниченную задачу.', tools: ['open_page', 'extract_text', 'complete_task'], auth: 'setup', href: '/app/settings?tab=integrations&section=skills#browser-agent', color: '#22D3EE' },
]

const TAB_META: Array<{ id: DirectoryTab; title: string; icon: typeof Sparkles }> = [
  { id: 'skills', title: 'Skills', icon: Sparkles },
  { id: 'connectors', title: 'Connectors', icon: Link2 },
  { id: 'plugins', title: 'Plugins', icon: Plug },
]

export function CapabilityDirectory({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n()
  const [tab, setTab] = useState<DirectoryTab>('connectors')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = useMemo(() => CONNECTORS.find((item) => item.id === selectedId) ?? null, [selectedId])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Nemo Directory">
      <button className="absolute inset-0" onClick={onClose} aria-label="Закрыть Directory" />
      <div className="relative flex h-[min(760px,calc(100vh-1.5rem))] w-full max-w-6xl overflow-hidden rounded-3xl border border-white/10 bg-panel shadow-2xl">
        <aside className="hidden w-52 shrink-0 border-r border-white/10 bg-black/15 p-3 sm:block">
          <p className="px-3 py-3 text-lg font-semibold text-text">Directory</p>
          <div className="mt-3 space-y-1">
            {TAB_META.map((item) => (
              <button key={item.id} onClick={() => { setTab(item.id); setSelectedId(null) }} className={cn('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition', tab === item.id ? 'bg-white/10 text-text' : 'text-muted hover:bg-white/5 hover:text-text')}>
                <item.icon size={16} /> {item.title}
              </button>
            ))}
          </div>
        </aside>

        <section className="min-w-0 flex-1 overflow-y-auto">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/10 bg-panel/95 px-4 py-3 backdrop-blur sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              {selected && <button onClick={() => setSelectedId(null)} className="rounded-lg p-1.5 text-muted hover:bg-white/5 hover:text-text" aria-label="Назад"><ChevronLeft size={19} /></button>}
              <div>
                <h2 className="truncate text-lg font-semibold text-text">{selected?.title ?? TAB_META.find((item) => item.id === tab)?.title}</h2>
                <p className="mt-0.5 text-xs text-muted">Подключайте доступ только тогда, когда он нужен задаче.</p>
              </div>
            </div>
            <button onClick={onClose} className="rounded-lg p-2 text-muted hover:bg-white/5 hover:text-text" aria-label="Закрыть"><X size={19} /></button>
          </div>

          <div className="flex gap-1 overflow-x-auto border-b border-white/10 px-4 py-2 sm:hidden">
            {TAB_META.map((item) => <button key={item.id} onClick={() => { setTab(item.id); setSelectedId(null) }} className={cn('rounded-lg px-3 py-1.5 text-xs', tab === item.id ? 'bg-white/10 text-text' : 'text-muted')}>{item.title}</button>)}
          </div>

          <div className="p-4 sm:p-6">
            {tab === 'connectors' && !selected && (
              <>
                <div className="rounded-2xl border border-cyan/20 bg-cyan/[0.05] p-4 text-sm text-muted">
                  Обычные задачи работают без подключения сторонних сервисов. Если агенту понадобится файл, календарь, CRM или канал — Nemo покажет запрос доступа в момент использования.
                </div>
                <div className="mt-5 grid gap-3 md:grid-cols-2">
                  {CONNECTORS.map((item) => (
                    <button key={item.id} onClick={() => setSelectedId(item.id)} className="group flex min-h-28 items-start gap-3 rounded-2xl border border-white/10 bg-black/15 p-4 text-left transition hover:border-cyan/35 hover:bg-white/[0.04]">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: `${item.color}22`, color: item.color }}><Blocks size={18} /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-text">{item.title}</span>
                        <span className="mt-2 block text-xs leading-relaxed text-muted">{item.description}</span>
                      </span>
                      <span className="rounded-lg border border-white/10 p-2 text-muted transition group-hover:border-cyan/40 group-hover:text-cyan"><Plus size={15} /></span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {tab === 'connectors' && selected && (
              <div className="mx-auto max-w-3xl">
                <div className="flex items-start gap-4">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl" style={{ background: `${selected.color}22`, color: selected.color }}><Blocks size={22} /></span>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-xl font-semibold text-text">{selected.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted">{selected.description}</p>
                  </div>
                </div>
                <div className="mt-6 border-t border-white/10 pt-5">
                  <p className="text-sm font-semibold text-text">Доступные действия</p>
                  <div className="mt-3 flex flex-wrap gap-2">{selected.tools.map((tool) => <span key={tool} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-muted">{tool}</span>)}</div>
                </div>
                <div className="mt-6 rounded-2xl border border-teal/20 bg-teal/[0.05] p-4">
                  <p className="flex items-center gap-2 text-sm font-semibold text-text"><ShieldCheck size={16} className="text-teal" /> Авторизация по запросу</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted">Nemo не просит этот доступ заранее. Подключение понадобится только когда агент впервые вызовет действие этого сервиса. Секреты не передаются во frontend.</p>
                </div>
                <div className="mt-6">
                  {selected.id === 'google' ? <GoogleSetup /> : selected.href ? (
                    <Link to={selected.href} onClick={onClose} className="btn bg-brand px-4 py-2.5 text-sm text-white"><KeyRound size={15} /> Настроить подключение</Link>
                  ) : null}
                </div>
              </div>
            )}

            {tab === 'skills' && (
              <>
                <div className="flex flex-col gap-3 rounded-2xl border border-violet/20 bg-violet/[0.05] p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div><p className="text-sm font-semibold text-text">Skills работают без отдельной авторизации</p><p className="mt-1 text-xs text-muted">Загруженный skill остаётся приватным до проверки совместимости Nemo.</p></div>
                  <Link to="/app/agents" onClick={onClose} className="btn bg-brand px-3 py-2 text-xs text-white"><Plus size={14} /> Добавить skill</Link>
                </div>
                <div className="mt-5 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                  {AGENT_SKILLS.map((skill) => <div key={skill.id} className="rounded-2xl border border-white/10 bg-black/15 p-4"><span className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: `${skill.color}22`, color: skill.color }}><skill.icon size={16} /></span><p className="mt-3 text-sm font-semibold text-text">{t(`agentEdit.skill_${skill.id}`)}</p><p className="mt-1 text-xs leading-relaxed text-muted">{t(`agentEdit.skill_${skill.id}Desc`)}</p></div>)}
                </div>
              </>
            )}

            {tab === 'plugins' && (
              <div>
                <div className="mb-4 rounded-2xl border border-amber/20 bg-amber/[0.05] p-4">
                  <p className="flex items-center gap-2 text-sm font-semibold text-text"><Wrench size={16} className="text-amber" /> Проверяемые plugins</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted">Разрешены HTTPS/MCP подключения с проверкой до сохранения. Манифест не должен содержать секреты, а клиентский plugin не получает права сервера автоматически.</p>
                </div>
                <CustomToolsManager />
                <Link to="/app/settings?tab=integrations&section=skills" onClick={onClose} className="mt-4 inline-flex items-center gap-1.5 text-xs text-violet hover:underline">Все настройки инструментов <ExternalLink size={12} /></Link>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
