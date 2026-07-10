import { useState } from 'react'
import { Factory, Target, PenLine, BarChart3, Clapperboard, Cpu, Rocket, Film, Swords, Globe2 } from 'lucide-react'
import { FactoryAutopilotPanel } from '../../components/platform/FactoryAutopilotPanel'
import { CompetitorTeamPanel } from '../../components/platform/CompetitorTeamPanel'
import { MultiLangPanel } from '../../components/platform/MultiLangPanel'
import { ChannelWatchPanel } from '../../components/platform/ChannelWatchPanel'
import { MarketingStrategyPanel } from '../../components/platform/MarketingStrategyPanel'
import { ContentTeamPanel } from '../../components/platform/ContentTeamPanel'
import { ContentAnalyzePanel } from '../../components/platform/ContentAnalyzePanel'
import { VideoRenderPanel } from '../../components/platform/VideoRenderPanel'
import { MediaConnectPanel } from '../../components/platform/MediaConnectPanel'
import { MODEL_CATALOG, MODEL_CATEGORIES, DEFAULT_MODEL } from '../../lib/models'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'

/**
 * Content Factory — one hub where the marketing team plans the strategy, the content
 * team writes, the analysis team studies content and creates from it, and generative
 * media (image/video/avatars/editor) plugs in. Tabs switch between the stages.
 */
type Tab = 'autopilot' | 'battle' | 'multilang' | 'strategy' | 'content' | 'video' | 'analyze' | 'media'

// model categories are stable RU keys in the catalog; map them to i18n for display
const MODEL_CAT_KEY: Record<string, string> = {
  'Быстрые': 'dataUi.modelFast',
  'Стандартные': 'dataUi.modelStandard',
  'Премиум': 'dataUi.modelPremium',
}

export default function ContentStudioPage() {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('autopilot')
  const [model, setModel] = useState(DEFAULT_MODEL)
  const TABS: { id: Tab; label: string; icon: typeof Target; hint: string }[] = [
    { id: 'autopilot', label: t('contentStudioPage.tabAutopilot'), icon: Rocket, hint: t('contentStudioPage.hintAutopilot') },
    { id: 'battle', label: t('contentStudioPage.tabBattle'), icon: Swords, hint: t('contentStudioPage.hintBattle') },
    { id: 'multilang', label: t('contentStudioPage.tabMultilang'), icon: Globe2, hint: t('contentStudioPage.hintMultilang') },
    { id: 'strategy', label: t('contentStudioPage.tabStrategy'), icon: Target, hint: t('contentStudioPage.hintStrategy') },
    { id: 'content', label: t('contentStudioPage.tabContent'), icon: PenLine, hint: t('contentStudioPage.hintContent') },
    { id: 'video', label: t('contentStudioPage.tabVideo'), icon: Film, hint: t('contentStudioPage.hintVideo') },
    { id: 'analyze', label: t('contentStudioPage.tabAnalyze'), icon: BarChart3, hint: t('contentStudioPage.hintAnalyze') },
    { id: 'media', label: t('contentStudioPage.tabMedia'), icon: Clapperboard, hint: t('contentStudioPage.hintMedia') },
  ]
  return (
    <div className="container-page max-w-4xl py-8">
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

      {/* tab bar */}
      <div className="mt-5 flex flex-wrap gap-2">
        {TABS.map((t) => {
          const on = tab === t.id
          return (
            <button key={t.id} onClick={() => setTab(t.id)} className={cn('group flex items-center gap-2 rounded-2xl border px-3.5 py-2 text-left transition', on ? 'border-violet/60 bg-violet/10' : 'border-ice/10 hover:border-ice/25')}>
              <t.icon size={16} className={on ? 'text-violet' : 'text-muted'} />
              <span>
                <span className={cn('block text-[13px] font-medium', on ? 'text-text' : 'text-muted')}>{t.label}</span>
                <span className="block text-[10.5px] text-fog">{t.hint}</span>
              </span>
            </button>
          )
        })}
      </div>

      <div className="mt-6">
        {tab === 'autopilot' && <FactoryAutopilotPanel model={model} />}
        {tab === 'battle' && <CompetitorTeamPanel model={model} />}
        {tab === 'multilang' && (
          <div className="space-y-8">
            <ChannelWatchPanel />
            <div>
              <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-fog">
                <span className="h-px flex-1 bg-ice/10" />{t('channelWatch.orManual')}<span className="h-px flex-1 bg-ice/10" />
              </div>
              <MultiLangPanel model={model} />
            </div>
          </div>
        )}
        {tab === 'strategy' && <MarketingStrategyPanel model={model} />}
        {tab === 'content' && <ContentTeamPanel model={model} />}
        {tab === 'video' && <VideoRenderPanel model={model} />}
        {tab === 'analyze' && <ContentAnalyzePanel model={model} />}
        {tab === 'media' && <MediaConnectPanel />}
      </div>
    </div>
  )
}
