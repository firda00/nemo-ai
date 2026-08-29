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
    ru: ['Возможности', 'Сценарии', 'Как работает', 'Цены'],
    uz: ['Imkoniyatlar', 'Ssenariylar', 'Qanday ishlaydi', 'Narxlar'],
    en: ['Capabilities', 'Use cases', 'How it works', 'Pricing'],
  }[lang]
  const links = [
    { href: '/#capabilities', label: labels[0] },
    { href: '/#templates', label: labels[1] },
    { href: '/#product', label: labels[2] },
    { href: '/pricing', label: labels[3] },
    { href: '/docs/cli', label: 'CLI' },
  ]

  /*
   * ПОЛОСА ВО ВСЮ ШИРИНУ, ПРИЖАТАЯ К ВЕРХУ.
   *
   * Здесь была плавающая «таблетка» (sticky top-4, скруглённая, с отступами по краям). Прилипала
   * она исправно, но при прокрутке под ней просвечивало содержимое по бокам. Полоса с нижней
   * границей отделяет шапку от страницы на всю ширину окна.
   *
   * Цвет — ТОКЕНАМИ, а не slate-950/slate-800. Приложение живёт в двух темах, и прибитый тёмный
   * фон дал бы на светлой тёмную шапку над светлой страницей. bg-bg/80 берёт тот же тон, что и
   * страница, и остаётся верным в обеих.
   */
  return (
    <header className="sticky top-0 z-50 w-full border-b border-ice/10 bg-bg/80 backdrop-blur-md">
      <div className="container-page px-4">
        <div className="flex h-16 items-center justify-between">
          <Link to="/" className="flex items-center" onClick={() => setOpen(false)}>
            <Logo variant="neon" size={36} />
          </Link>

          <nav className="hidden items-center gap-7 lg:flex">
            {links.map((l) => (
              <a key={l.href} href={l.href} className="text-sm font-medium text-muted transition-colors hover:text-text">
                {l.label}
              </a>
            ))}
          </nav>

          <div className="hidden items-center gap-3 lg:flex">
            <div className="mr-2"><LanguageToggle /></div>
            {isAuthed ? (
              <Button to="/app" size="sm">
                {t('nav.openApp')}
              </Button>
            ) : (
              <>
                <Link to="/app" className="text-sm font-medium text-muted transition-colors hover:text-text">
                  {t('nav.login')}
                </Link>
                <Button to="/app" size="sm" className="!bg-[linear-gradient(135deg,#42edf5_0%,#b74cff_100%)] !text-[#050816] shadow-[0_12px_32px_-16px_rgba(66,237,245,0.9)] hover:brightness-110">
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
          <div className="mb-3 rounded-2xl border border-ice/10 bg-panel p-3 shadow-lg lg:hidden">
            <div className="flex flex-col gap-1">
              {links.map((l) => (
                <a key={l.href} href={l.href} onClick={() => setOpen(false)} className="rounded-xl px-3 py-2.5 text-sm font-medium text-muted hover:bg-white/5 hover:text-text">
                  {l.label}
                </a>
              ))}
              <div className="mt-2 flex items-center justify-between gap-3 px-1">
                <LanguageToggle />
                <Button to="/app" size="sm" className="!bg-[linear-gradient(135deg,#42edf5_0%,#b74cff_100%)] !text-[#050816] shadow-[0_12px_32px_-16px_rgba(66,237,245,0.9)] hover:brightness-110">
                  {t('marketingHeader.book')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </header>
  )
}
