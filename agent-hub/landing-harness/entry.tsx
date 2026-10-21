import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { I18nProvider } from '../../src/i18n'
import LandingPage from '../../src/pages/LandingPage'
import WaitlistPage from '../../src/pages/app/WaitlistPage'
import AuthPage from '../../src/pages/AuthPage'
import '../../src/index.css'
createRoot(document.getElementById('root')!).render(<I18nProvider><BrowserRouter><Routes><Route path="/waitlist" element={<WaitlistPage />} /><Route path="/auth/*" element={<AuthPage />} /><Route path="*" element={<LandingPage />} /></Routes></BrowserRouter></I18nProvider>)
