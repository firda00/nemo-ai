import * as Sentry from '@sentry/react'
import { recordClientError } from './telemetry'

export function initMonitoring(): void {
  const dsn = String(import.meta.env.VITE_SENTRY_DSN ?? '').trim()
  if (dsn) {
    Sentry.init({
      dsn,
      environment: import.meta.env.MODE,
      sendDefaultPii: false,
      tracesSampleRate: 0.05,
      beforeSend(event) {
        if (event.request) delete event.request.data
        event.user = event.user?.id ? { id: event.user.id } : undefined
        return event
      },
    })
  }
  window.addEventListener('error', (event) => void recordClientError(event.error ?? event.message, 'window_error'))
  window.addEventListener('unhandledrejection', (event) => void recordClientError(event.reason, 'unhandled_rejection'))
}

export { Sentry }
