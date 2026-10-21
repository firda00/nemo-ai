// Mounted reminder-panel harness entry: renders the REAL ReminderPanel (real i18n, real
// bounded helpers, real session-scope ownership) against the per-user mock supabase and the
// reactive mock auth that esbuild aliases in.
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../../src/i18n'
import { ReminderPanel } from '../../src/components/settings/ReminderPanel'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any
const root = createRoot(document.getElementById('root')!)
let mountSeq = 0

g.__mountReminder = (scenarios: Record<string, unknown>) => {
  g.__reminder = scenarios
  g.__reminderCalls.length = 0
  mountSeq += 1
  root.render(
    // the provider is keyed too: a remount re-reads the language the smoke just set
    <I18nProvider key={mountSeq}>
      <ReminderPanel />
    </I18nProvider>,
  )
}
g.__harnessReady = true
