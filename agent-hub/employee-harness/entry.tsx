import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { I18nProvider } from '../../src/i18n'
import EmployeesPage from '../../src/pages/app/EmployeesPage'
import { EMPLOYEE_PRESETS } from '../../src/data/employeePresets'
import '../../src/index.css'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any
const root = createRoot(document.getElementById('root')!)
let mountId = 0
function Location() {
  const location = useLocation()
  g.__employeeLocation = location.pathname + location.search
  return <output data-harness-location>{location.pathname}</output>
}
g.__employeePresets = EMPLOYEE_PRESETS
g.__mountEmployees = (lang: 'ru' | 'uz' | 'en' = 'ru', role = '') => {
  localStorage.setItem('nemo.lang', lang)
  root.render(<I18nProvider key={++mountId}><MemoryRouter initialEntries={['/app/employees' + (role ? '?role=' + role : '')]}><Location /><Routes>
    <Route path="/app/employees" element={<EmployeesPage />} />
    <Route path="/app/agents/:id" element={<div data-testid="saved-agent">Saved agent route</div>} />
  </Routes></MemoryRouter></I18nProvider>)
}
g.__employeeReady = true
