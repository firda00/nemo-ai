// Mounted margin-card harness entry: renders the REAL MarginChatCard (real i18n, real cache
// and scope helpers) against the scenario-driven mock supabase and the reactive mock auth that
// esbuild aliases in. The smoke flips the signed-in identity WHILE the card is mounted.
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../../src/i18n'
import { MarginChatCard } from '../../src/components/finance/MarginChatCard'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any
const root = createRoot(document.getElementById('root')!)
let mountSeq = 0

g.__mountMargin = (scenario: Record<string, unknown>) => {
  g.__margin = scenario
  g.__marginCalls.length = 0
  mountSeq += 1
  const file = new File([new Uint8Array(64)], 'sales.xlsx')
  root.render(
    <I18nProvider>
      <MarginChatCard key={mountSeq} runKey={mountSeq} file={file} />
    </I18nProvider>,
  )
}
g.__harnessReady = true
