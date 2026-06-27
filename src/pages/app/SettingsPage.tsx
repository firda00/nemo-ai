import { useState } from 'react'
import { Globe, User as UserIcon, Gauge, Users, Check, UserPlus, Trash2 } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useAuth } from '../../context/AuthContext'
import { useToast } from '../../components/ui/Toast'
import { Button } from '../../components/ui/Button'
import { cn } from '../../lib/cn'
import type { Lang } from '../../types'

const langOptions: { code: Lang; label: string; native: string }[] = [
  { code: 'uz', label: "O‘zbekcha", native: 'UZ' },
  { code: 'ru', label: 'Русский', native: 'RU' },
  { code: 'en', label: 'English', native: 'EN' },
]

interface Member {
  id: string
  email: string
  role: 'owner' | 'operator'
}

function Section({ icon: Icon, title, desc, children }: { icon: typeof Globe; title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="card rounded-2xl p-6">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet/15 text-violet">
          <Icon size={18} />
        </span>
        <div>
          <h2 className="font-normal text-text">{title}</h2>
          {desc && <p className="text-xs text-muted">{desc}</p>}
        </div>
      </div>
      <div className="mt-5">{children}</div>
    </section>
  )
}

export default function SettingsPage() {
  const { t, lang, setLang } = useI18n()
  const { user, updateUser } = useAuth()
  const toast = useToast()
  const quotaPct = user ? Math.min(100, Math.round((user.quotaUsed / user.quotaLimit) * 100)) : 0

  const [members, setMembers] = useState<Member[]>([
    { id: 'o1', email: user?.email ?? 'owner@nemo.ai', role: 'owner' },
    { id: 'o2', email: 'sevara@nemo.ai', role: 'operator' },
  ])
  const [invite, setInvite] = useState('')

  const addMember = () => {
    const email = invite.trim()
    if (!email) return
    setMembers((m) => [...m, { id: `o${Date.now()}`, email, role: 'operator' }])
    setInvite('')
    toast(t('platform.settingsTeam.invited'))
  }

  return (
    <div className="container-page max-w-3xl py-8">
      <h1 className="text-2xl font-normal tracking-tight text-text">{t('platform.nav.settings')}</h1>
      <p className="mt-1 text-sm text-muted">{t('settings.subtitle')}</p>

      <div className="mt-7 space-y-5">
        <Section icon={Globe} title={t('settings.languageTitle')} desc={t('settings.languageDesc')}>
          <div className="grid gap-3 sm:grid-cols-3">
            {langOptions.map((opt) => {
              const active = lang === opt.code
              return (
                <button
                  key={opt.code}
                  onClick={() => { setLang(opt.code); updateUser({ lang: opt.code }) }}
                  className={cn('flex items-center justify-between rounded-xl border p-4 text-left transition-all', active ? 'border-violet/60 bg-violet/10 shadow-glow' : 'border-ice/10 hover:border-ice/25')}
                >
                  <span className="flex items-center gap-3">
                    <span className={cn('flex h-9 w-9 items-center justify-center rounded-lg border font-mono text-xs', active ? 'border-cobalt/50 text-cobalt' : 'border-ice/15 text-fog')}>{opt.native}</span>
                    <span className="text-sm font-normal text-text">{opt.label}</span>
                  </span>
                  {active && <Check size={18} className="text-violet" />}
                </button>
              )
            })}
          </div>
        </Section>

        <Section icon={UserIcon} title={t('settings.accountTitle')}>
          <div className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-xs font-normal text-muted">{t('settings.name')}</span>
              <input value={user?.name ?? ''} onChange={(e) => updateUser({ name: e.target.value })} className="glass w-full rounded-xl px-3 py-2.5 text-sm text-text outline-none focus:border-violet/50 focus:shadow-glow" />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <span className="mb-1.5 block text-xs font-normal text-muted">{t('settings.email')}</span>
                <div className="rounded-xl border border-ice/[0.07] bg-ice/[0.02] px-3 py-2.5 text-sm text-muted">{user?.email}</div>
              </div>
              <div>
                <span className="mb-1.5 block text-xs font-normal text-muted">{t('settings.plan')}</span>
                <div className="flex items-center rounded-xl border border-ice/[0.07] bg-ice/[0.02] px-3 py-2.5 text-sm">
                  <span className="rounded-full bg-teal/15 px-2 py-0.5 text-xs font-normal text-teal">{t('settings.planBeta')}</span>
                </div>
              </div>
            </div>
          </div>
        </Section>

        <Section icon={Gauge} title={t('settings.quotaTitle')} desc={t('settings.quotaDesc')}>
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-text">{user?.quotaUsed} {t('settings.quotaOf')} {user?.quotaLimit} {t('settings.quotaRuns')}</span>
            <span className="text-xs font-normal text-muted">{quotaPct}%</span>
          </div>
          <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-ice/[0.07]">
            <div className="h-full rounded-full bg-cobalt transition-all" style={{ width: `${quotaPct}%` }} />
          </div>
        </Section>

        <Section icon={Users} title={t('platform.settingsTeam.title')} desc={t('platform.settingsTeam.desc')}>
          <div className="flex gap-2">
            <input value={invite} onChange={(e) => setInvite(e.target.value)} placeholder={t('platform.settingsTeam.invitePh')} className="glass flex-1 rounded-xl px-3 py-2.5 text-sm text-text outline-none placeholder:text-muted/70 focus:border-violet/50" />
            <Button size="md" onClick={addMember}>
              <UserPlus size={15} /> {t('platform.settingsTeam.invite')}
            </Button>
          </div>
          <ul className="mt-4 space-y-2">
            {members.map((m) => (
              <li key={m.id} className="flex items-center gap-3 rounded-xl border border-ice/[0.07] bg-ice/[0.02] px-3 py-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo text-sm font-medium text-white">{m.email.charAt(0).toUpperCase()}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-text">{m.email}</span>
                <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-normal', m.role === 'owner' ? 'bg-violet/15 text-violet' : 'bg-ice/[0.06] text-muted')}>
                  {m.role === 'owner' ? t('platform.settingsTeam.roleOwner') : t('platform.settingsTeam.roleOperator')}
                </span>
                {m.role === 'operator' && (
                  <button onClick={() => setMembers((list) => list.filter((x) => x.id !== m.id))} className="rounded-lg p-1.5 text-muted hover:bg-ice/[0.06] hover:text-danger">
                    <Trash2 size={15} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  )
}
