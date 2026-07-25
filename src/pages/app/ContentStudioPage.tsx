import { useSearchParams } from 'react-router-dom'
import { Factory, Target, PenLine, BarChart3, Clapperboard, Cpu, Rocket, Film, Swords, Globe2, Radar, Wrench } from 'lucide-react'
import { FactoryAutopilotPanel } from '../../components/platform/FactoryAutopilotPanel'
import { CompetitorTeamPanel } from '../../components/platform/CompetitorTeamPanel'
import { MultiLangPanel } from '../../components/platform/MultiLangPanel'
import { ChannelWatchPanel } from '../../components/platform/ChannelWatchPanel'
import { MarketingStrategyPanel } from '../../components/platform/MarketingStrategyPanel'
import { ContentTeamPanel } from '../../components/platform/ContentTeamPanel'
import { ContentAnalyzePanel } from '../../components/platform/ContentAnalyzePanel'
import { VideoRenderPanel } from '../../components/platform/VideoRenderPanel'
import { MediaConnectPanel } from '../../components/platform/MediaConnectPanel'
import { CoordinatorAgentPanel } from '../../components/platform/CoordinatorAgentPanel'
import { MODEL_CATALOG, MODEL_CATEGORIES, DEFAULT_MODEL } from '../../lib/models'
import { useState } from 'react'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'
import { ContentSalesNav } from '../../components/platform/ContentSalesNav'

/**
 * Content Factory — simplified to THREE top-level groups so the first screen is
 * one decision, not eight:
 *   «Autopilot» (default) — the one-click full cycle, with the coordinator agent;
 *   «Studio»   — production: video assembly + media engines;
 *   «Tools»    — advanced modes (strategy / content team / analysis / competitor
 *                battle / multilang / channel watch) behind an inner selector.
 * Every previous capability is preserved. Old deep links keep working: the LEAF
 * ids in ?tab= are unchanged (plus 'watch' for the channel-watch tool, which was
 * previously buried inside multilang) and unknown values fall back to Autopilot.
 */
type Leaf = 'autopilot' | 'video' | 'media' | 'strategy' | 'content' | 'analyze' | 'battle' | 'multilang' | 'watch'
type Group = 'autopilot' | 'studio' | 'tools'

const LEAVES: Leaf[] = ['autopilot', 'video', 'media', 'strategy', 'content', 'analyze', 'battle', 'multilang', 'watch']
const GROUP_OF: Record<Leaf, Group> = {
  autopilot: 'autopilot',
  video: 'studio',
  media: 'studio',
  strategy: 'tools',
  content: 'tools',
  analyze: 'tools',
  battle: 'tools',
  multilang: 'tools',
  watch: 'tools',
}
const GROUP_DEFAULT: Record<Group, Leaf> = { autopilot: 'autopilot', studio: 'video', tools: 'strategy' }

// model categories are stable RU keys in the catalog; map them to i18n for display
const MODEL_CAT_KEY: Record<string, string> = {
  'Быстрые': 'dataUi.modelFast',
  'Стандартные': 'dataUi.modelStandard',
  'Премиум': 'dataUi.modelPremium',
}

export default function ContentStudioPage() {
  const { t } = useI18n()
  const [params, setParams] = useSearchParams()
  const [model, setModel] = useState(DEFAULT_MODEL)
  const rawTab = params.get('tab') ?? ''
  const tab: Leaf = (LEAVES as string[]).includes(rawTab) ? (rawTab as Leaf) : 'autopilot'
  const group = GROUP_OF[tab]
  const openLeaf = (leaf: Leaf) => setParams(leaf === 'autopilot' ? {} : { tab: leaf }, { replace: true })

  const GROUPS: { id: Group; label: string; icon: typeof Target; hint: string }[] = [
    { id: 'autopilot', label: t('contentStudioPage.tabAutopilot'), icon: Rocket, hint: t('contentStudioPage.hintAutopilot') },
    { id: 'studio', label: t('contentStudioPage.groupStudio'), icon: Film, hint: t('contentStudioPage.groupStudioHint') },
    { id: 'tools', label: t('contentStudioPage.groupTools'), icon: Wrench, hint: t('contentStudioPage.groupToolsHint') },
  ]
  const TOOL_TABS: { id: Leaf; label: string; icon: typeof Target }[] = [
    { id: 'strategy', label: t('contentStudioPage.tabStrategy'), icon: Target },
    { id: 'content', label: t('contentStudioPage.tabContent'), icon: PenLine },
    { id: 'analyze', label: t('contentStudioPage.tabAnalyze'), icon: BarChart3 },
    { id: 'battle', label: t('contentStudioPage.tabBattle'), icon: Swords },
    { id: 'multilang', label: t('contentStudioPage.tabMultilang'), icon: Globe2 },
    { id: 'watch', label: t('contentStudioPage.tabWatch'), icon: Radar },
  ]
  const STUDIO_TABS: { id: Leaf; label: string; icon: typeof Target }[] = [
    { id: 'video', label: t('contentStudioPage.tabVideo'), icon: Film },
    { id: 'media', label: t('contentStudioPage.tabMedia'), icon: Clapperboard },
  ]
  const innerTabs = group === 'studio' ? STUDIO_TABS : group === 'tools' ? TOOL_TABS : []

  return (
    <div className="container-page max-w-7xl py-8">
      <ContentSalesNav active="content" />
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet/15 text-violet"><Factory size={20} /></span>
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight text-text">{t('contentStudioPage.title')}</h1>
          <p className="text-sm text-muted">{t('contentStudioPage.subtitle')}</p>
        </div>
        {tab !== 'media' && (
          <label className="flex items-center gap-2 rounded-xl border border-ice/10 bg-black/20 px-3 py-2">
            <Cpu size={15} className="text-violet" />
            <span className="text-[11px] text-muted">{t('contentStudioPage.model')}</span>
            <select value={model} onChange={(e) => setModel(e.target.value)} className="bg-transparent text-sm text-text outline-none">
              {MODEL_CATEGORIES.map((cat) => (
                <optgroup key={cat} label={t(MODEL_CAT_KEY[cat] ?? cat)} className="bg-panel">
                  {MODEL_CATALOG.filter((m) => m.category === cat).map((m) => (
                    <option key={m.id} value={m.id} className="bg-panel">{m.label}{m.premium ? ' 💎' : ''}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        )}
      </div>
      {tab !== 'media' && <p className="mt-2 text-[11px] text-fog">{t('contentStudioPage.premiumNote')}</p>}

      {/* group bar — one decision on the first screen */}
      <div className="mt-6 flex flex-wrap gap-2">
        {GROUPS.map((g) => {
          const on = group === g.id
          return (
            <button key={g.id} onClick={() => openLeaf(GROUP_DEFAULT[g.id])} className={cn('group flex items-center gap-2 rounded-2xl border px-3.5 py-2 text-left transition', on ? 'border-violet/60 bg-violet/10' : 'border-ice/10 hover:border-ice/25')}>
              <g.icon size={16} className={on ? 'text-violet' : 'text-muted'} />
              <span>
                <span className={cn('block text-[13px] font-medium', on ? 'text-text' : 'text-muted')}>{g.label}</span>
                <span className="block text-[10.5px] text-fog">{g.hint}</span>
              </span>
            </button>
          )
        })}
      </div>

      {/* inner tool selector for Studio / Tools */}
      {innerTabs.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {innerTabs.map((item) => {
            const on = tab === item.id
            return (
              <button key={item.id} onClick={() => openLeaf(item.id)} className={cn('flex items-center gap-1.5 rounded-pill border px-3 py-1.5 text-xs transition', on ? 'border-cyan/40 bg-cyan/15 text-cyan' : 'border-ice/[0.1] bg-white/[0.03] text-muted hover:text-text')}>
                <item.icon size={13} /> {item.label}
              </button>
            )
          })}
        </div>
      )}

      {/* the coordinator lives with Autopilot — the other groups stay focused */}
      {group === 'autopilot' && (
        <div className="mt-6">
          <CoordinatorAgentPanel
            mode="content"
            context={`Content Factory tab: ${tab}. Selected model: ${model}. The owner wants a clear explanation before any publication.`}
            liveStatus={'Готов принять бриф. Сначала проверю цель и формат, затем запущу исследование, написание и редакторскую проверку.'}
          />
        </div>
      )}

      <div className="mt-6">
        {tab === 'autopilot' && <FactoryAutopilotPanel model={model} />}
        {tab === 'battle' && <CompetitorTeamPanel model={model} />}
        {tab === 'watch' && <ChannelWatchPanel />}
        {tab === 'multilang' && <MultiLangPanel model={model} />}
        {tab === 'strategy' && <MarketingStrategyPanel model={model} />}
        {tab === 'content' && <ContentTeamPanel model={model} />}
        {tab === 'video' && <VideoRenderPanel model={model} />}
        {tab === 'analyze' && <ContentAnalyzePanel model={model} />}
        {tab === 'media' && <MediaConnectPanel />}
      </div>
    </div>
  )
}
