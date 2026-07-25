import { Navigate } from 'react-router-dom'
import { KeyRound, ShieldCheck } from 'lucide-react'
import { ConnectAIModel } from '../../components/platform/ConnectAIModel'
import { MediaConnectPanel } from '../../components/platform/MediaConnectPanel'
import { useAgentStore } from '../../store/useAgentStore'

export default function ProvidersPage() {
  const isAdmin = useAgentStore((state) => state.isAdmin)
  const profileResolved = useAgentStore((state) => state.profileResolved)

  if (!profileResolved) {
    return (
      <div className="container-page max-w-6xl py-8">
        <div className="h-28 animate-pulse rounded-3xl bg-white/[0.04]" />
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <div className="h-72 animate-pulse rounded-3xl bg-white/[0.04]" />
          <div className="h-72 animate-pulse rounded-3xl bg-white/[0.04]" />
        </div>
      </div>
    )
  }

  if (!isAdmin) return <Navigate to="/app/integrations" replace />

  return (
    <div className="container-page max-w-6xl py-8">
      <header className="max-w-3xl">
        <p className="mono-label">Admin · secure providers</p>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-text">Provider connections</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Реальные подключения с серверной проверкой. Секреты шифруются на сервере и не возвращаются в браузер.
        </p>
      </header>

      <div className="mt-6 rounded-2xl border border-teal/20 bg-teal/[0.06] p-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-text"><ShieldCheck size={16} className="text-teal" /> Безопасный режим</p>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted">
          Страница доступна только администратору. Демонстрационные статусы и локальное хранение ключей удалены; каждое подключение использует авторизованную Edge Function.
        </p>
      </div>

      <div className="mt-6 grid items-start gap-5 xl:grid-cols-[0.9fr_1.1fr]">
        <ConnectAIModel />
        <section>
          <div className="mb-4 flex items-center gap-3 px-1">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan/10 text-cyan"><KeyRound size={18} /></span>
            <div>
              <h2 className="text-lg font-semibold text-text">Медиа-провайдеры</h2>
              <p className="text-sm text-muted">Проверяемые подключения для изображений, голоса и видео.</p>
            </div>
          </div>
          <MediaConnectPanel />
        </section>
      </div>
    </div>
  )
}
