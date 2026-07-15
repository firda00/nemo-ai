import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Menu, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useAuth } from '../../context/AuthContext'
import { Logo } from '../ui/Logo'
import { Button } from '../ui/Button'
import { LanguageToggle } from '../ui/LanguageToggle'

export function MarketingHeader() {
  const { t, lang } = useI18n()
  const { isAuthed } = useAuth()
  const [open, setOpen] = useState(false)

  const labels = {
    ru: ['Продукт', 'Сценарии', 'Как работает', 'Цены'],
    uz: ['Mahsulot', 'Ssenariylar', 'Qanday ishlaydi', 'Narxlar'],
    en: ['Product', 'Use cases', 'How it works', 'Pricing'],
  }[lang]
  const links = [
    { href: '#product', label: labels[0] },
    { href: '#templates', label: labels[1] },
    { href: '#workflow', label: labels[2] },
    { href: '/app/billing', label: labels[3] },
  ]

  return (
    <div className="sticky top-4 z-50 px-4">
      {/* floating glass pill nav on dark */}
      <div className="container-page">
        <div className="flex h-[60px] items-center justify-between rounded-pill border border-white/10 bg-panel/70 px-4 shadow-soft backdrop-blur-xl sm:px-6">
          <Link to="/" className="flex items-center" onClick={() => setOpen(false)}>
            <Logo />
          </Link>

          <nav className="hidden items-center gap-7 lg:flex">
            {links.map((l) => (
              <a key={l.href} href={l.href} className="text-sm font-medium text-muted transition-colors hover:text-text">
                {l.label}
              </a>
            ))}
          </nav>

          <div className="hidden items-center gap-3 lg:flex">
            <LanguageToggle />
            {isAuthed ? (
              <Button to="/app" size="sm">
                {t('nav.openApp')}
              </Button>
            ) : (
              <>
                <Link to="/auth" className="text-sm font-medium text-muted transition-colors hover:text-text">
                  {t('nav.login')}
                </Link>
                <Button to="/auth?mode=signup" size="sm" className="!bg-cyan !bg-none !text-[#041018] shadow-none hover:brightness-110">
                  {t('marketingHeader.book')}
                </Button>
              </>
            )}
          </div>

          <button className="rounded-full p-2 text-text lg:hidden" onClick={() => setOpen((v) => !v)} aria-label={t('common.menu')}>
            {open ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>

        {open && (
          <div className="mt-2 rounded-3xl border border-white/10 bg-panel/90 p-3 shadow-lg backdrop-blur-xl lg:hidden">
            <div className="flex flex-col gap-1">
              {links.map((l) => (
                <a key={l.href} href={l.href} onClick={() => setOpen(false)} className="rounded-xl px-3 py-2.5 text-sm font-medium text-muted hover:bg-white/5 hover:text-text">
                  {l.label}
                </a>
              ))}
              <div className="mt-2 flex items-center justify-between gap-3 px-1">
                <LanguageToggle />
                <Button to="/auth?mode=signup" size="sm" className="!bg-cyan !bg-none !text-[#041018] shadow-none hover:brightness-110">
                  {t('marketingHeader.book')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
