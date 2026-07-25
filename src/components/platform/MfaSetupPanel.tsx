import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Copy, Loader2, ShieldCheck, Trash2 } from 'lucide-react'
import { isSupabaseEnabled, supabase } from '../../lib/supabase'
import { Button } from '../ui/Button'
import { useI18n } from '../../i18n'

interface TotpFactor { id: string; status: 'verified' | 'unverified'; friendly_name?: string }
interface Enrollment { id: string; qrCode: string; secret: string }

export function MfaSetupPanel({ onChanged }: { onChanged?: () => void } = {}) {
  const { lang } = useI18n()
  const copy = lang === 'uz' ? {
    unavailable: '2FA production hisobiga kirgandan so‘ng mavjud.',
    enabled: 'Authenticator yoqilgan',
    enabledDesc: 'Himoyalangan kirishda bir martalik kod talab qilinadi.',
    disable: 'O‘chirish',
    protect: 'Kirishni bir martalik kod bilan himoyalang',
    apps: 'Google Authenticator, 1Password, Microsoft Authenticator va mos ilovalar qo‘llab-quvvatlanadi.',
    setup: '2FA sozlash',
    scan: '1. QR-kodni skanerlang',
    scanDesc: 'Kamera mavjud bo‘lmasa, maxfiy kalitni qo‘lda kiriting. Uni boshqa odamlarga yubormang.',
    copySecret: 'Maxfiy kalitni nusxalash',
    enterCode: '2. 6 xonali kodni kiriting',
    confirm: 'Tasdiqlash',
    qrAlt: 'Autentifikatsiya ilovasi uchun QR-kod',
    enrollError: '2FA sozlamasini boshlab bo‘lmadi.',
    enabledMessage: 'Ikki bosqichli himoya yoqildi.',
    codeError: 'Kod tasdiqlanmadi. Telefon vaqtini tekshirib, qayta urinib ko‘ring.',
    removeError: 'Faktorni o‘chirib bo‘lmadi. 2FA bilan qayta kirish talab qilinishi mumkin.',
    removedMessage: 'Ikki bosqichli himoya o‘chirildi.',
  } : lang === 'en' ? {
    unavailable: '2FA is available after signing in to a production account.',
    enabled: 'Authenticator enabled',
    enabledDesc: 'A one-time code is required for protected sign-in.',
    disable: 'Disable',
    protect: 'Protect sign-in with a one-time code',
    apps: 'Google Authenticator, 1Password, Microsoft Authenticator, and compatible apps are supported.',
    setup: 'Set up 2FA',
    scan: '1. Scan the QR code',
    scanDesc: 'If the camera is unavailable, add the secret manually. Do not share it with anyone.',
    copySecret: 'Copy secret',
    enterCode: '2. Enter the 6-digit code',
    confirm: 'Confirm',
    qrAlt: 'QR code for an authentication app',
    enrollError: 'Could not start 2FA setup.',
    enabledMessage: 'Two-factor protection is enabled.',
    codeError: 'The code was not verified. Check your phone time and try again.',
    removeError: 'Could not disable the factor. Signing in again with 2FA may be required.',
    removedMessage: 'Two-factor protection is disabled.',
  } : {
    unavailable: '2FA доступна после входа в production-аккаунт.',
    enabled: 'Authenticator включён',
    enabledDesc: 'Одноразовый код потребуется при защищённом входе.',
    disable: 'Отключить',
    protect: 'Защитите вход одноразовым кодом',
    apps: 'Поддерживаются Google Authenticator, 1Password, Microsoft Authenticator и совместимые приложения.',
    setup: 'Настроить 2FA',
    scan: '1. Отсканируйте QR-код',
    scanDesc: 'Если камера недоступна, добавьте секрет вручную. Не отправляйте его другим людям.',
    copySecret: 'Скопировать секрет',
    enterCode: '2. Введите 6-значный код',
    confirm: 'Подтвердить',
    qrAlt: 'QR-код для приложения аутентификации',
    enrollError: 'Не удалось начать настройку 2FA.',
    enabledMessage: 'Двухфакторная защита включена.',
    codeError: 'Код не подтверждён. Проверьте время на телефоне и повторите.',
    removeError: 'Не удалось отключить фактор. Может потребоваться повторный вход с 2FA.',
    removedMessage: 'Двухфакторная защита отключена.',
  }
  const [factors, setFactors] = useState<TotpFactor[]>([])
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const refresh = useCallback(async () => {
    if (!supabase || !isSupabaseEnabled) return
    const { data } = await supabase.auth.mfa.listFactors()
    setFactors((data?.totp ?? []) as TotpFactor[])
  }, [])

  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(timer) }, [refresh])

  const enroll = async () => {
    if (!supabase || busy) return
    setBusy(true); setMessage('')
    try {
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Nemo AI' })
      if (error || !data?.totp) throw error ?? new Error('enroll failed')
      setEnrollment({ id: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret })
    } catch { setMessage(copy.enrollError) } finally { setBusy(false) }
  }

  const verify = async () => {
    if (!supabase || !enrollment || !/^\d{6}$/.test(code) || busy) return
    setBusy(true); setMessage('')
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: enrollment.id })
      if (challengeError || !challenge) throw challengeError ?? new Error('challenge failed')
      const { error } = await supabase.auth.mfa.verify({ factorId: enrollment.id, challengeId: challenge.id, code })
      if (error) throw error
      setEnrollment(null); setCode(''); setMessage(copy.enabledMessage); await refresh(); onChanged?.()
    } catch { setMessage(copy.codeError) } finally { setBusy(false) }
  }

  const remove = async (factorId: string) => {
    if (!supabase || busy) return
    setBusy(true); setMessage('')
    const { error } = await supabase.auth.mfa.unenroll({ factorId })
    if (error) setMessage(copy.removeError)
    else { setMessage(copy.removedMessage); await refresh(); onChanged?.() }
    setBusy(false)
  }

  if (!isSupabaseEnabled || !supabase) return <p className="text-sm text-muted">{copy.unavailable}</p>

  const verified = factors.filter((factor) => factor.status === 'verified')
  return (
    <div className="space-y-4">
      {verified.length > 0 ? verified.map((factor) => (
        <div key={factor.id} className="flex flex-col gap-3 rounded-2xl border border-teal/25 bg-teal/[0.05] p-4 sm:flex-row sm:items-center">
          <CheckCircle2 size={18} className="shrink-0 text-teal" />
          <div className="min-w-0 flex-1"><p className="text-sm font-semibold text-text">{copy.enabled}</p><p className="mt-1 text-xs text-muted">{factor.friendly_name || 'TOTP'} · {copy.enabledDesc}</p></div>
          <Button size="sm" variant="ghost" onClick={() => void remove(factor.id)} disabled={busy}><Trash2 size={14} /> {copy.disable}</Button>
        </div>
      )) : !enrollment ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-black/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div><p className="text-sm font-semibold text-text">{copy.protect}</p><p className="mt-1 text-xs text-muted">{copy.apps}</p></div>
          <Button size="sm" onClick={() => void enroll()} disabled={busy}>{busy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />} {copy.setup}</Button>
        </div>
      ) : (
        <div className="grid gap-5 rounded-2xl border border-violet/25 bg-violet/[0.05] p-4 sm:grid-cols-[180px_1fr]">
          <img src={enrollment.qrCode} alt={copy.qrAlt} className="h-[180px] w-[180px] rounded-xl bg-white p-2" />
          <div>
            <p className="text-sm font-semibold text-text">{copy.scan}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">{copy.scanDesc}</p>
            <button onClick={() => navigator.clipboard?.writeText(enrollment.secret)} className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 font-mono text-xs text-muted hover:text-text"><Copy size={12} /> {copy.copySecret}</button>
            <p className="mt-4 text-sm font-semibold text-text">{copy.enterCode}</p>
            <div className="mt-2 flex gap-2"><input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" className="w-32 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-center font-mono text-lg tracking-[0.25em] text-text outline-none focus:border-violet/50" /><Button onClick={() => void verify()} disabled={busy || !/^\d{6}$/.test(code)}>{busy ? <Loader2 size={14} className="animate-spin" /> : null} {copy.confirm}</Button></div>
          </div>
        </div>
      )}
      {message && <p className="rounded-xl border border-white/10 bg-black/10 px-3 py-2 text-xs text-muted">{message}</p>}
    </div>
  )
}
