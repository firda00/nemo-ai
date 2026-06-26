import { Rocket } from 'lucide-react'
import { useI18n } from '../../i18n'
import { EmptyState } from '../../components/ui/EmptyState'
import { Button } from '../../components/ui/Button'

export default function ComingSoonPage() {
  const { t } = useI18n()
  return (
    <div className="container-page max-w-3xl py-12">
      <EmptyState
        icon={Rocket}
        title={t('platform.comingSoon.title')}
        desc={t('platform.comingSoon.desc')}
        action={
          <Button to="/app" size="sm">
            {t('platform.nav.dashboard')}
          </Button>
        }
      />
    </div>
  )
}
