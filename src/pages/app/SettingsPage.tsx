import { Check, CreditCard, Globe, Monitor, Moon, Sun, Users, User as UserIcon, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { useI18n } from '../../i18n'
import { useAuth } from '../../context/AuthContext'
import { Button } from '../../components/ui/Button'
import { ConnectAIModel } from '../../components/platform/ConnectAIModel'
import { cn } from '../../lib/cn'
import type { Lang } from '../../types'
import { MfaSetupPanel } from '../../components/platform/MfaSetupPanel'
import { applyTheme, themePreference, type ThemePreference } from '../../lib/theme'

const langOptions: { code: Lang; label: string; native: string }[] = [
  { code: 'uz', label: "O‘zbekcha", native: 'UZ' },
  { code: 'ru', label: 'Русский', native: 'RU' },
  { code: 'en', label: 'English', native: 'EN' },
]

const inputCls = 'w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-text outline-none focus:border-violet/50'

export default function SettingsPage() {
  const { lang, setLang, t } = useI18n()
  const { user, updateUser } = useAuth()
  const [theme, setTheme] = useState<ThemePreference>(themePreference)
  const themeCopy = lang === 'ru'
    ? { title: 'Оформление', desc: 'Выберите светлую, тёмную тему или настройку устройства.', light: 'Светлая', dark: 'Тёмная', system: 'Как в системе' }
    : lang === 'uz'
      ? { title: 'Ko‘rinish', desc: 'Yorug‘, qorong‘i yoki qurilma mavzusini tanlang.', light: 'Yorug‘', dark: 'Qorong‘i', system: 'Tizimga mos' }
      : { title: 'Appearance', desc: 'Choose light, dark, or your device preference.', light: 'Light', dark: 'Dark', system: 'System' }

  const changeTheme = (next: ThemePreference) => {
    setTheme(next)
    applyTheme(next)
  }

  return (
    <div className="container-page max-w-4xl py-8">
      <div>
        <p className="mono-label">{t('mvp.settings.eyebrow')}</p>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-text">{t('mvp.settings.title')}</h1>
        <p className="mt-2 text-sm text-muted">{t('mvp.settings.subtitle')}</p>
      </div>

      <div className="mt-7 grid gap-5">
        <Section icon={UserIcon} title={t('mvp.settings.profile')} desc={t('mvp.settings.profileDesc')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5"><span className="text-xs text-muted">{t('mvp.settings.name')}</span><input value={user?.name ?? ''} onChange={(e) => updateUser({ name: e.target.value })} className={inputCls} /></label>
            <label className="block space-y-1.5"><span className="text-xs text-muted">{t('mvp.settings.email')}</span><input readOnly value={user?.email ?? ''} className={inputCls} /></label>
          </div>
        </Section>

        <Section icon={Globe} title={t('mvp.settings.language')} desc={t('mvp.settings.languageDesc')}>
          <div className="grid gap-3 sm:grid-cols-3">
            {langOptions.map((opt) => {
              const active = lang === opt.code
              return (
                <button key={opt.code} onClick={() => { setLang(opt.code); updateUser({ lang: opt.code }) }} className={cn('flex items-center justify-between rounded-xl border p-4 text-left transition-all', active ? 'border-violet/60 bg-violet/10 shadow-glow' : 'border-white/10 hover:border-white/25')}>
                  <span className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 font-mono text-xs text-cyan">{opt.native}</span><span className="text-sm font-normal text-text">{opt.label}</span></span>
                  {active && <Check size={18} className="text-violet" />}
                </button>
              )
            })}
          </div>
        </Section>

        <Section icon={Monitor} title={themeCopy.title} desc={themeCopy.desc}>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { id: 'light' as const, label: themeCopy.light, icon: Sun },
              { id: 'dark' as const, label: themeCopy.dark, icon: Moon },
              { id: 'system' as const, label: themeCopy.system, icon: Monitor },
            ].map(({ id, label, icon: Icon }) => {
              const active = theme === id
              return <button key={id} type="button" onClick={() => changeTheme(id)} className={cn('flex items-center justify-between rounded-xl border p-4 text-left transition-all', active ? 'border-violet/60 bg-violet/10 shadow-glow' : 'border-ice/10 hover:border-ice/25')}>
                <span className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-lg border border-ice/10 text-violet"><Icon size={17} /></span><span className="text-sm font-normal text-text">{label}</span></span>
                {active && <Check size={18} className="text-violet" />}
              </button>
            })}
          </div>
        </Section>

        <Section icon={CreditCard} title={t('mvp.settings.usage')} desc={t('mvp.settings.usageDesc')}>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
            <div><p className="font-semibold text-text">{t('mvp.settings.pilotPlan')}</p><p className="mt-1 text-xs text-muted">{t('mvp.settings.pilotDesc')}</p></div>
            <Button to="/app/billing" size="sm">{t('mvp.settings.openPricing')}</Button>
          </div>
        </Section>

        <Section icon={ShieldCheck} title={t('mvp.settings.securityTitle')} desc={t('mvp.settings.securityDesc')}>
          <MfaSetupPanel />
        </Section>

        <ConnectAIModel />

        <Section icon={Users} title={t('mvp.settings.teamMembers')} desc={t('mvp.settings.teamMembersDesc')}>
          <ComingSoon text={t('mvp.settings.teamMembersDesc')} />
        </Section>
      </div>
    </div>
  )
}

function Section({ icon: Icon, title, desc, children }: { icon: typeof Globe; title: string; desc: string; children: React.ReactNode }) {
  return <section className="card rounded-2xl p-6"><div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet/15 text-violet"><Icon size={18} /></span><div><h2 className="font-semibold text-text">{title}</h2><p className="text-xs text-muted">{desc}</p></div></div><div className="mt-5">{children}</div></section>
}

function ComingSoon({ text }: { text: string }) {
  const { t } = useI18n()
  return <div className="rounded-2xl border border-amber/20 bg-amber/10 p-4"><p className="text-sm font-semibold text-text">{t('mvp.settings.comingSoon')}</p><p className="mt-1 text-xs leading-relaxed text-muted">{text}</p></div>
}
