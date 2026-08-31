import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, ExternalLink, ShieldCheck, Terminal, XCircle } from 'lucide-react'
import { Button } from '../components/ui/Button'
import { LanguageToggle } from '../components/ui/LanguageToggle'
import { Logo } from '../components/ui/Logo'
import { useAuth } from '../context/AuthContext'
import { useI18n } from '../i18n'
import { parseCliAuthRequest } from '../lib/cliAuth'
import { supabase } from '../lib/supabase'

const COPY = {
  uz: {
    eyebrow: 'Nemo CLI xavfsiz kirish', title: 'Terminalni akkauntingizga ulang',
    body: 'Kirish brauzerda amalga oshiriladi. Parol va tokenlar terminal buyruqlariga tushmaydi.',
    google: 'Google orqali davom etish', sending: 'CLI bilan xavfsiz ulanish…',
    success: 'Avtorizatsiya muvaffaqiyatli!', close: 'Bu oynani yopib, terminalga qaytishingiz mumkin.',
    invalid: 'Kirish havolasi yaroqsiz yoki eskirgan.', retry: 'Terminalda nemo login buyrug‘ini qayta ishga tushiring.',
    failed: 'CLI bilan ulanish amalga oshmadi.', noBackend: 'Haqiqiy avtorizatsiya bu muhitda sozlanmagan.',
    privacy: 'Token URL manziliga yozilmaydi va faqat localhost callback’iga yuboriladi.',
  },
  ru: {
    eyebrow: 'Безопасный вход Nemo CLI', title: 'Подключите терминал к своему аккаунту',
    body: 'Вход происходит в браузере. Пароль и токены не попадают в команды терминала.',
    google: 'Продолжить через Google', sending: 'Безопасно подключаем CLI…',
    success: 'Авторизация успешна!', close: 'Можно закрыть это окно и вернуться в терминал.',
    invalid: 'Ссылка входа недействительна или устарела.', retry: 'Снова выполните nemo login в терминале.',
    failed: 'Не удалось подключить CLI.', noBackend: 'Настоящая авторизация в этом окружении не настроена.',
    privacy: 'Токен не попадает в URL и отправляется только на localhost callback.',
  },
  en: {
    eyebrow: 'Secure Nemo CLI sign-in', title: 'Connect the terminal to your account',
    body: 'Sign-in happens in your browser. Passwords and tokens never enter terminal commands.',
    google: 'Continue with Google', sending: 'Securely connecting the CLI…',
    success: 'Authorization successful!', close: 'You can close this window and return to the terminal.',
    invalid: 'This sign-in link is invalid or expired.', retry: 'Run nemo login again in your terminal.',
    failed: 'Could not connect the CLI.', noBackend: 'Live authentication is not configured in this environment.',
    privacy: 'The token never enters the URL and is sent only to the localhost callback.',
  },
} as const

type Status = 'idle' | 'sending' | 'success' | 'error'

export default function CliAuthPage() {
  const { lang } = useI18n()
  const text = COPY[lang]
  const { isAuthed, loading, live } = useAuth()
  const request = useMemo(() => parseCliAuthRequest(window.location.search), [])
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState('')
  const started = useRef(false)

  const connect = useCallback(async () => {
    if (!request || !supabase || !live) {
      setError(request ? text.noBackend : text.invalid)
      setStatus('error')
      return
    }
    setStatus('sending')
    setError('')
    const { data, error: sessionError } = await supabase.auth.getSession()
    const session = data.session
    if (sessionError || !session) {
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.href },
      })
      if (oauthError) {
        setError(text.failed)
        setStatus('error')
      }
      return
    }

    try {
      const response = await fetch(request.callback, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: request.state,
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          expires_at: session.expires_at ?? Math.floor(Date.now() / 1000) + session.expires_in,
          email: session.user.email ?? '',
          name: session.user.user_metadata?.name ?? session.user.user_metadata?.full_name ?? '',
        }),
      })
      if (!response.ok) throw new Error('callback_rejected')
      setStatus('success')
    } catch {
      setError(text.failed)
      setStatus('error')
    }
  }, [live, request, text.failed, text.invalid, text.noBackend])

  useEffect(() => {
    if (loading || !isAuthed || started.current || !request) return
    started.current = true
    void connect()
  }, [connect, isAuthed, loading, request])

  const invalid = !request
  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-bg px-5 py-12 text-text">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_10%,rgba(139,124,248,0.18),transparent_38%),radial-gradient(circle_at_80%_80%,rgba(34,211,238,0.10),transparent_30%)]" />
      <div className="absolute left-6 top-6"><Logo /></div>
      <div className="absolute right-6 top-6"><LanguageToggle /></div>

      <section className="relative w-full max-w-lg rounded-[28px] border border-white/10 bg-panel/85 p-7 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-10">
        <div className="mb-7 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-violet to-cyan text-white shadow-lg shadow-violet/20">
          {status === 'success' ? <CheckCircle2 size={28} /> : status === 'error' || invalid ? <XCircle size={28} /> : <Terminal size={28} />}
        </div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-cyan">{text.eyebrow}</p>
        <h1 className="text-3xl font-bold tracking-tight text-white">{status === 'success' ? text.success : text.title}</h1>
        <p className="mt-3 text-sm leading-6 text-muted">
          {status === 'success' ? text.close : invalid ? text.invalid : error || text.body}
        </p>

        {status !== 'success' && (
          <div className="mt-8">
            {invalid || status === 'error' ? (
              <div className="rounded-2xl border border-danger/20 bg-danger/5 px-4 py-3 text-sm text-danger">
                {error || text.invalid} <span className="text-muted">{text.retry}</span>
              </div>
            ) : (
              <Button
                fullWidth
                size="lg"
                loading={status === 'sending' || loading}
                onClick={() => void connect()}
                leftIcon={<ExternalLink size={17} />}
              >
                {status === 'sending' ? text.sending : text.google}
              </Button>
            )}
          </div>
        )}

        <div className="mt-7 flex items-start gap-3 border-t border-white/10 pt-5 text-xs leading-5 text-fog">
          <ShieldCheck className="mt-0.5 shrink-0 text-teal" size={16} />
          <span>{text.privacy}</span>
        </div>
      </section>
    </main>
  )
}
