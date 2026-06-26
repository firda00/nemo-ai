import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Check, Mail, Sparkles, Users, ShieldCheck } from 'lucide-react'
import { useI18n } from '../i18n'
import { useAuth } from '../context/AuthContext'
import { Logo } from '../components/ui/Logo'
import { Button } from '../components/ui/Button'
import { LanguageToggle } from '../components/ui/LanguageToggle'

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  )
}

type View = 'auth' | 'waitlist' | 'forgot'

export default function AuthPage() {
  const { t } = useI18n()
  const { login, signup, loginWithGoogle, live } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [params] = useSearchParams()
  const [mode, setMode] = useState<'login' | 'signup'>(
    params.get('mode') === 'signup' || location.pathname.endsWith('/signup') ? 'signup' : 'login',
  )
  const [view, setView] = useState<View>('auth')
  const [sent, setSent] = useState(false)
  const [subEmail, setSubEmail] = useState('')
  const [form, setForm] = useState({ name: '', email: '', password: '', invite: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const isSignup = mode === 'signup'
  const from = (location.state as { from?: string } | null)?.from ?? '/app'

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setErr('')
    setBusy(true)
    const res = isSignup
      ? await signup(form.name || form.email, form.email, form.password)
      : await login(form.email, form.password)
    setBusy(false)
    if (res.error) {
      setErr(res.error)
      return
    }
    navigate(isSignup ? '/onboarding' : from) // new users start with the agent wizard
  }
  const google = async () => {
    setErr('')
    const res = await loginWithGoogle()
    if (res.error) {
      setErr(res.error)
      return
    }
    if (!live) navigate(from) // live OAuth redirects on its own
  }
  const goAuth = () => {
    setView('auth')
    setSent(false)
    setSubEmail('')
  }

  const perks = [
    { icon: Sparkles, text: t('landing.features.items.0.title') },
    { icon: Users, text: t('landing.previewTeam') },
    { icon: ShieldCheck, text: t('landing.features.items.5.title') },
  ]

  const sub =
    view === 'waitlist'
      ? {
          title: t('auth.waitlistTitle'),
          desc: t('auth.waitlistDesc'),
          button: t('auth.waitlistButton'),
          success: t('auth.waitlistSuccess'),
        }
      : {
          title: t('auth.forgotTitle'),
          desc: t('auth.forgotDesc'),
          button: t('auth.forgotButton'),
          success: t('auth.forgotSuccess'),
        }

  return (
    <div className="relative flex min-h-screen overflow-hidden bg-void">
      {/* brand panel */}
      <div className="relative hidden w-[44%] flex-col overflow-hidden border-r border-ice/10 bg-carbon p-12 lg:flex">
        <div className="dot-field pointer-events-none absolute inset-0 opacity-60" />
        <div className="relative flex h-full flex-col">
          <Link to="/">
            <Logo size={38} />
          </Link>
          <div className="my-auto max-w-md">
            <h2 className="text-3xl font-normal leading-tight tracking-tight">
              {t('landing.title')}{' '}
              <span className="text-brand">{t('landing.titleAccent')}</span>
            </h2>
            <p className="mt-4 leading-relaxed text-muted">{t('landing.subtitle')}</p>
            <ul className="mt-8 space-y-3">
              {perks.map((p) => (
                <li key={p.text} className="flex items-center gap-3 text-sm text-text/85">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ice/[0.06] text-cyan">
                    <p.icon size={16} />
                  </span>
                  {p.text}
                </li>
              ))}
            </ul>
          </div>
          <p className="relative text-xs text-muted">© {new Date().getFullYear()} Nemo AI · Ustudy IT</p>
        </div>
      </div>

      {/* form panel */}
      <div className="relative flex flex-1 flex-col">
        <div className="flex items-center justify-between p-5">
          <Link to="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-text">
            <ArrowLeft size={16} /> {t('auth.backHome')}
          </Link>
          <LanguageToggle />
        </div>

        <div className="flex flex-1 items-center justify-center px-5 pb-12">
          <div className="card w-full max-w-sm rounded-3xl p-7">
            <div className="mb-6 lg:hidden">
              <Logo />
            </div>

            {view !== 'auth' ? (
              <div className="animate-fadeInUp">
                <h1 className="text-2xl font-normal text-text">{sub.title}</h1>
                <p className="mt-2 text-sm text-muted">{sub.desc}</p>
                {sent ? (
                  <div className="mt-6 flex items-center gap-3 rounded-2xl border border-teal/25 bg-teal/10 p-4">
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-teal text-bg">
                      <Check size={18} />
                    </span>
                    <p className="text-sm font-medium text-text">{sub.success}</p>
                  </div>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      setSent(true)
                    }}
                    className="mt-6 space-y-3"
                  >
                    <Field
                      label={t('auth.email')}
                      type="email"
                      required
                      value={subEmail}
                      onChange={setSubEmail}
                      placeholder={t('auth.emailPlaceholder')}
                      icon={<Mail size={16} />}
                    />
                    <Button type="submit" fullWidth>
                      {sub.button}
                    </Button>
                  </form>
                )}
                <button onClick={goAuth} className="mt-5 inline-flex items-center gap-1.5 text-sm font-normal text-violet hover:underline">
                  <ArrowLeft size={15} /> {t('auth.backToLogin')}
                </button>
              </div>
            ) : (
              <div className="animate-fadeInUp">
                <h1 className="text-2xl font-normal text-text">
                  {isSignup ? t('auth.signupTitle') : t('auth.loginTitle')}
                </h1>
                <p className="mt-2 text-sm text-muted">
                  {isSignup ? t('auth.signupSubtitle') : t('auth.loginSubtitle')}
                </p>

                <button
                  onClick={google}
                  className="glass mt-6 flex w-full items-center justify-center gap-2.5 rounded-xl py-2.5 text-sm font-normal text-text transition-colors hover:bg-ice/[0.09]"
                >
                  <GoogleIcon /> {t('auth.google')}
                </button>

                <div className="my-5 flex items-center gap-3 text-xs text-muted">
                  <span className="h-px flex-1 bg-ice/10" />
                  {t('auth.or')}
                  <span className="h-px flex-1 bg-ice/10" />
                </div>

                <form onSubmit={submit} className="space-y-3">
                  {isSignup && (
                    <Field
                      label={t('auth.name')}
                      value={form.name}
                      onChange={(v) => setForm({ ...form, name: v })}
                      placeholder={t('auth.namePlaceholder')}
                    />
                  )}
                  <Field
                    label={t('auth.email')}
                    type="email"
                    required
                    value={form.email}
                    onChange={(v) => setForm({ ...form, email: v })}
                    placeholder={t('auth.emailPlaceholder')}
                    icon={<Mail size={16} />}
                  />
                  <Field
                    label={t('auth.password')}
                    type="password"
                    required
                    value={form.password}
                    onChange={(v) => setForm({ ...form, password: v })}
                    placeholder={t('auth.passwordPlaceholder')}
                  />
                  {isSignup && (
                    <div>
                      <Field
                        label={`${t('auth.invite')} (${t('common.optional')})`}
                        value={form.invite}
                        onChange={(v) => setForm({ ...form, invite: v })}
                        placeholder={t('auth.invitePlaceholder')}
                      />
                      <p className="mt-1.5 text-[11px] leading-snug text-muted">{t('auth.inviteHint')}</p>
                    </div>
                  )}

                  {!isSignup && (
                    <div className="text-right">
                      <button type="button" onClick={() => setView('forgot')} className="text-xs font-medium text-violet hover:underline">
                        {t('auth.forgot')}
                      </button>
                    </div>
                  )}

                  {err && (
                    <p className="rounded-lg bg-danger/10 px-3 py-2 text-center text-xs text-danger">{err}</p>
                  )}

                  <Button type="submit" fullWidth size="lg" disabled={busy}>
                    {busy ? '…' : isSignup ? t('auth.signupButton') : t('auth.loginButton')}
                  </Button>
                </form>

                <p className="mt-5 text-center text-sm text-muted">
                  {isSignup ? t('auth.toLogin') : t('auth.toSignup')}{' '}
                  <button onClick={() => setMode(isSignup ? 'login' : 'signup')} className="font-normal text-violet hover:underline">
                    {isSignup ? t('auth.toLoginLink') : t('auth.toSignupLink')}
                  </button>
                </p>

                <div className="mt-4 flex items-center justify-center">
                  <button onClick={() => setView('waitlist')} className="text-xs font-medium text-muted hover:text-text">
                    {t('auth.waitlistButton')}
                  </button>
                </div>

                {!live && (
                  <p className="mt-5 rounded-lg bg-amber/10 px-3 py-2 text-center text-[11px] text-amber">
                    {t('auth.demoNote')}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  type = 'text',
  value,
  onChange,
  placeholder,
  icon,
  required,
}: {
  label: string
  type?: string
  value?: string
  onChange?: (v: string) => void
  placeholder?: string
  icon?: ReactNode
  required?: boolean
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-normal text-muted">{label}</span>
      <span className="relative block">
        {icon && <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">{icon}</span>}
        <input
          type={type}
          required={required}
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder={placeholder}
          className={`glass w-full rounded-xl py-2.5 text-sm text-text outline-none transition-colors placeholder:text-muted/70 focus:border-violet/50 focus:shadow-glow ${
            icon ? 'pl-9 pr-3' : 'px-3'
          }`}
        />
      </span>
    </label>
  )
}
