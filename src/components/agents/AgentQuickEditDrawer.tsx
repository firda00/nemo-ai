import { useState, type ReactNode } from 'react'
import { ArrowUpRight, Check, SlidersHorizontal, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { MODELS } from '../../data/platform'
import { useI18n } from '../../i18n'
import type { PlatformAgent } from '../../types/platform'
import { Button } from '../ui/Button'

export type AgentQuickEditDraft = Pick<PlatformAgent, 'name' | 'role' | 'model' | 'temperature' | 'language' | 'actionPolicy'> & {
  tasks: string
  tone: string
  rules: string
}

const copy = {
  ru: {
    eyebrow: 'Быстрая настройка', title: 'Настройки агента', subtitle: 'Главное — в одном окне. Каналы, знания и тесты остаются в полном редакторе.',
    name: 'Имя', role: 'Роль', model: 'Модель', language: 'Язык', tasks: 'Что должен делать', tone: 'Тон общения', rules: 'Ограничения',
    action: 'Внешние действия', approval: 'Только после согласования', readOnly: 'Только чтение', temperature: 'Вариативность',
    cancel: 'Отмена', save: 'Сохранить', saving: 'Сохраняю…', saved: 'Сохранено', advanced: 'Полные настройки', required: 'Укажите имя и задачу агента.',
  },
  uz: {
    eyebrow: 'Tezkor sozlash', title: 'Agent sozlamalari', subtitle: 'Asosiy sozlamalar bir oynada. Kanallar, bilimlar va testlar to‘liq muharrirda.',
    name: 'Nomi', role: 'Roli', model: 'Model', language: 'Til', tasks: 'Nima qilishi kerak', tone: 'Muloqot ohangi', rules: 'Cheklovlar',
    action: 'Tashqi amallar', approval: 'Faqat tasdiqdan keyin', readOnly: 'Faqat o‘qish', temperature: 'Variativlik',
    cancel: 'Bekor qilish', save: 'Saqlash', saving: 'Saqlanmoqda…', saved: 'Saqlandi', advanced: 'To‘liq sozlamalar', required: 'Agent nomi va vazifasini kiriting.',
  },
  en: {
    eyebrow: 'Quick edit', title: 'Agent settings', subtitle: 'Core settings in one place. Channels, knowledge and evaluations remain in the full editor.',
    name: 'Name', role: 'Role', model: 'Model', language: 'Language', tasks: 'What this agent does', tone: 'Communication tone', rules: 'Boundaries',
    action: 'External actions', approval: 'Approval required', readOnly: 'Read only', temperature: 'Variation',
    cancel: 'Cancel', save: 'Save', saving: 'Saving…', saved: 'Saved', advanced: 'Full settings', required: 'Enter an agent name and task.',
  },
} as const

const inputClass = 'w-full rounded-xl border border-ice/10 bg-bg/70 px-3 py-2.5 text-sm text-text outline-none transition placeholder:text-fog focus:border-cyan/45 focus:ring-2 focus:ring-cyan/10'

function toDraft(agent: PlatformAgent): AgentQuickEditDraft {
  return {
    name: agent.name,
    role: agent.role,
    model: agent.model,
    temperature: agent.temperature,
    language: agent.language,
    actionPolicy: agent.actionPolicy ?? 'approval_required',
    tasks: agent.prompt.tasks,
    tone: agent.prompt.tone,
    rules: agent.prompt.rules,
  }
}

export function AgentQuickEditDrawer({
  agent,
  onClose,
  onSave,
}: {
  agent: PlatformAgent | null
  onClose: () => void
  onSave: (agent: PlatformAgent, draft: AgentQuickEditDraft) => Promise<{ error?: string }>
}) {
  if (!agent) return null

  return <AgentQuickEditForm key={agent.id} agent={agent} onClose={onClose} onSave={onSave} />
}

function AgentQuickEditForm({
  agent,
  onClose,
  onSave,
}: {
  agent: PlatformAgent
  onClose: () => void
  onSave: (agent: PlatformAgent, draft: AgentQuickEditDraft) => Promise<{ error?: string }>
}) {
  const { lang } = useI18n()
  const c = copy[lang]
  const [draft, setDraft] = useState<AgentQuickEditDraft>(() => toDraft(agent))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const update = <K extends keyof AgentQuickEditDraft>(key: K, value: AgentQuickEditDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setSaved(false)
    setError('')
  }

  const save = async () => {
    if (!draft.name.trim() || !draft.tasks.trim()) {
      setError(c.required)
      return
    }
    setSaving(true)
    const result = await onSave(agent, draft)
    setSaving(false)
    if (result.error) {
      setError(result.error)
      return
    }
    setSaved(true)
  }

  return (
    <div className="fixed inset-0 z-[80]" role="dialog" aria-modal="true" aria-labelledby="quick-agent-title">
      <button type="button" className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} aria-label={c.cancel} />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col border-l border-ice/10 bg-panel shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-ice/10 px-5 py-5 sm:px-7">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan">{c.eyebrow}</p>
            <h2 id="quick-agent-title" className="mt-1 text-xl font-semibold tracking-tight text-text">{c.title}</h2>
            <p className="mt-1 max-w-md text-xs leading-5 text-muted">{c.subtitle}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-xl p-2 text-muted transition hover:bg-white/5 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/40" aria-label={c.cancel}><X size={19} /></button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-6 sm:px-7">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={c.name}><input value={draft.name} onChange={(event) => update('name', event.target.value)} className={inputClass} /></Field>
            <Field label={c.role}><input value={draft.role} onChange={(event) => update('role', event.target.value)} className={inputClass} /></Field>
            <Field label={c.model}>
              <select value={draft.model} onChange={(event) => update('model', event.target.value)} className={inputClass}>
                {MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
              </select>
            </Field>
            <Field label={c.language}>
              <select value={draft.language} onChange={(event) => update('language', event.target.value as AgentQuickEditDraft['language'])} className={inputClass}>
                <option value="auto">Auto</option><option value="uz">O‘zbek</option><option value="ru">Русский</option><option value="en">English</option>
              </select>
            </Field>
          </div>

          <Field label={c.tasks}><textarea value={draft.tasks} onChange={(event) => update('tasks', event.target.value)} rows={5} className={`${inputClass} resize-y leading-6`} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={c.tone}><textarea value={draft.tone} onChange={(event) => update('tone', event.target.value)} rows={3} className={`${inputClass} resize-y`} /></Field>
            <Field label={c.rules}><textarea value={draft.rules} onChange={(event) => update('rules', event.target.value)} rows={3} className={`${inputClass} resize-y`} /></Field>
          </div>

          <div className="rounded-2xl border border-ice/10 bg-black/10 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-text"><SlidersHorizontal size={15} className="text-cyan" />{c.action}</div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {(['approval_required', 'read_only'] as const).map((policy) => (
                <button key={policy} type="button" onClick={() => update('actionPolicy', policy)} className={`rounded-xl border px-3 py-2.5 text-left text-xs transition ${draft.actionPolicy === policy ? 'border-cyan/35 bg-cyan/10 text-text' : 'border-ice/10 text-muted hover:border-ice/20'}`}>
                  {policy === 'approval_required' ? c.approval : c.readOnly}
                </button>
              ))}
            </div>
            <label className="mt-4 block text-xs text-muted">{c.temperature}: <span className="font-mono text-text">{draft.temperature.toFixed(1)}</span>
              <input type="range" min="0" max="1" step="0.1" value={draft.temperature} onChange={(event) => update('temperature', Number(event.target.value))} className="mt-2 w-full accent-cyan" />
            </label>
          </div>

          {error && <p role="alert" className="rounded-xl border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-ice/10 bg-panel/95 px-5 py-4 sm:px-7">
          <Link to={`/app/agents/${agent.id}`} className="inline-flex items-center gap-1.5 text-xs font-medium text-muted transition hover:text-text">{c.advanced}<ArrowUpRight size={13} /></Link>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>{c.cancel}</Button>
            <Button size="sm" onClick={() => void save()} disabled={saving}>{saved ? <Check size={14} /> : null}{saving ? c.saving : saved ? c.saved : c.save}</Button>
          </div>
        </footer>
      </aside>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>{children}</label>
}
