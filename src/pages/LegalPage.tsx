import { MarketingFooter } from '../components/layout/MarketingFooter'
import { MarketingHeader } from '../components/layout/MarketingHeader'
import { useI18n } from '../i18n'
import { privacyFor, termsFor, type LegalDocument } from '../content/legal'

/*
 * Юридические страницы.
 *
 * ТЕКСТ ЖИВЁТ В src/content/legal.ts, а не здесь. Юрист правит текст, а не разметку: отдать на
 * вычитку файл с абзацами на трёх языках можно, отдать компонент с JSX — нет.
 *
 * ЯЗЫК БЕРЁТСЯ ИЗ ИНТЕРФЕЙСА. Прежняя версия была только на английском, а продукт продаётся в
 * Узбекистане: договор, который покупатель не может прочитать на своём языке, юридически шаток и
 * просто невежлив.
 */

export function PrivacyPage() {
  const { lang } = useI18n()
  return <LegalDoc doc={privacyFor(lang)} />
}

export function TermsPage() {
  const { lang } = useI18n()
  return <LegalDoc doc={termsFor(lang)} />
}

function LegalDoc({ doc }: { doc: LegalDocument }) {
  return (
    <div className="min-h-screen bg-bg">
      <MarketingHeader />
      <main className="container-page mx-auto max-w-3xl space-y-6 py-12 text-sm leading-relaxed text-muted">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold text-text">{doc.title}</h1>
          {/* Дата вступления в силу на видном месте: без неё непонятно, какую редакцию человек принял. */}
          <p className="text-xs text-muted">{doc.updated}</p>
        </header>
        <p>{doc.intro}</p>
        {doc.sections.map((section) => (
          <section key={section.heading} className="space-y-2">
            <h2 className="pt-4 text-xl font-semibold text-text">{section.heading}</h2>
            {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
          </section>
        ))}
      </main>
      <MarketingFooter />
    </div>
  )
}
