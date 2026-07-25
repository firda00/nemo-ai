import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'
import { isSupabaseEnabled, supabase } from '../../lib/supabase'
import { useAgentStore } from '../../store/useAgentStore'
import { MfaSetupPanel } from '../platform/MfaSetupPanel'
import { Button } from '../ui/Button'

type GateState = 'checking' | 'enroll' | 'verify' | 'ready' | 'failed'

export function AdminMfaGate({ children }: { children: ReactNode }) {
  const isAdmin = useAgentStore((state) => state.isAdmin)
  const profileResolved = useAgentStore((state) => state.profileResolved)
  const [state, setState] = useState<GateState>('checking')

  const inspect = useCallback(async () => {
    if (!isSupabaseEnabled || !supabase || !isAdmin) {
      setState('ready')
      return
    }
    setState('checking')
    const [{ data: factors, error: factorsError }, { data: aal, error: aalError }] = await Promise.all([
      supabase.auth.mfa.listFactors(),
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    ])
    if (factorsError || aalError) {
      setState('failed')
      return
    }
    const verified = factors?.totp?.some((factor) => factor.status === 'verified')
    if (!verified) setState('enroll')
    else if (aal?.currentLevel !== 'aal2') setState('verify')
    else setState('ready')
  }, [isAdmin])

  useEffect(() => {
    if (!profileResolved) return
    const timer = window.setTimeout(() => void inspect(), 0)
    return () => window.clearTimeout(timer)
  }, [inspect, profileResolved])

  if (!profileResolved || state === 'checking') {
    return <div className="grid min-h-[50vh] place-items-center text-muted"><Loader2 className="animate-spin" size={22} /></div>
  }
  if (!isAdmin || state === 'ready') return <>{children}</>

  return (
    <div className="container-page max-w-2xl py-12">
      <div className="card rounded-3xl p-6">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-violet/15 text-violet"><ShieldCheck size={23} /></span>
        <h1 className="mt-4 text-xl font-semibold text-text">Для супер‑админки требуется 2FA</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Административные данные и действия открываются только после подтверждения входа одноразовым кодом.
        </p>
        {state === 'enroll' ? (
          <div className="mt-5"><MfaSetupPanel onChanged={() => void inspect()} /></div>
        ) : (
          <>
            <p className="mt-4 rounded-xl border border-white/10 bg-black/10 px-3 py-3 text-sm text-muted">
              {state === 'verify'
                ? 'Подтвердите код 2FA на экране входа, затем повторите проверку.'
                : 'Не удалось безопасно проверить уровень защиты сессии. Доступ закрыт.'}
            </p>
            <Button className="mt-4" onClick={() => void inspect()}><ShieldCheck size={15} /> Повторить проверку</Button>
          </>
        )}
      </div>
    </div>
  )
}
