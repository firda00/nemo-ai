import { Target } from 'lucide-react'
import { MarketingStrategyPanel } from '../../components/platform/MarketingStrategyPanel'
import { useI18n } from '../../i18n'
import { ContentSalesNav } from '../../components/platform/ContentSalesNav'

/** Standalone route kept for direct links; the same panel also lives in the Content Factory. */
export default function MarketingStrategyPage() {
  const { t } = useI18n()
  return (
    <div className="container-page max-w-4xl py-8">
      <ContentSalesNav active="marketing" />
      <div className="mb-5 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet/15 text-violet"><Target size={20} /></span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-text">{t('marketingStrategyPage.title')}</h1>
          <p className="text-sm text-muted">{t('marketingStrategyPage.subtitle')}</p>
        </div>
      </div>
      <MarketingStrategyPanel />
    </div>
  )
}
