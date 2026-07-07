import { useMemo, useState } from 'react'
import { CheckCircle2, KeyRound, Lock, PlugZap, Save, ShieldCheck } from 'lucide-react'
import { Button } from '../../components/ui/Button'

const providers = [
  { id: 'openai', name: 'OpenAI', use: 'content, chat, image generation', placeholder: 'sk-...' },
  { id: 'anthropic', name: 'Anthropic', use: 'content, reasoning, support agents', placeholder: 'sk-ant-...' },
  { id: 'google', name: 'Google AI / Gemini', use: 'content, vision, multilingual', placeholder: 'AIza...' },
  { id: 'openrouter', name: 'OpenRouter', use: 'free/paid model routing', placeholder: 'sk-or-...' },
  { id: 'perplexity', name: 'Perplexity / Deep research', use: 'deep research with sources', placeholder: 'pplx-...' },
  { id: 'stability', name: 'Stability / Images', use: 'image generation', placeholder: 'sk-...' },
  { id: 'telegram', name: 'Telegram publishing', use: 'bot publishing and replies', placeholder: '123456789:AAH...' },
  { id: 'meta', name: 'Meta / Instagram', use: 'Instagram DM and publishing', placeholder: 'EAAG...' },
]

export default function ProvidersPage() {
  const [mode, setMode] = useState<'secrets' | 'provider_keys'>('secrets')
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('nemo-provider-status') || '{}') as Record<string, boolean>
    } catch {
      return {}
    }
  })
  const connectedCount = useMemo(() => Object.values(saved).filter(Boolean).length, [saved])

  const saveProvider = (id: string) => {
    if (!keys[id]?.trim()) return
    const next = { ...saved, [id]: true }
    setSaved(next)
    localStorage.setItem('nemo-provider-status', JSON.stringify(next))
    localStorage.setItem(`nemo-provider-key:${id}`, 'encrypted-demo-placeholder')
    setKeys((items) => ({ ...items, [id]: '' }))
  }

  return (
    <div className="container-page max-w-7xl py-8">
      <div className="gradient-ring rounded-3xl p-px">
        <div className="rounded-[1.45rem] bg-panel/90 p-6">
          <p className="mono-label">Backend provider status</p>
          <h1 className="mt-2 text-3xl font-extrabold text-text">API & Providers</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
            This screen is a demo placeholder for provider connection status. Keys entered here are not used by agents. For production, keys must be stored server-side in Supabase secrets or a secure provider_keys table scoped by account_id.
          </p>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4"><p className="text-2xl font-bold text-text">Server</p><p className="text-xs text-muted">secrets required</p></div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4"><p className="text-2xl font-bold text-text">Demo</p><p className="text-xs text-muted">local status only</p></div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4"><p className="text-2xl font-bold text-text">{connectedCount}</p><p className="text-xs text-muted">demo providers marked</p></div>
          </div>
        </div>
      </div>

      <div className="mt-8 grid gap-5 lg:grid-cols-[0.85fr_1.15fr]">
        <div className="gradient-ring rounded-3xl p-px">
          <div className="rounded-[1.45rem] bg-panel/90 p-6">
            <PlugZap className="text-cyan" />
            <h2 className="mt-4 text-2xl font-bold text-text">Live backend requirements</h2>
            <p className="mt-2 text-sm text-muted">
              Frontend uses only VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. OPENROUTER_API_KEY, OPENAI_API_KEY and SUPABASE_SERVICE_ROLE_KEY must never be placed in frontend env files.
            </p>
            <Button className="mt-5" onClick={() => setMode('secrets')} variant={mode === 'secrets' ? 'primary' : 'secondary'}>
              Supabase secrets
            </Button>
            <Button className="mt-3" fullWidth variant={mode === 'provider_keys' ? 'primary' : 'secondary'} onClick={() => setMode('provider_keys')}>
              provider_keys table
            </Button>
          </div>
        </div>

        <div className="card rounded-3xl p-6">
          <h2 className="flex items-center gap-2 text-xl font-bold text-text"><KeyRound className="text-violet" /> Demo provider status</h2>
          <p className="mt-2 text-sm text-muted">Saving here stores only a local demo flag and an encrypted-demo-placeholder. It does not configure live agents or Edge Functions.</p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {providers.map((p) => (
              <div key={p.id} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                <p className="flex items-center gap-2 font-medium text-text">{saved[p.id] ? <CheckCircle2 size={16} className="text-teal" /> : <KeyRound size={16} className="text-muted" />} {p.name}</p>
                <p className="mt-1 text-xs text-muted">{p.use}</p>
                <div className="mt-3 flex gap-2">
                  <input
                    type="password"
                    value={keys[p.id] ?? ''}
                    onChange={(e) => setKeys((items) => ({ ...items, [p.id]: e.target.value }))}
                    placeholder={saved[p.id] ? 'demo status saved · not used by agents' : p.placeholder}
                    className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-text outline-none focus:border-violet/50"
                  />
                  <button onClick={() => saveProvider(p.id)} disabled={!keys[p.id]?.trim()} className="rounded-xl bg-violet px-3 py-2 text-white disabled:opacity-40">
                    <Save size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-5 rounded-2xl border border-amber/20 bg-amber/10 p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-text"><Lock size={16} className="text-amber" /> Production note</p>
            <p className="mt-1 text-xs text-muted">For production, send keys to a Supabase Edge Function and store encrypted values in server-side Supabase secrets or provider_keys scoped by account_id. The browser must never store real provider secrets.</p>
          </div>
          <div className="mt-3 rounded-2xl border border-teal/20 bg-teal/10 p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-text"><ShieldCheck size={16} className="text-teal" /> Selected backend pattern: {mode === 'secrets' ? 'Supabase Edge Function secrets' : 'provider_keys table scoped by account_id'}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
