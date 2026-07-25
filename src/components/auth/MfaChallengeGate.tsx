import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'
import { isSupabaseEnabled, supabase } from '../../lib/supabase'
import { Button } from '../ui/Button'

export function MfaChallengeGate({ children }: { children: ReactNode }) {
  const [required, setRequired] = useState(false)
  const [ready, setReady] = useState(!isSupabaseEnabled)
  const [factorId, setFactorId] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [checkFailed, setCheckFailed] = useState(false)

  const inspect = useCallback(async () => {
    if (!supabase || !isSupabaseEnabled) { setReady(true); return }
    setReady(false)
    setCheckFailed(false)
    setError('')
    const [{ data: aal, error: aalError }, { data: factors, error: factorsError }] = await Promise.all([
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      supabase.auth.mfa.listFactors(),
    ])
    if (aalError || factorsError) {
      setError('Не удалось проверить двухфакторную защиту. Повторите попытку.')
      setCheckFailed(true)
      setReady(true)
      return
    }
    const verified = factors?.totp?.find((factor) => factor.status === 'verified')
    const needsSecondFactor = aal?.nextLevel === 'aal2' && aal.currentLevel !== 'aal2' && Boolean(verified)
    setFactorId(verified?.id ?? '')
    setRequired(needsSecondFactor)
    setReady(true)
  }, [])

  useEffect(() => { const timer = window.setTimeout(() => void inspect(), 0); return () => window.clearTimeout(timer) }, [inspect])

  const verify = async () => {
    if (!supabase || !factorId || !/^\d{6}$/.test(code) || busy) return
    setBusy(true); setError('')
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId })
      if (challengeError || !challenge) throw challengeError ?? new Error('challenge failed')
      const { error: verifyError } = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.id, code })
      if (verifyError) throw verifyError
      setRequired(false)
    } catch { setError('Неверный или просроченный код.') } finally { setBusy(false) }
  }

  if (!ready) return <div className="grid min-h-screen place-items-center bg-bg text-muted"><Loader2 className="animate-spin" size={22} /></div>
  if (checkFailed) return (
    <div className="grid min-h-screen place-items-center bg-bg px-4">
      <div className="card w-full max-w-md rounded-3xl p-6">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-violet/15 text-violet"><ShieldCheck size={23} /></span>
        <h1 className="mt-4 text-xl font-semibold text-text">Проверка безопасности недоступна</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">Мы не открываем защищённую часть платформы, пока не убедимся в уровне защиты сессии.</p>
        {error && <p className="mt-3 rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
        <Button fullWidth className="mt-4" onClick={() => void inspect()}><ShieldCheck size={15} /> Повторить проверку</Button>
      </div>
    </div>
  )
  if (!required) return <>{children}</>

  return (
    <div className="grid min-h-screen place-items-center bg-bg px-4">
      <div className="card w-full max-w-md rounded-3xl p-6">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-violet/15 text-violet"><ShieldCheck size={23} /></span>
        <h1 className="mt-4 text-xl font-semibold text-text">Подтвердите вход</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">Введите код из приложения аутентификации. Без второго фактора защищённая сессия не откроется.</p>
        <input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} onKeyDown={(event) => { if (event.key === 'Enter') void verify() }} inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="000000" className="mt-5 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-center font-mono text-xl tracking-[0.35em] text-text outline-none focus:border-violet/50" />
        {error && <p className="mt-3 rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
        <Button fullWidth className="mt-4" onClick={() => void verify()} disabled={busy || !/^\d{6}$/.test(code)}>{busy ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />} Проверить код</Button>
      </div>
    </div>
  )
}
