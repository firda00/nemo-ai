import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ClipboardList, User, Download, Repeat } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useAgentStore } from '../../store/useAgentStore'
import { AgentAvatar } from '../../components/ui/AgentAvatar'
import { EmptyState } from '../../components/ui/EmptyState'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { cn } from '../../lib/cn'
import { KnowledgeIntegrationNav } from '../../components/platform/KnowledgeIntegrationNav'

const live = isSupabaseEnabled

interface Lead {
  id: string
  dialogue_id?: string | null
  fields: Record<string, string>
  status: string
  created_at: string
}

export default function LeadsPage() {
  const { t } = useI18n()
  const agents = useAgentStore((s) => s.agents)
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(live)

  useEffect(() => {
    if (live && supabase) {
      supabase
        .from('leads')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50)
        .then(({ data }) => {
          setLeads((data ?? []) as Lead[])
          setLoading(false)
        })
    } else {
      window.setTimeout(() => setLoading(false), 0)
    }
  }, [])

  const fmtDate = (iso: string) => {
    const d = new Date(iso)
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  }

  // Export captured leads to a CSV (all dynamic fields + status + date). BOM so Excel reads Cyrillic.
  const exportCsv = () => {
    if (!leads.length) return
    const fieldKeys = Array.from(new Set(leads.flatMap((l) => Object.keys(l.fields ?? {}))))
    const headers = [...fieldKeys, 'status', 'created_at']
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const rows = leads.map((l) => [...fieldKeys.map((k) => l.fields?.[k] ?? ''), l.status ?? '', l.created_at ?? ''].map(esc).join(','))
    const csv = '﻿' + [headers.map(esc).join(','), ...rows].join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `nemo-leads-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="container-page max-w-5xl py-8">
      <KnowledgeIntegrationNav active="leads" />
      <h1 className="text-2xl font-normal tracking-tight text-text">{t('platform.nav.leadForms')}</h1>
      <p className="mt-1 text-sm text-muted">{t('platform.leads.subtitle')}</p>

      {/* lead-form config per agent */}
      <section className="card mt-6 rounded-2xl">
        <div className="border-b border-ice/[0.07] px-5 py-3.5">
          <h2 className="font-normal text-text">{t('platform.leads.configTitle')}</h2>
          <p className="mt-0.5 text-xs text-muted">{t('platform.leads.configDesc')}</p>
        </div>
        {agents.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">{t('platform.agents.empty')}</p>
        ) : (
          <ul className="divide-y divide-ice/[0.05]">
            {agents.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-5 py-3">
                <AgentAvatar color={a.avatarColor} glyph="search" size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-normal text-text">{a.name}</p>
                  <p className="text-[11px] text-muted">{a.leadForm.fields.length} {t('platform.leads.fields')}</p>
                </div>
                <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-normal', a.leadForm.enabled ? 'bg-teal/15 text-teal' : 'bg-ice/[0.06] text-muted')}>
                  {a.leadForm.enabled ? t('platform.leads.enabled') : t('platform.leads.disabled')}
                </span>
                <Link to={`/app/agents/${a.id}`} className="shrink-0 text-xs font-normal text-violet hover:underline">{t('platform.agents.edit')}</Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* captured leads */}
      <section className="card mt-5 rounded-2xl">
        <div className="flex items-center gap-2 border-b border-ice/[0.07] px-5 py-3.5">
          <ClipboardList size={16} className="text-violet" />
          <h2 className="font-normal text-text">{t('platform.leads.capturedTitle')}</h2>
          {leads.length > 0 && (
            <button onClick={exportCsv} className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-ice/12 px-2.5 py-1.5 text-[12px] font-medium text-muted transition hover:text-text">
              <Download size={13} /> {t('platform.leads.exportCsv')}
            </button>
          )}
        </div>
        {loading ? (
          <p className="px-5 py-10 text-center text-sm text-muted">{t('common.loading')}</p>
        ) : leads.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={User} title={t('platform.leads.empty')} />
          </div>
        ) : (
          <ul className="divide-y divide-ice/[0.05]">
            {leads.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                <span className="truncate text-text">{l.fields?.name ?? l.fields?.Ism ?? '—'}</span>
                <span className="truncate text-muted">{l.fields?.phone ?? l.fields?.Telefon ?? ''}</span>
                <span className="shrink-0 text-[11px] text-muted">{fmtDate(l.created_at)}</span>
                {l.dialogue_id && <Link to={`/app/followups?dialogue=${encodeURIComponent(l.dialogue_id)}&lead=${encodeURIComponent(l.id)}`} className="inline-flex items-center gap-1 rounded-lg border border-violet/20 px-2 py-1 text-[11px] text-violet hover:bg-violet/10"><Repeat size={11} /> {t('appLayout.navFollowups')}</Link>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
