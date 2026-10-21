import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from '../../src/i18n'
import { SmartTaskDesk } from '../../src/components/platform/SmartTaskDesk'
import '../../src/index.css'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any
const root = createRoot(document.getElementById('root')!)
g.__mountFrontierDesk = () => {
  root.render(<I18nProvider><MemoryRouter><SmartTaskDesk /></MemoryRouter></I18nProvider>)
}
g.__frontierReady = true
