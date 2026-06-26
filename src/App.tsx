import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from './context/AuthContext'
import { AppLayout } from './components/layout/AppLayout'
import LandingPage from './pages/LandingPage'
import AuthPage from './pages/AuthPage'
import OnboardingPage from './pages/OnboardingPage'
import DashboardPage from './pages/app/DashboardPage'
import AgentsPage from './pages/app/AgentsPage'
import AgentEditorPage from './pages/app/AgentEditorPage'
import ResearchPage from './pages/app/ResearchPage'
import DialoguesPage from './pages/app/DialoguesPage'
import AnalyticsPage from './pages/app/AnalyticsPage'
import SettingsPage from './pages/app/SettingsPage'
import IntegrationsPage from './pages/app/IntegrationsPage'
import KnowledgePage from './pages/app/KnowledgePage'
import LeadsPage from './pages/app/LeadsPage'
import TemplatesPage from './pages/app/TemplatesPage'
import BillingPage from './pages/app/BillingPage'
import AdminPage from './pages/app/AdminPage'

function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthed, loading } = useAuth()
  const location = useLocation()
  if (loading) {
    return <div className="grid min-h-screen place-items-center bg-bg text-sm text-muted">…</div>
  }
  if (!isAuthed) {
    return <Navigate to="/auth" state={{ from: location.pathname }} replace />
  }
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/auth" element={<AuthPage />} />
      <Route path="/auth/signin" element={<AuthPage />} />
      <Route path="/auth/signup" element={<AuthPage />} />
      <Route path="/auth/reset" element={<AuthPage />} />

      <Route
        path="/onboarding"
        element={
          <RequireAuth>
            <OnboardingPage />
          </RequireAuth>
        }
      />

      <Route
        path="/app"
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="agents/:id" element={<AgentEditorPage />} />
        <Route path="research" element={<ResearchPage />} />
        <Route path="dialogues" element={<DialoguesPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="knowledge" element={<KnowledgePage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="lead-forms" element={<LeadsPage />} />
        <Route path="templates" element={<TemplatesPage />} />
        <Route path="billing" element={<BillingPage />} />
        <Route path="admin" element={<AdminPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
