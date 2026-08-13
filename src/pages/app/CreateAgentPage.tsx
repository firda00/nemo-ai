import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bot, CheckCircle2, Save, Sparkles, Loader2 } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { TestChat } from '../../components/platform/TestChat'
import { useToast } from '../../components/ui/Toast'
import { MODELS, kindPresets } from '../../data/platform'
import { blankAgent, useAgentStore } from '../../store/useAgentStore'
import { isSupabaseEnabled, supabase } from '../../lib/supabase'
import type { AgentActionPolicy, AgentKind, AgentLang, PlatformAgent } from '../../types/platform'

const fieldCls = 'w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-violet/50'

const agentTypes: { label: string; value: AgentKind; role: string; tasks: string; tone: string }[] = [
  { label: 'General Agent', value: 'chat', role: 'General business assistant', tasks: 'Answer questions, complete tasks, and escalate when unsure.', tone: 'Clear, helpful, concise.' },
  { label: 'Sales Agent', value: 'qualifier', role: 'Sales consultant', tasks: 'Qualify leads, recommend offers, collect contact details, and prepare next actions.', tone: 'Friendly, confident, respectful.' },
  { label: 'Support Agent', value: 'chat', role: 'Customer support specialist', tasks: 'Answer FAQs, troubleshoot issues, and prepare handoff to a human.', tone: 'Patient, calm, precise.' },
  { label: 'Content Agent', value: 'content', role: 'Content marketer', tasks: 'Create posts, scripts, emails, captions, and campaign ideas.', tone: 'On-brand, practical, creative.' },
  { label: 'Research Agent', value: 'research', role: 'Research specialist', tasks: 'Research a topic, structure findings, cite sources when available.', tone: 'Factual, concise, analytical.' },
  { label: 'Coder Agent', value: 'coder', role: 'Software engineering assistant', tasks: 'Write code, debug issues, explain implementation and tests.', tone: 'Technical, direct, careful.' },
  { label: 'Learning Agent', value: 'learning', role: 'Learning assistant', tasks: 'Help users learn, adapt to prior context, and explain step by step.', tone: 'Supportive and clear.' },
  { label: 'Manager Agent', value: 'workflow', role: 'Team Lead Agent', tasks: 'Plan work, route tasks to specialists, review output and summarize results.', tone: 'Structured, business-focused.' },
  { label: 'Reviewer Agent', value: 'chat', role: 'Quality reviewer', tasks: 'Review outputs, find gaps, improve clarity, and check risks.', tone: 'Critical but constructive.' },
]

const pilotTemplates = [
  {
    id: 'ustudy-course-consultant',
    name: 'Sales Consultant',
    type: 'qualifier' as AgentKind,
    role: 'AI Sales Consultant',
    tasks: 'Recommend products or services based on customer goals, budget, and language preference. Collect contact details and next actions.',
    tone: 'Professional, friendly, and solution-oriented.',
  },
]

export default function CreateAgentPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const addAgent = useAgentStore((s) => s.addAgent)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [name, setName] = useState('Sales Consultant')
  const [type, setType] = useState<AgentKind>('qualifier')
  const [role, setRole] = useState(pilotTemplates[0].role)
  const [tasks, setTasks] = useState(pilotTemplates[0].tasks)
  const [tone, setTone] = useState(pilotTemplates[0].tone)
  const [rules, setRules] = useState('Do not invent prices. If information is missing, ask one short question and offer human handoff.')
  const [language, setLanguage] = useState<AgentLang>('auto')
  const [model, setModel] = useState(MODELS[0]?.id ?? 'openai/gpt-4o-mini')
  const [actionPolicy, setActionPolicy] = useState<AgentActionPolicy>('approval_required')
  const [knowledge, setKnowledge] = useState('Company services, price lists, team members, integrations, and lead details.')
  // AI composer — describe the business once, AI writes name/role/tasks/tone/rules.
  const [aiDesc, setAiDesc] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')

  useEffect(() => {
    try {
      const selected = JSON.parse(localStorage.getItem('nemo-selected-agent-template') || 'null') as null | typeof pilotTemplates[number]
      if (!selected) return
      window.setTimeout(() => {
        setName(selected.name)
        setType(selected.type)
        setRole(selected.role)
        setTasks(selected.tasks)
        setTone(selected.tone)
      }, 0)
      localStorage.removeItem('nemo-selected-agent-template')
    } catch {
      localStorage.removeItem('nemo-selected-agent-template')
    }
  }, [])

  const draft = useMemo<PlatformAgent>(() => ({
    ...blankAgent(),
    name,
    type,
    role,
    model,
    language,
    purpose: tasks,
    niche: 'Education / IT Academy',
    status: 'draft',
    actionPolicy,
    channels: ['telegram', 'widget'],
    prompt: { role, tasks: `${tasks}\n\nKnowledge source: ${knowledge}`, tone, rules },
  }), [actionPolicy, knowledge, language, model, name, role, rules, tasks, tone, type])

  const applyType = (value: AgentKind) => {
    const preset = agentTypes.find((x) => x.value === value)
    setType(value)
    if (preset) {
      setRole(preset.role)
      setTasks(kindPresets[value]?.tasks || preset.tasks)
      setTone(kindPresets[value]?.tone || preset.tone)
      setRules(kindPresets[value]?.rules || rules)
    }
  }

  // Describe the business -> the compose-agent function writes the whole config.
  const composeWithAI = async () => {
    if (aiDesc.trim().length < 8 || aiBusy) return
    setAiError('')
    setAiBusy(true)
    try {
      if (!isSupabaseEnabled || !supabase) {
        setAiError('Sign in to the live backend to use AI compose.')
        return
      }
      const { data, error: err } = await supabase.functions.invoke('compose-agent', {
        body: { description: aiDesc.trim(), ui_lang: language !== 'auto' ? language : undefined },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload = data as any
      if (err || !payload?.ok || !payload.agent) {
        setAiError('AI could not compose the agent — check sign-in and token balance.')
        return
      }
      const a = payload.agent
      if (a.name) setName(a.name)
      if (a.type) setType(a.type as AgentKind)
      if (a.prompt?.role) setRole(a.prompt.role)
      if (a.prompt?.tasks) setTasks(a.prompt.tasks)
      if (a.prompt?.tone) setTone(a.prompt.tone)
      if (a.prompt?.rules) setRules(a.prompt.rules)
      if (a.default_lang) setLanguage(a.default_lang as AgentLang)
      // keep the reliable model default (don't downgrade to a free model)
      toast('AI filled the fields — review and save.')
    } finally {
      setAiBusy(false)
    }
  }

  const save = async () => {
    setError('')
    if (!name.trim()) { setError('Agent name is required.'); return }
    if (name.trim().length > 120) { setError('Agent name must be 120 characters or fewer.'); return }
    const result = await addAgent(draft)
    if (result.error) {
      setError(result.error)
      return
    }
    setSaved(true)
    toast('Agent created — opening it now.')
    navigate(result.id ? `/app/agents/${result.id}` : '/app/agents')
  }

  return (
    <div className="container-page max-w-7xl py-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="mono-label">Single Agent Builder</p>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-text">Create standalone AI agent</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">Create a normal AI employee: sales, support, content, research, coder, learning, manager or reviewer.</p>
          <span className={`mt-3 inline-flex rounded-pill border px-3 py-1 text-xs font-medium ${isSupabaseEnabled ? 'border-teal/20 bg-teal/10 text-teal' : 'border-amber/25 bg-amber/10 text-amber'}`}>{isSupabaseEnabled ? 'Live backend configured' : 'Demo mode · localStorage save · local simulation test chat'}</span>
        </div>
        <Button onClick={save}><Save size={16} /> Save agent</Button>
      </div>

      <div className="mt-8 grid gap-6 xl:grid-cols-[1fr_0.85fr]">
        <section className="card rounded-3xl p-6">
          {/* AI composer — fill the fields from one description (fields stay editable below) */}
          <div className="mb-5 rounded-2xl border border-violet/20 bg-violet/[0.05] p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-text"><Sparkles size={16} className="text-violet" /> Describe your business — AI fills the fields</p>
            <textarea
              value={aiDesc}
              onChange={(e) => setAiDesc(e.target.value)}
              rows={2}
              placeholder="e.g. SaaS company with Startup and Enterprise plans — answer pricing questions, qualify leads, and collect phone numbers."
              className={`${fieldCls} mt-2.5 resize-y`}
            />
            {aiError && <p className="mt-2 text-xs text-danger">{aiError}</p>}
            <div className="mt-2.5 flex justify-end">
              <Button size="sm" variant="secondary" onClick={composeWithAI} disabled={aiBusy || aiDesc.trim().length < 8}>
                {aiBusy ? <><Loader2 size={14} className="animate-spin" /> Composing…</> : <><Sparkles size={14} /> Fill with AI</>}
              </Button>
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="min-w-0 space-y-1.5"><span className="text-xs text-muted">Agent name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className={fieldCls} /><span className="block text-right text-[10px] text-muted">{name.length}/120</span></label>
            <label className="space-y-1.5"><span className="text-xs text-muted">Agent type</span><select value={type} onChange={(e) => applyType(e.target.value as AgentKind)} className={fieldCls}>{agentTypes.map((item) => <option key={item.label} value={item.value}>{item.label}</option>)}</select></label>
            <label className="space-y-1.5"><span className="text-xs text-muted">Language</span><select value={language} onChange={(e) => setLanguage(e.target.value as AgentLang)} className={fieldCls}><option value="auto">Auto</option><option value="en">English</option><option value="ru">Russian</option><option value="uz">Uzbek</option></select></label>
            <label className="space-y-1.5"><span className="text-xs text-muted">Model</span><select value={model} onChange={(e) => setModel(e.target.value)} className={fieldCls}>{MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
          </div>
          <label className="mt-4 block space-y-1.5"><span className="text-xs text-muted">Role</span><input value={role} onChange={(e) => setRole(e.target.value)} className={fieldCls} /></label>
          <label className="mt-4 block space-y-1.5"><span className="text-xs text-muted">Tasks</span><textarea value={tasks} onChange={(e) => setTasks(e.target.value)} rows={5} className={`${fieldCls} resize-y`} /></label>
          <label className="mt-4 block space-y-1.5"><span className="text-xs text-muted">Tone</span><input value={tone} onChange={(e) => setTone(e.target.value)} className={fieldCls} /></label>
           <label className="mt-4 block space-y-1.5"><span className="text-xs text-muted">Prompt rules</span><textarea value={rules} onChange={(e) => setRules(e.target.value)} rows={3} className={`${fieldCls} resize-y`} /></label>
           <label className="mt-4 block space-y-1.5"><span className="text-xs text-muted">Action policy</span><select value={actionPolicy} onChange={(e) => setActionPolicy(e.target.value as AgentActionPolicy)} className={fieldCls}><option value="read_only">Read-only: analyze without external changes</option><option value="approval_required">Draft + owner approval: queue every external action</option></select><span className="block text-xs text-muted">Automatic execution is unavailable until Nemo has a verified executor and audit result.</span></label>
           <label className="mt-4 block space-y-1.5"><span className="text-xs text-muted">Knowledge source</span><textarea value={knowledge} onChange={(e) => setKnowledge(e.target.value)} rows={3} className={`${fieldCls} resize-y`} /></label>
          {error && <p className="mt-4 rounded-2xl border border-danger/25 bg-danger/10 p-3 text-sm text-danger">{error}</p>}
          {saved && <p className="mt-4 flex items-center gap-2 text-sm text-teal"><CheckCircle2 size={16} /> Agent saved.</p>}
        </section>
        <section>
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-text"><Bot size={17} className="text-cyan" /> Test chat</div>
          <TestChat agent={draft} />
        </section>
      </div>
    </div>
  )
}
