import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { I18nProvider } from '../../src/i18n'
import { ToastProvider } from '../../src/components/ui/Toast'
import ApprovalsPage from '../../src/pages/app/ApprovalsPage'
import DialoguesPage from '../../src/pages/app/DialoguesPage'
import './owner-mock'
import '../../src/index.css'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any
const root = createRoot(document.getElementById('root')!)
let key = 0
g.__mountOwner = (page = 'approvals') => {
  localStorage.setItem('nemo.lang', 'ru')
  root.render(<StrictMode><I18nProvider key={++key}><ToastProvider><MemoryRouter initialEntries={['/app/' + page]}><Routes>
    <Route path="/app/approvals" element={<ApprovalsPage />} /><Route path="/app/dialogues" element={<DialoguesPage />} />
  </Routes></MemoryRouter></ToastProvider></I18nProvider></StrictMode>)
}
globalThis.fetch = g.__ownerFetch
g.__ownerReady = true
