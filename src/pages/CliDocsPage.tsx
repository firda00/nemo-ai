import { useState } from 'react'
import { Check, Copy, Terminal } from 'lucide-react'
import { MarketingFooter } from '../components/layout/MarketingFooter'
import { MarketingHeader } from '../components/layout/MarketingHeader'
import { useI18n } from '../i18n'
import { COMMAND_GROUPS, INSTALL_TABS, NODE_REQUIREMENT, UI, type Lang } from '../content/cliDocs'
import { cn } from '../lib/cn'

/*
 * Документация CLI.
 *
 * Текст живёт в src/content/cliDocs.ts — здесь только вёрстка. Команды правят отдельно от разметки,
 * и сверять их с настоящим поведением CLI проще в одном файле, чем выискивая по JSX.
 */

/**
 * Кнопка копирования.
 *
 * ПОДТВЕРЖДЕНИЕ ОБЯЗАТЕЛЬНО. Копирование ничего не меняет на экране, и без отклика человек жмёт
 * второй раз, потом идёт проверять буфер. Две секунды галочки снимают этот вопрос.
 *
 * Отказ буфера тоже показывается: navigator.clipboard недоступен без защищённого соединения, и
 * молчаливая неудача выглядит как «кнопка не работает».
 */
function CopyButton({ text, lang }: { text: string; lang: Lang }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('нет доступа к буферу')
      await navigator.clipboard.writeText(text)
      setState('done')
    } catch {
      setState('failed')
    }
    setTimeout(() => setState('idle'), 2000)
  }

  return (
    <button
      onClick={copy}
      aria-label={UI.copy[lang]}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ice/12 px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:border-ice/25 hover:text-text"
    >
      {state === 'done' ? <Check size={13} className="text-teal" /> : <Copy size={13} />}
      {state === 'done' ? UI.copied[lang] : state === 'failed' ? UI.copyFailed[lang] : UI.copy[lang]}
    </button>
  )
}

export default function CliDocsPage() {
  const { lang } = useI18n()
  const active = (lang as Lang) ?? 'ru'
  const [tab, setTab] = useState(INSTALL_TABS[0].id)
  const current = INSTALL_TABS.find((one) => one.id === tab) ?? INSTALL_TABS[0]

  return (
    <div className="theme-dark-scope min-h-screen overflow-x-clip">
      <MarketingHeader />

      <main className="container-page px-4 py-14 sm:py-20">
        <div className="mx-auto max-w-3xl">
          <p className="inline-flex items-center gap-2 rounded-pill border border-ice/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-cyan">
            <Terminal size={13} /> {UI.badge[active]}
          </p>
          <h1 className="mt-5 text-4xl font-bold leading-tight text-text sm:text-5xl">
            {UI.title[active]}
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted">
            {UI.lede[active]} {UI.needs[active]} {NODE_REQUIREMENT}.
          </p>

          {/* ── Установка ─────────────────────────────────────────────────────────── */}
          <section id="install" className="mt-12">
            <h2 className="text-lg font-semibold text-text">{UI.install[active]}</h2>

            <div className="no-scrollbar mt-4 flex gap-2 overflow-x-auto pb-1">
              {INSTALL_TABS.map((one) => (
                <button
                  key={one.id}
                  onClick={() => setTab(one.id)}
                  className={cn(
                    'shrink-0 whitespace-nowrap rounded-pill border px-3.5 py-1.5 text-xs font-medium transition',
                    one.id === tab
                      ? 'border-violet/60 bg-violet/10 text-text'
                      : 'border-ice/10 text-muted hover:border-ice/25 hover:text-text',
                  )}
                >
                  {one.label[active]}
                </button>
              ))}
            </div>

            <div className="mt-3 overflow-hidden rounded-2xl border border-ice/10 bg-black/30">
              <div className="flex items-start justify-between gap-3 border-b border-ice/[0.07] px-4 py-2.5">
                <span className="text-[11px] font-medium uppercase tracking-wider text-fog">
                  {current.label[active]}
                </span>
                <CopyButton text={current.command} lang={active} />
              </div>
              <pre className="overflow-x-auto px-4 py-4 text-[13px] leading-relaxed text-cyan">
                {current.command}
              </pre>
            </div>
            <p className="mt-2.5 text-sm leading-relaxed text-muted">{current.note[active]}</p>

          </section>

          {/* ── Команды ───────────────────────────────────────────────────────────── */}
          <section id="commands" className="mt-14">
            <h2 className="text-lg font-semibold text-text">{UI.commands[active]}</h2>

            <div className="mt-5 space-y-8">
              {COMMAND_GROUPS.map((group) => (
                <div key={group.title.en}>
                  <h3 className="text-[11px] font-semibold uppercase tracking-widest text-fog">
                    {group.title[active]}
                  </h3>
                  <div className="mt-3 divide-y divide-ice/[0.07] overflow-hidden rounded-2xl border border-ice/10">
                    {group.rows.map((row) => (
                      <div
                        key={row.command}
                        className="flex flex-col gap-1.5 px-4 py-3.5 sm:flex-row sm:items-baseline sm:gap-5"
                      >
                        <code className="shrink-0 whitespace-nowrap text-[13px] text-cyan sm:w-56">
                          {row.command}
                        </code>
                        <span className="text-sm leading-relaxed text-muted">{row.what[active]}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/*
            Честная оговорка, а не мелкий шрифт. Вход опознаёт человека, но обращения к модели не
            оплачивает: запросы идут по личному ключу. Умолчать об этом — значит, что человек
            установит, войдёт и упрётся в отказ, не понимая, чего от него хотят.
          */}
          <section className="mt-14 rounded-2xl border border-ice/10 bg-black/20 p-5">
            <h2 className="text-sm font-semibold text-text">{UI.billingTitle[active]}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">{UI.billingBody[active]}</p>
          </section>
        </div>
      </main>

      <MarketingFooter />
    </div>
  )
}
