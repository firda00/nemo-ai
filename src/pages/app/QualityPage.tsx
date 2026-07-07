import { AlertTriangle, CheckCircle2, Gauge, ShieldCheck } from 'lucide-react'
import { useI18n } from '../../i18n'

const checks = [
  ['Factual accuracy', '96%', 'Pass', 'Answer grounded in Company Brain sources.'],
  ['Tone match', '92%', 'Pass', 'Reply follows brand voice and support style.'],
  ['Conversion intent', '88%', 'Pass', 'Asked for phone number after confirming need.'],
  ['Policy compliance', '100%', 'Pass', 'No restricted claims or unsafe promises.'],
  ['Escalation needed', 'Low', 'Watch', 'Human not required, but refund keywords monitored.'],
]

export default function QualityPage() {
  const { t } = useI18n()
  return (
    <div className="container-page max-w-7xl py-8">
      <div>
        <p className="mono-label">{t('qualityPage.eyebrow')}</p>
        <h1 className="mt-2 text-3xl font-extrabold text-text">{t('qualityPage.title')}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{t('qualityPage.subtitle')}</p>
      </div>

      <div className="mt-8 grid gap-5 lg:grid-cols-[0.85fr_1.15fr]">
        <div className="gradient-ring rounded-3xl p-px">
          <div className="rounded-[1.45rem] bg-panel/90 p-6 text-center">
            <Gauge className="mx-auto text-teal" size={40} />
            <p className="mt-5 text-6xl font-black text-teal">94</p>
            <p className="mt-2 text-sm font-semibold text-text">{t('qualityPage.score')}</p>
            <p className="mt-3 text-sm leading-relaxed text-muted">{t('qualityPage.scoreDesc')}</p>
          </div>
        </div>

        <div className="card rounded-3xl p-6">
          <h2 className="flex items-center gap-2 text-xl font-bold text-text"><ShieldCheck className="text-violet" /> {t('qualityPage.latest')}</h2>
          <div className="mt-5 space-y-3">
            {checks.map(([name, score, status, desc]) => (
              <div key={name} className="grid gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-4 sm:grid-cols-[1fr_auto]">
                <div>
                  <p className="font-medium text-text">{name}</p>
                  <p className="mt-1 text-xs text-muted">{desc}</p>
                </div>
                <div className="flex items-center gap-3 sm:justify-end">
                  <span className="font-bold text-text">{score}</span>
                  <span className={`inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-xs ${status === 'Pass' ? 'bg-teal/10 text-teal' : 'bg-amber/10 text-amber'}`}>
                    {status === 'Pass' ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />} {status === 'Pass' ? t('qualityPage.pass') : t('qualityPage.watch')}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
