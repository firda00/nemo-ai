// Mounted document-card harness entry: renders the REAL DocumentChatCard (real i18n, real
// session-scope helper, real documentJobs client and the real generation step) against the
// scenario-driven mock supabase and the reactive mock auth that esbuild aliases in.
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../../src/i18n'
import { DocumentChatCard } from '../../src/components/documents/DocumentChatCard'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any
const root = createRoot(document.getElementById('root')!)
let mountSeq = 0

// the card clicks a DETACHED anchor (document listeners never see it): record the clicked
// URL and swallow navigation for the signed-link host so the harness page stays put
g.__docClickedUrls = g.__docClickedUrls ?? []
const originalAnchorClick = HTMLAnchorElement.prototype.click
HTMLAnchorElement.prototype.click = function patchedClick(this: HTMLAnchorElement) {
  if (this.href.startsWith('https://signed.example/')) {
    g.__docClickedUrls.push(this.href)
    return
  }
  originalAnchorClick.call(this)
}

g.__mountDocument = (scenario: Record<string, unknown>, props: Record<string, unknown> = {}) => {
  g.__doc = scenario
  g.__docCalls.length = 0
  g.__docStatusPolls = 0
  mountSeq += 1
  root.render(
    <I18nProvider key={mountSeq}>
      <DocumentChatCard
        key={mountSeq}
        runKey={mountSeq}
        kind={(props.kind as 'docx_document' | 'pptx_presentation') ?? 'docx_document'}
        title={(props.title as string) ?? 'Итоги месяца'}
        brief={(props.brief as string) ?? 'Сделай Word: итоги месяца'}
        submissionId={(props.submissionId as string) ?? crypto.randomUUID()}
        pollTimeoutMs={props.pollTimeoutMs as number | undefined}
      />
    </I18nProvider>,
  )
}
g.__harnessReady = true
