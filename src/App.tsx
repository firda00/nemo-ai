import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { rootRedirectFor } from './lib/host'
import type { ReactNode } from 'react'
import { useAuth } from './context/AuthContext'
import { AppLayout } from './components/layout/AppLayout'
import LandingPage from './pages/LandingPage'
import PricingPage from './pages/PricingPage'
import CliDocsPage from './pages/CliDocsPage'
import PitchPage from './pages/PitchPage'
import AuthPage from './pages/AuthPage'
import CliAuthPage from './pages/CliAuthPage'
import OnboardingPage from './pages/OnboardingPage'
import DashboardPage from './pages/app/DashboardPage'
import AgentsPage from './pages/app/AgentsPage'
import AgentEditorPage from './pages/app/AgentEditorPage'
import AnalyticsPage from './pages/app/AnalyticsPage'
import SettingsPage from './pages/app/SettingsPage'
import AdminPage from './pages/app/AdminPage'
import SwarmsPage from './pages/app/swarms/SwarmsPage'
import SwarmArchitectPage from './pages/app/swarms/SwarmArchitectPage'
import DemoPage from './pages/app/DemoPage'
import MarketplacePage from './pages/app/MarketplacePage'
import CompanyBrainPage from './pages/app/CompanyBrainPage'
import QualityPage from './pages/app/QualityPage'
import RuntimePage from './pages/app/RuntimePage'
import ProvidersPage from './pages/app/ProvidersPage'
import DemoDatasetsPage from './pages/app/DemoDatasetsPage'
import TrustPage from './pages/app/TrustPage'
import EducationSalesWorkflowPage from './pages/app/EducationSalesWorkflowPage'
import WaitlistPage from './pages/app/WaitlistPage'
import TeamDetailPage from './pages/app/TeamDetailPage'
import AutonomousPage from './pages/app/AutonomousPage'
import MemoryPage from './pages/app/MemoryPage'
import AutomationsPage from './pages/app/AutomationsPage'
import MarketingStrategyPage from './pages/app/MarketingStrategyPage'
import AutopostPage from './pages/app/AutopostPage'
import LibraryPage from './pages/app/LibraryPage'
import FollowUpsPage from './pages/app/FollowUpsPage'
import ObservabilityPage from './pages/app/ObservabilityPage'
import SetupPage from './pages/SetupPage'
import { PrivacyPage, TermsPage } from './pages/LegalPage'
import EmailAssistantPage from './pages/app/EmailAssistantPage'
import { MfaChallengeGate } from './components/auth/MfaChallengeGate'
import { AdminMfaGate } from './components/auth/AdminMfaGate'

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isAuthed, loading, live } = useAuth()
  const location = useLocation()
  if (loading) {
    return <div className="grid min-h-screen place-items-center bg-bg text-sm text-muted">…</div>
  }
  if (live && !isAuthed && (location.pathname === '/setup' || location.pathname === '/onboarding' || location.pathname.startsWith('/app'))) {
    return <Navigate to="/auth" state={{ from: location.pathname }} replace />
  }
  if (isAuthed && !user?.onboardingCompleted && location.pathname !== '/setup') return <Navigate to="/setup" replace />
  if (isAuthed && user?.onboardingCompleted && location.pathname === '/setup') return <Navigate to="/app" replace />
  return <MfaChallengeGate>{children}</MfaChallengeGate>
}

/**
 * Корень сайта зависит от хоста.
 *
 * На app.* человек идёт работать, а не читать про продукт: показывать ему промо-страницу того, чем
 * он уже пользуется, невежливо. На всех прочих хостах — включая localhost и адреса проверок —
 * поведение прежнее, промо-страница.
 */
function RootRoute() {
  const target = typeof window === 'undefined' ? null : rootRedirectFor(window.location.hostname)
  return target ? <Navigate to={target} replace /> : <LandingPage />
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<RootRoute />} />
      <Route path="/pricing" element={<PricingPage />} />
      {/* Два адреса на одну страницу: /docs — то, что набирают, /docs/cli — то, на что ссылаются. */}
      <Route path="/docs" element={<CliDocsPage />} />
      <Route path="/docs/cli" element={<CliDocsPage />} />
      <Route path="/pitch" element={<PitchPage />} />
      <Route path="/demo" element={<DemoPage />} />
      <Route path="/waitlist" element={<WaitlistPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/auth" element={<AuthPage />} />
      <Route path="/auth/signin" element={<AuthPage />} />
      <Route path="/auth/signup" element={<AuthPage />} />
      <Route path="/auth/reset" element={<AuthPage />} />
      <Route path="/cli/auth" element={<CliAuthPage />} />

      <Route
        path="/setup"
        element={<RequireAuth><SetupPage /></RequireAuth>}
      />

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
        <Route path="autonomous" element={<AutonomousPage />} />
        <Route path="memory" element={<MemoryPage />} />
        <Route path="automations" element={<AutomationsPage />} />
        <Route path="content" element={<Navigate to="/app" replace />} />
        <Route path="marketing" element={<MarketingStrategyPage />} />
        <Route path="autopost" element={<AutopostPage />} />
        <Route path="commerce" element={<Navigate to="/app" replace />} />
        <Route path="forge" element={<Navigate to="/app/teams" replace />} />
        <Route path="finance" element={<Navigate to="/app" replace />} />
        <Route path="followups" element={<FollowUpsPage />} />
        <Route path="monitor" element={<ObservabilityPage />} />
        <Route path="activity" element={<Navigate to="/app" replace />} />
        <Route path="approvals" element={<Navigate to="/app" replace />} />
        <Route path="library" element={<LibraryPage />} />
        <Route path="tools" element={<Navigate to="/app/settings?tab=integrations&section=skills" replace />} />
        <Route path="create-agent" element={<Navigate to="/app?create=agent" replace />} />
        <Route path="create-team" element={<Navigate to="/app?create=team" replace />} />
        <Route path="teams" element={<AgentsPage />} />
        <Route path="teams/education-sales" element={<EducationSalesWorkflowPage />} />
        <Route path="teams/:id" element={<TeamDetailPage />} />
        <Route path="run-workflow" element={<Navigate to="/app" replace />} />
        <Route path="results" element={<Navigate to="/app" replace />} />
        <Route path="waitlist" element={<WaitlistPage />} />
        <Route path="demo" element={<DemoPage />} />
        <Route path="swarms" element={<SwarmsPage />} />
        <Route path="swarms/:id" element={<SwarmArchitectPage />} />
        <Route path="marketplace" element={<Navigate to="/app/templates" replace />} />
        <Route path="company-brain" element={<CompanyBrainPage />} />
        <Route path="quality" element={<QualityPage />} />
        <Route path="runtime" element={<RuntimePage />} />
        <Route path="providers" element={<ProvidersPage />} />
        <Route path="demo-datasets" element={<DemoDatasetsPage />} />
        <Route path="trust" element={<TrustPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="agents/:id" element={<AgentEditorPage />} />
        <Route path="research" element={<Navigate to="/app" replace />} />
        <Route path="dialogues" element={<Navigate to="/app" replace />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="email-assistant" element={<EmailAssistantPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="knowledge" element={<Navigate to="/app/settings?tab=integrations&section=knowledge" replace />} />
        <Route path="integrations" element={<Navigate to="/app/settings?tab=integrations&section=services" replace />} />
        <Route path="lead-forms" element={<Navigate to="/app" replace />} />
        <Route path="templates" element={<MarketplacePage />} />
        <Route path="billing" element={<Navigate to="/app/settings?tab=billing" replace />} />
        <Route path="admin" element={<Navigate to="/app" replace />} />
        <Route path="control-center" element={<AdminMfaGate><AdminPage /></AdminMfaGate>} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
