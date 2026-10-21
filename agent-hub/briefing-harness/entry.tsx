// Mounted-form harness entry: renders the REAL BriefingPanel (real i18n provider, real bounded
// helpers) against the scenario-driven mock supabase module that esbuild aliases in.
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../../src/i18n'
import { BriefingPanel } from '../../src/components/settings/BriefingPanel'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any
const root = createRoot(document.getElementById('root')!)

g.__mount = (scenario: Record<string, unknown>) => {
  g.__briefing = scenario
  g.__briefingCalls.length = 0
  root.render(
    <I18nProvider>
      <BriefingPanel key={String(Math.random())} />
    </I18nProvider>,
  )
}
g.__harnessReady = true
