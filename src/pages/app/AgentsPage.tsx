import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Plus, Bot, Pencil, Copy, Trash2, MoreVertical, Users, ArrowRight } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useAgentStore } from '../../store/useAgentStore'
import { useToast } from '../../components/ui/Toast'
import { channelMeta, channelLabel, agentStatusStyle, agentTypeMeta } from '../../lib/platformMeta'
import { MODELS } from '../../data/platform'
import { AgentAvatar } from '../../components/ui/AgentAvatar'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { cn } from '../../lib/cn'

export default function AgentsPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const { agents, toggleAgent, duplicateAgent, deleteAgent } = useAgentStore()
  const [menu, setMenu] = useState<string | null>(null)
  const [toDelete, setToDelete] = useState<string | null>(null)
  const teamsView = location.pathname.startsWith('/app/teams')
  const visibleAgents = agents.filter((a) => teamsView ? a.type === 'workflow' : a.type !== 'workflow')

  const modelLabel = (id: string) => MODELS.find((m) => m.id === id)?.label ?? id

  return (
    <div className="container-page max-w-6xl py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-normal tracking-tight text-text">{teamsView ? t('agentsPage.teamsTitle') : t('agentsPage.agentsTitle')}</h1>
          <p className="mt-1 text-sm text-muted">{teamsView ? t('agentsPage.teamsSubtitle') : t('agentsPage.agentsSubtitle')}</p>
        </div>
        <Button to={teamsView ? '/app/create-team' : '/app/create-agent'} size="md">
          <Plus size={16} /> {teamsView ? t('agentsPage.createTeam') : t('agentsPage.createAgent')}
        </Button>
      </div>

      {visibleAgents.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon={Bot}
            title={teamsView ? t('agentsPage.emptyTeamsTitle') : t('agentsPage.emptyAgentsTitle')}
            desc={teamsView ? t('agentsPage.emptyTeamsDesc') : t('agentsPage.emptyAgentsDesc')}
            action={
              <Button to={teamsView ? '/app/create-team' : '/app/create-agent'} size="sm">
                <Plus size={15} /> {teamsView ? t('agentsPage.createTeam') : t('agentsPage.createAgent')}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visibleAgents.map((a) => (
            teamsView ? (
              // Simple, browsable AI-team card: name, one-line description, status, Open.
              <div key={a.id} className="card group relative flex min-h-[188px] flex-col rounded-2xl p-5">
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-violet/15 text-violet"><Users size={20} /></span>
                  <div className="min-w-0">
                    <p className="truncate font-medium text-text">{a.name}</p>
                    <span className={cn('mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-normal', agentStatusStyle[a.status])}>{t(`platform.agentStatus.${a.status}`)}</span>
                  </div>
                </div>
                <p className="mt-3 flex-1 text-sm leading-relaxed text-muted line-clamp-3">{a.purpose || a.prompt.tasks || t('agentsPage.teamCardFallback')}</p>
                <div className="mt-4 flex items-center gap-2">
                  <Button size="sm" className="flex-1" onClick={() => navigate(`/app/teams/${a.id}`)}>{t('agentsPage.openTeam')} <ArrowRight size={15} /></Button>
                  <button onClick={() => setToDelete(a.id)} className="rounded-lg p-2 text-muted hover:bg-ice/[0.06] hover:text-danger" aria-label={t('platform.agents.delete')}><Trash2 size={15} /></button>
                </div>
              </div>
            ) : (
            <div key={a.id} className="card group relative rounded-2xl p-5">
              <div className="flex items-start justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <AgentAvatar color={a.avatarColor} glyph="search" size="lg" />
                  <div className="min-w-0">
                    <p className="truncate font-normal text-text">{a.name}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className={cn('inline-block rounded-full px-2 py-0.5 text-[10px] font-normal', agentStatusStyle[a.status])}>
                        {t(`platform.agentStatus.${a.status}`)}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ background: `${agentTypeMeta[a.type].color}1f`, color: agentTypeMeta[a.type].color }}>
                        {(() => {
                          const TIcon = agentTypeMeta[a.type].Icon
                          return <TIcon size={10} />
                        })()}
                        {t(agentTypeMeta[a.type].key)}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="relative shrink-0">
                  <button onClick={() => setMenu(menu === a.id ? null : a.id)} aria-label={t('common.menu')} className="rounded-lg p-1.5 text-muted hover:bg-ice/[0.06]">
                    <MoreVertical size={16} />
                  </button>
                  {menu === a.id && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setMenu(null)} />
                      <div className="card absolute right-0 z-20 mt-1 w-44 rounded-xl p-1.5">
                        <MenuBtn icon={Pencil} label={a.type === 'workflow' ? t('agentsPage.openAiTeam') : t('agentsPage.editEmployee')} onClick={() => navigate(a.type === 'workflow' ? `/app/teams/${a.id}` : `/app/agents/${a.id}`)} />
                        <MenuBtn
                          icon={Copy}
                          label={t('platform.agents.duplicate')}
                          onClick={() => {
                            duplicateAgent(a.id)
                            setMenu(null)
                            toast(t('platform.toast.duplicated'))
                          }}
                        />
                        <MenuBtn
                          icon={Trash2}
                          label={t('platform.agents.delete')}
                          danger
                          onClick={() => {
                            setToDelete(a.id)
                            setMenu(null)
                          }}
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-1.5">
                {a.channels.length ? (
                  a.channels.map((c) => {
                    const meta = channelMeta[c]
                    return (
                      <span key={c} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium" style={{ background: `${meta.color}1f`, color: meta.color }}>
                        <meta.Icon size={12} /> {channelLabel(c, t)}
                      </span>
                    )
                  })
                ) : (
                  <span className="text-[11px] text-muted">—</span>
                )}
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-ice/[0.06] pt-3 text-xs text-muted">
                <span className="rounded-md bg-ice/[0.06] px-1.5 py-0.5 font-medium text-muted">{modelLabel(a.model)}</span>
                <span>
                  {a.dialoguesToday} {t('platform.agents.dialoguesToday')} · {a.lastActivity}
                </span>
              </div>

              <div className="mt-4 flex items-center gap-2">
                <Button size="sm" variant="ghost" className="flex-1" onClick={() => navigate(a.type === 'workflow' ? `/app/teams/${a.id}` : `/app/agents/${a.id}`)}>
                  <Pencil size={14} /> {a.type === 'workflow' ? t('agentsPage.openAiTeam') : t('agentsPage.editEmployee')}
                </Button>
                <button
                  onClick={() => toggleAgent(a.id)}
                  className={cn('relative h-7 w-12 shrink-0 rounded-full transition-colors', a.status === 'active' ? 'bg-teal' : 'bg-ice/15')}
                  role="switch"
                  aria-checked={a.status === 'active'}
                  title={a.status === 'active' ? t('platform.agents.disable') : t('platform.agents.enable')}
                >
                  <span className={cn('absolute top-0.5 h-6 w-6 rounded-full bg-ice shadow transition-all', a.status === 'active' ? 'left-[22px]' : 'left-0.5')} />
                </button>
              </div>
            </div>
            )
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!toDelete}
        title={t('platform.agents.deleteTitle')}
        message={t('platform.agents.deleteMsg')}
        confirmLabel={t('platform.agents.delete')}
        cancelLabel={t('common.cancel')}
        danger
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) {
            deleteAgent(toDelete)
            toast(t('platform.toast.deleted'))
          }
          setToDelete(null)
        }}
      />
    </div>
  )
}

function MenuBtn({ icon: Icon, label, onClick, danger }: { icon: typeof Pencil; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm hover:bg-ice/[0.05]',
        danger ? 'text-danger' : 'text-muted hover:text-text',
      )}
    >
      <Icon size={15} /> {label}
    </button>
  )
}
