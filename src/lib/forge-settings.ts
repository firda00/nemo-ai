import {
  ConnectorHealthSchema,
  ForgeSettingsSchema,
  type ConnectorHealth,
  type ForgeSettings,
} from '../types/forge-settings.ts'

const SENSITIVE_KEY = /(?:secret|token|password|authorization|api[_-]?key|credential|cookie|signature)/i
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:eyJ[A-Za-z0-9_-]+\.){2}[A-Za-z0-9_-]+\b/g,
]
const HOST_PATH_PATTERNS = [/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, /\/(?:Users|home|root)\/[A-Za-z0-9._/ -]+/g]

const WINDOWS_CLIENT = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform)

export const DEFAULT_FORGE_SETTINGS: ForgeSettings = ForgeSettingsSchema.parse({
  schemaVersion: '1.0',
  worker: {
    ffmpegPath: WINDOWS_CLIENT ? 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe' : '/usr/bin/ffmpeg',
    whisperPath: WINDOWS_CLIENT ? 'C:\\Program Files\\whisper.cpp\\whisper-cli.exe' : '/usr/local/bin/whisper-cli',
    maxConcurrentWorkers: 2,
    defaultBudgetCapUsd: 5,
    transcriptionModel: 'small',
    videoCodec: 'h264',
  },
  governance: {
    defaultBudgetCapUsd: 5,
    hardProjectCapUsd: 25,
    contentRightsPolicy: 'fail_closed',
    requireApprovalBeforePublish: true,
  },
})

export function maskSecret(secret: string): string {
  const value = secret.trim()
  if (!value) return '••••••••'
  if (value.length <= 8) return '••••••••'
  return `${value.slice(0, 3)}${'•'.repeat(Math.min(12, value.length - 7))}${value.slice(-4)}`
}

function sanitizeString(value: string): string {
  let sanitized = value
  for (const pattern of SECRET_VALUE_PATTERNS) sanitized = sanitized.replace(pattern, '[REDACTED]')
  for (const pattern of HOST_PATH_PATTERNS) sanitized = sanitized.replace(pattern, '[HOST_PATH]')
  return sanitized.slice(0, 4_096)
}

export function sanitizeDiagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]'
  if (typeof value === 'string') return sanitizeString(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeDiagnosticValue(item, depth + 1))
  if (!value || typeof value !== 'object') return String(value)
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, child]) => [
    key,
    SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeDiagnosticValue(child, depth + 1),
  ]))
}

export function buildForgeDiagnosticBundle(input: {
  generatedAt?: string
  appVersion: string
  connectors: ConnectorHealth[]
  settings: ForgeSettings
  recentErrors?: unknown[]
}): Record<string, unknown> {
  const settings = ForgeSettingsSchema.parse(input.settings)
  const connectors = input.connectors.map((connector) => ConnectorHealthSchema.parse(connector))
  return sanitizeDiagnosticValue({
    schemaVersion: '1.0',
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    appVersion: input.appVersion,
    connectors,
    worker: {
      maxConcurrentWorkers: settings.worker.maxConcurrentWorkers,
      transcriptionModel: settings.worker.transcriptionModel,
      videoCodec: settings.worker.videoCodec,
      ffmpegConfigured: Boolean(settings.worker.ffmpegPath),
      whisperConfigured: Boolean(settings.worker.whisperPath),
    },
    governance: settings.governance,
    recentErrors: input.recentErrors ?? [],
  }) as Record<string, unknown>
}
