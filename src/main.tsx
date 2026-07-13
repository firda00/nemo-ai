import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { I18nProvider } from './i18n'
import { AuthProvider } from './context/AuthContext'
import { ToastProvider } from './components/ui/Toast'
import { initMonitoring, Sentry } from './lib/monitoring'

initMonitoring()

createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <Sentry.ErrorBoundary fallback={<div className="grid min-h-screen place-items-center bg-bg p-6 text-center text-text"><div><h1 className="text-xl">Nemo временно не смог открыть экран</h1><p className="mt-2 text-sm text-muted">Ошибка уже записана. Обновите страницу — ваши данные не удалены.</p></div></div>}>
            <App />
          </Sentry.ErrorBoundary>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  </I18nProvider>,
)
