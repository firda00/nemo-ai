import { useEffect, useState } from 'react'
import { Building2, Loader2, Check, ShieldCheck, Sparkles, Target, PenLine } from 'lucide-react'
import { Link } from 'react-router-dom'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useAgentStore } from '../../store/useAgentStore'
import { useI18n } from '../../i18n'
import { Button } from '../../components/ui/Button'

/**
 * Business Profile — "train the AI on your own business". One place where the owner
 * describes their company; the facts are stored per-account and injected into EVERY
 * agent, team, marketing strategy and content run (server-side), so nothing is generic.
 */
type Key = 'name' | 'industry' | 'about' | 'offerings' | 'audience' | 'tone' | 'cities' | 'links' | 'extra' | 'phone' | 'notify_chat_id' | 'tasks_sheet_id'
type Profile = Record<Key, string>
const EMPTY: Profile = { name: '', industry: '', about: '', offerings: '', audience: '', tone: '', cities: '', links: '', extra: '', phone: '', notify_chat_id: '', tasks_sheet_id: '' }

const FIELDS: { k: Key; area?: boolean }[] = [
  { k: 'name' },
  { k: 'phone' },
  { k: 'notify_chat_id' },
  { k: 'tasks_sheet_id' },
  { k: 'industry' },
  { k: 'about', area: true },
  { k: 'offerings', area: true },
  { k: 'audience' },
  { k: 'tone' },
  { k: 'cities' },
  { k: 'links' },
  { k: 'extra', area: true },
]

export default function CompanyBrainPage() {
  const { t } = useI18n()
  const accountId = useAgentStore((s) => s.accountId)
  const [p, setP] = useState<Profile>(EMPTY)
  const [loading, setLoading] = useState(isSupabaseEnabled)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!isSupabaseEnabled || !supabase) return
    ;(async () => {
      try {
        const { data } = await supabase!.from('business_profiles').select('*').maybeSingle()
        if (data) { const next = { ...EMPTY }; for (const k of Object.keys(EMPTY) as Key[]) next[k] = (data as Record<string, string>)[k] ?? ''; setP(next) }
      } catch { /* ignore */ }
      setLoading(false)
    })()
  }, [])

  const set = (k: Key, v: string) => { setP((s) => ({ ...s, [k]: v })); setSaved(false) }

  const save = async () => {
    if (!supabase || !accountId || saving) return
    setSaving(true); setSaved(false)
    try {
      await supabase.from('business_profiles').upsert({ account_id: accountId, ...p, updated_at: new Date().toISOString() }, { onConflict: 'account_id' })
      setSaved(true)
    } finally { setSaving(false) }
  }

  const filled = (Object.keys(EMPTY) as Key[]).filter((k) => p[k].trim()).length

  return (
    <div className="container-page max-w-4xl py-8">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet/15 text-violet"><Building2 size={20} /></span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-text">{t('companyBrainPage.title')}</h1>
          <p className="text-sm text-muted">{t('companyBrainPage.subtitle')}</p>
        </div>
      </div>

      <div className="card mt-5 flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5"><Sparkles size={14} className="text-violet" /> {t('companyBrainPage.filledLabel')} <b className="text-text">{filled}/{FIELDS.length}</b></span>
        <span className="inline-flex items-center gap-1.5"><ShieldCheck size={13} className="text-teal" /> {t('companyBrainPage.usedEverywhere')} <Link to="/app/marketing" className="text-violet hover:underline"><Target size={11} className="inline" /> {t('companyBrainPage.strategyLink')}</Link>, <Link to="/app/content" className="text-violet hover:underline"><PenLine size={11} className="inline" /> {t('companyBrainPage.contentLink')}</Link></span>
      </div>

      {loading ? (
        <div className="card mt-4 flex items-center gap-2 rounded-3xl p-6 text-sm text-muted"><Loader2 size={15} className="animate-spin" /> {t('common.loading')}</div>
      ) : (
        <div className="card mt-4 space-y-4 rounded-3xl p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <label key={f.k} className={f.area ? 'space-y-1.5 sm:col-span-2' : 'space-y-1.5'}>
                <span className="block text-xs font-medium uppercase tracking-wide text-muted">{t(`companyBrainPage.${f.k}Label`)}</span>
                {f.area ? (
                  <textarea value={p[f.k]} onChange={(e) => set(f.k, e.target.value)} rows={3} placeholder={t(`companyBrainPage.${f.k}Ph`)} className="glass w-full resize-y rounded-xl px-3 py-2.5 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
                ) : (
                  <input value={p[f.k]} onChange={(e) => set(f.k, e.target.value)} placeholder={t(`companyBrainPage.${f.k}Ph`)} className="glass w-full rounded-xl px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
                )}
              </label>
            ))}
          </div>

          <div className="flex items-center gap-3 pt-1">
            <Button onClick={save} disabled={saving || !accountId}>
              {saving ? <><Loader2 size={15} className="animate-spin" /> {t('companyBrainPage.saving')}</> : saved ? <><Check size={15} /> {t('companyBrainPage.savedBtn')}</> : <>{t('companyBrainPage.saveProfile')}</>}
            </Button>
            {saved && <span className="text-xs text-teal">{t('companyBrainPage.savedNote')} ✓</span>}
            {!accountId && <span className="text-xs text-amber">{t('companyBrainPage.loginToSave')}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
