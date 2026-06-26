import { Link } from 'react-router-dom'
import { useI18n } from '../../i18n'
import { Logo } from '../ui/Logo'

export function MarketingFooter() {
  const { t } = useI18n()
  const year = new Date().getFullYear()

  const cols = [
    {
      title: t('landing.footer.product'),
      links: [
        { label: t('nav.howItWorks'), href: '#how' },
        { label: t('nav.features'), href: '#features' },
        { label: t('nav.pricing'), href: '#pricing' },
        { label: t('nav.faq'), href: '#faq' },
      ],
    },
    {
      title: t('landing.footer.company'),
      links: [
        { label: 'Ustudy IT', href: '#' },
        { label: t('nav.scenarios'), href: '#scenarios' },
      ],
    },
    {
      title: t('landing.footer.legal'),
      links: [
        { label: t('landing.footer.privacy'), href: '#' },
        { label: t('landing.footer.terms'), href: '#' },
      ],
    },
  ]

  return (
    <footer className="border-t border-ink/[0.08] bg-cream">
      <div className="container-page py-16">
        <div className="grid gap-10 md:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-2">
            <Logo />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted">{t('landing.footer.tagline')}</p>
            <div className="mt-5 inline-flex items-center gap-2 rounded-pill border border-white/10 bg-white/5 px-3 py-1">
              <span className="h-1.5 w-1.5 rounded-full bg-teal" />
              <span className="text-xs font-medium text-text">{t('common.beta')}</span>
            </div>
          </div>
          {cols.map((c) => (
            <div key={c.title}>
              <h4 className="text-sm font-medium text-ink">{c.title}</h4>
              <ul className="mt-4 space-y-2.5">
                {c.links.map((l) => (
                  <li key={l.label}>
                    <a href={l.href} className="text-sm text-muted transition-colors hover:text-ink">
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-ink/[0.08] pt-6 text-xs text-fog sm:flex-row">
          <span>© {year} Nemo AI · {t('landing.footer.rights')}</span>
          <span>{t('landing.footer.madeBy')}</span>
          <Link to="/auth" className="text-fog hover:text-ink">{t('nav.login')}</Link>
        </div>
      </div>
    </footer>
  )
}
