import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowUp, Loader2, Bot, Save, RotateCcw, Send } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { blankAgent, useAgentStore } from '../../store/useAgentStore'
import { MODELS } from '../../data/platform'
import { useI18n } from '../../i18n'
import type { AgentKind, AgentLang, PlatformAgent } from '../../types/platform'

interface Composed {
  name: string
  type: AgentKind
  role: string
  tasks: string
  tone: string
  rules: string
  lang: AgentLang
}

/**
 * Single-agent counterpart to AutonomousRunner: describe ONE agent in words -> the
 * compose-agent function writes its full config -> preview -> create it as a real,
 * reusable agent (opens the editor, where it can be connected to Telegram/website).
 */
export function SingleAgentRunner() {
  const { t, lang } = useI18n()
  const navigate = useNavigate()
  const addAgent = useAgentStore((s) => s.addAgent)
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [agent, setAgent] = useState<Composed | null>(null)

  const compose = async () => {
    if (desc.trim().length < 8 || busy) return
    setError(''); setBusy(true); setAgent(null)
    try {
      if (!isSupabaseEnabled || !supabase) { setError(t('singleAgent.errSignIn')); return }
      const { data, error: err } = await supabase.functions.invoke('compose-agent', {
        body: { description: desc.trim(), ui_lang: lang },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = data as any
      if (err || !p?.ok || !p.agent) { setError(t('singleAgent.errCompose')); return }
      const a = p.agent
      setAgent({
        name: a.name ?? 'AI agent',
        type: (a.type as AgentKind) ?? 'chat',
        role: a.prompt?.role ?? '',
        tasks: a.prompt?.tasks ?? '',
        tone: a.prompt?.tone ?? '',
        rules: a.prompt?.rules ?? '',
        lang: (a.default_lang as AgentLang) ?? 'auto',
      })
    } finally { setBusy(false) }
  }

  const create = async () => {
    if (!agent || saving) return
    setSaving(true); setError('')
    try {
      const draft: PlatformAgent = {
        ...blankAgent(),
        name: agent.name,
        type: agent.type,
        role: agent.role,
        model: MODELS[0]?.id ?? 'openai/gpt-4o-mini',
        language: agent.lang,
        purpose: agent.tasks,
        status: 'active',
        channels: ['telegram', 'widget'],
        prompt: { role: agent.role, tasks: agent.tasks, tone: agent.tone, rules: agent.rules },
      }
      const res = await addAgent(draft)
      if (res.error) { setError(res.error); return }
      navigate(res.id ? `/app/agents/${res.id}` : '/app/agents')
    } finally { setSaving(false) }
  }

  const reset = () => { setAgent(null); setDesc(''); setError('') }

  return (
    <div>
      <div className="glass flex items-end gap-2 rounded-2xl p-2 focus-within:border-violet/50 focus-within:shadow-glow">
        <textarea
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) compose() }}
          rows={2}
          disabled={busy}
          placeholder={t('singleAgent.placeholder')}
          className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-text outline-none placeholder:text-muted/70"
        />
        <button onClick={compose} disabled={busy || desc.trim().length < 8} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-white transition disabled:opacity-40">
          {busy ? <Loader2 size={18} className="animate-spin" /> : <ArrowUp size={18} />}
        </button>
      </div>
      {error && <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-center text-xs text-danger">{error}</p>}

      {busy && (
        <div className="card mt-5 flex items-center gap-3 rounded-2xl p-5">
          <Loader2 size={18} className="animate-spin text-violet" />
          <p className="text-sm font-medium text-text">{t('singleAgent.composing')}</p>
        </div>
      )}

      {agent && !busy && (
        <div className="card mt-5 rounded-2xl p-5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-violet/15 text-violet"><Bot size={16} /></span>
            <input
              value={agent.name}
              onChange={(e) => setAgent({ ...agent, name: e.target.value })}
              className="flex-1 rounded-lg border border-transparent bg-transparent px-1 py-1 text-base font-semibold text-text outline-none hover:border-ice/10 focus:border-violet/40"
            />
            <span className="shrink-0 rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-muted">{agent.type}</span>
          </div>

          <dl className="mt-4 space-y-3 text-sm">
            <div><dt className="text-xs uppercase tracking-wide text-muted">{t('singleAgent.role')}</dt><dd className="mt-0.5 text-text">{agent.role || '—'}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-muted">{t('singleAgent.tasks')}</dt><dd className="mt-0.5 whitespace-pre-wrap leading-relaxed text-muted">{agent.tasks || '—'}</dd></div>
            <div className="flex flex-wrap gap-x-8 gap-y-3">
              <div><dt className="text-xs uppercase tracking-wide text-muted">{t('singleAgent.tone')}</dt><dd className="mt-0.5 text-muted">{agent.tone || '—'}</dd></div>
              {agent.rules && <div className="min-w-[12rem] flex-1"><dt className="text-xs uppercase tracking-wide text-muted">{t('singleAgent.rules')}</dt><dd className="mt-0.5 text-muted">{agent.rules}</dd></div>}
            </div>
          </dl>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button onClick={create} disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition disabled:opacity-40">
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {t('singleAgent.create')}
            </button>
            <button onClick={reset} className="inline-flex items-center gap-1.5 rounded-xl border border-ice/12 px-3 py-2 text-sm font-medium text-muted transition hover:text-text">
              <RotateCcw size={14} /> {t('singleAgent.again')}
            </button>
          </div>
          <p className="mt-3 flex items-center gap-1.5 text-[12px] text-muted"><Send size={13} className="text-cyan" /> {t('singleAgent.afterHint')}</p>
        </div>
      )}
    </div>
  )
}
