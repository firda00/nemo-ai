import { useEffect, useState, type ReactNode } from 'react'
import { KeyRound, Loader2, LockKeyhole, ShieldCheck } from 'lucide-react'
import { Navigate, useNavigate } from 'react-router-dom'
import { isSupabaseEnabled, supabase } from '../../lib/supabase'
import { useAgentStore } from '../../store/useAgentStore'
import { useI18n } from '../../i18n'
import { MfaSetupPanel } from '../platform/MfaSetupPanel'
import { Button } from '../ui/Button'

type GateState = 'checking' | 'password' | 'enroll' | 'verify' | 'ready' | 'failed'

export function AdminMfaGate({ children }: { children: ReactNode }) {
  const { lang } = useI18n()
  const navigate = useNavigate()
  const isAdmin = useAgentStore((state) => state.isAdmin)
  const profileResolved = useAgentStore((state) => state.profileResolved)
  const [state, setState] = useState<GateState>('checking')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [factorId, setFactorId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const copy = lang === 'uz' ? {
    title: 'Himoyalangan boshqaruvga kirish', desc: 'Har safar hisob paroli va Authenticator kodini kiriting.',
    passwordLabel: 'Hisob paroli', passwordHint: 'Google orqali kirgan bo‘lsangiz, avval parolni tiklash orqali parol yarating.', continue: 'Davom etish',
    code: 'Authenticator kodi', codeDesc: 'Ilovadagi joriy 6 xonali kodni kiriting.', verify: 'Kirishni tasdiqlash',
    wrongPassword: 'Parol tasdiqlanmadi. Qayta urinib ko‘ring.', wrongCode: 'Kod noto‘g‘ri yoki eskirgan.', failed: 'Xavfsizlik tekshiruvi bajarilmadi. Kirish yopiq.', back: 'Ish stoliga qaytish',
  } : lang === 'en' ? {
    title: 'Protected control access', desc: 'Enter your account password and an Authenticator code every time.',
    passwordLabel: 'Account password', passwordHint: 'If you normally use Google sign-in, create a password through password recovery first.', continue: 'Continue',
    code: 'Authenticator code', codeDesc: 'Enter the current 6-digit code from your app.', verify: 'Confirm access',
    wrongPassword: 'The password could not be verified. Try again.', wrongCode: 'The code is incorrect or expired.', failed: 'The security check failed. Access remains closed.', back: 'Return to workspace',
  } : {
    title: 'Вход в защищённое управление', desc: 'Каждый вход требует пароль аккаунта и код из Authenticator.',
    passwordLabel: 'Пароль аккаунта', passwordHint: 'Если вы обычно входите через Google, сначала создайте пароль через восстановление доступа.', continue: 'Продолжить',
    code: 'Код Authenticator', codeDesc: 'Введите текущий 6-значный код из приложения.', verify: 'Подтвердить вход',
    wrongPassword: 'Не удалось подтвердить пароль. Попробуйте ещё раз.', wrongCode: 'Код неверный или уже истёк.', failed: 'Проверка безопасности не выполнена. Доступ закрыт.', back: 'Вернуться в рабочее пространство',
  }

  useEffect(() => {
    if (!profileResolved) return
    const timer = window.setTimeout(() => setState(isAdmin && isSupabaseEnabled && supabase ? 'password' : 'failed'), 0)
    return () => window.clearTimeout(timer)
  }, [isAdmin, profileResolved])

  useEffect(() => {
    const requireFreshLogin = () => {
      setError(lang === 'uz' ? 'Himoyalangan seans tugadi. Qayta kiring.' : lang === 'en' ? 'The protected session expired. Sign in again.' : 'Защищённая сессия истекла. Войдите ещё раз.')
      setCode('')
      setFactorId('')
      setState('password')
    }
    window.addEventListener('nemo:admin-reauth-required', requireFreshLogin)
    return () => window.removeEventListener('nemo:admin-reauth-required', requireFreshLogin)
  }, [lang])

  const verifyPassword = async () => {
    if (!supabase || busy || password.length < 8) return
    setBusy(true); setError('')
    try {
      const { data: current } = await supabase.auth.getUser()
      const email = current.user?.email
      const userId = current.user?.id
      if (!email || !userId) throw new Error('missing user')
      const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password })
      if (signInError || data.user?.id !== userId) throw signInError ?? new Error('account mismatch')
      const { data: factors, error: factorError } = await supabase.auth.mfa.listFactors()
      if (factorError) throw factorError
      const verified = factors?.totp?.find((factor) => factor.status === 'verified')
      setPassword('')
      if (!verified) setState('enroll')
      else { setFactorId(verified.id); setState('verify') }
    } catch { setError(copy.wrongPassword) } finally { setBusy(false) }
  }

  const verifyCode = async () => {
    if (!supabase || !factorId || !/^\d{6}$/.test(code) || busy) return
    setBusy(true); setError('')
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId })
      if (challengeError || !challenge) throw challengeError ?? new Error('challenge failed')
      const { error: verifyError } = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.id, code })
      if (verifyError) throw verifyError
      setCode(''); setState('ready')
    } catch { setError(copy.wrongCode) } finally { setBusy(false) }
  }

  if (!profileResolved || state === 'checking') return <div className="grid min-h-[50vh] place-items-center text-muted"><Loader2 className="animate-spin" size={22} /></div>
  if (!isAdmin) return <Navigate to="/app" replace />
  if (state === 'ready') return <>{children}</>

  return <div className="container-page grid min-h-[70vh] max-w-2xl place-items-center py-12">
    <section className="card w-full rounded-3xl p-6 sm:p-8">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-violet/15 text-violet"><LockKeyhole size={23} /></span>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight text-text">{copy.title}</h1>
      <p className="mt-2 max-w-xl text-sm leading-6 text-muted">{copy.desc}</p>

      {state === 'password' && <div className="mt-6">
        <label className="text-xs font-semibold text-text" htmlFor="control-account-password">{copy.passwordLabel}</label>
        <input id="control-account-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void verifyPassword() }} autoComplete="current-password" autoFocus className="mt-2 w-full rounded-xl border border-ice/10 bg-black/15 px-3 py-3 text-sm text-text outline-none focus:border-violet/50 focus:ring-2 focus:ring-violet/10" />
        <p className="mt-2 text-xs leading-5 text-muted">{copy.passwordHint}</p>
        <Button fullWidth className="mt-4" onClick={() => void verifyPassword()} disabled={busy || password.length < 8}>{busy ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}{copy.continue}</Button>
      </div>}

      {state === 'verify' && <div className="mt-6">
        <label className="text-xs font-semibold text-text" htmlFor="control-totp-code">{copy.code}</label>
        <p className="mt-1 text-xs text-muted">{copy.codeDesc}</p>
        <input id="control-totp-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} onKeyDown={(event) => { if (event.key === 'Enter') void verifyCode() }} inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="000000" className="mt-3 w-full rounded-xl border border-ice/10 bg-black/15 px-3 py-3 text-center font-mono text-xl tracking-[0.35em] text-text outline-none focus:border-violet/50 focus:ring-2 focus:ring-violet/10" />
        <Button fullWidth className="mt-4" onClick={() => void verifyCode()} disabled={busy || !/^\d{6}$/.test(code)}>{busy ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}{copy.verify}</Button>
      </div>}

      {state === 'enroll' && <div className="mt-6"><MfaSetupPanel onChanged={() => setState('ready')} /></div>}
      {state === 'failed' && <p className="mt-5 rounded-xl border border-danger/20 bg-danger/10 px-3 py-3 text-sm text-danger">{copy.failed}</p>}
      {error && <p role="alert" className="mt-3 rounded-xl border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
      <button type="button" onClick={() => navigate('/app', { replace: true })} className="mt-5 text-xs font-medium text-muted transition hover:text-text">← {copy.back}</button>
    </section>
  </div>
}
