// Mounted DESK harness: renders the REAL SmartTaskDesk (real router context, real store, real
// i18n, real documentJobs client and DocumentChatCard) against the scenario-driven mock
// supabase and the reactive mock auth. The smoke seeds durable job metadata BEFORE mounting
// and proves identity-scoped turn restoration polls existing jobs without generation/enqueue.
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from '../../src/i18n'
import { SmartTaskDesk } from '../../src/components/platform/SmartTaskDesk'
import { rememberDocumentJob, type StoredDocumentJob } from '../../src/lib/documentJobs'
import { classifyDocumentChatIntent } from '../../src/lib/documentChatIntent'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any
const root = createRoot(document.getElementById('root')!)
let mountSeq = 0

g.__docClickedUrls = g.__docClickedUrls ?? []
const originalAnchorClick = HTMLAnchorElement.prototype.click
HTMLAnchorElement.prototype.click = function patchedClick(this: HTMLAnchorElement) {
  if (this.href.startsWith('https://signed.example/')) {
    g.__docClickedUrls.push(this.href)
    return
  }
  originalAnchorClick.call(this)
}

g.__seedDocumentJob = (userKey: string, meta: StoredDocumentJob) => rememberDocumentJob(userKey, meta)
// диагностика смоука: классификатор из ТОГО ЖЕ бандла, что использует смонтированный desk
g.__classifyDocumentIntent = (message: string) => classifyDocumentChatIntent(message)

g.__mountDesk = (scenario: Record<string, unknown>) => {
  g.__doc = scenario
  g.__docCalls.length = 0
  g.__docStatusPolls = 0
  mountSeq += 1
  // Commit this mount before the driver waits: otherwise it can find the old
  // desk's textarea while React still has the replacement render queued.
  flushSync(() => root.render(
    <I18nProvider key={mountSeq}>
      <MemoryRouter>
        <SmartTaskDesk key={mountSeq} />
      </MemoryRouter>
    </I18nProvider>,
  ))
}
g.__harnessReady = true
