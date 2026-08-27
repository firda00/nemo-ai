import assert from 'node:assert/strict'
import {
  AuditLogEntrySchema,
  ConnectorHealthSchema,
  ForgeGovernanceConfigSchema,
  ForgeIntegrationSecretInputSchema,
  ForgeSettingsSchema,
  ForgeWorkerConfigSchema,
} from '../src/types/forge-settings.ts'
import {
  DEFAULT_FORGE_SETTINGS,
  buildForgeDiagnosticBundle,
  maskSecret,
  sanitizeDiagnosticValue,
} from '../src/lib/forge-settings.ts'

const accountId = 'b6c5513e-79a1-4b46-a373-749f2ea26e16'

assert.equal(maskSecret(''), '••••••••')
assert.equal(maskSecret('short'), '••••••••')
assert.equal(maskSecret('telegram-secret-value-123456'), 'tel••••••••••••3456')
assert.notEqual(maskSecret('telegram-secret-value-123456'), 'telegram-secret-value-123456')

assert.equal(ForgeIntegrationSecretInputSchema.safeParse({
  provider: 'telegram', secret: 'test-only-telegram-secret-32-bytes',
}).success, true)
assert.equal(ForgeIntegrationSecretInputSchema.safeParse({
  provider: 'amocrm', secret: 'test-only-amocrm-secret-32-bytes',
}).success, false, 'amoCRM requires an explicit subdomain')
assert.equal(ForgeIntegrationSecretInputSchema.safeParse({
  provider: 'uzum', secret: 'contains whitespace and must fail',
}).success, false)

for (const worker of [
  { ...DEFAULT_FORGE_SETTINGS.worker, ffmpegPath: '/usr/bin/ffmpeg', whisperPath: '/opt/whisper/whisper-cli' },
  { ...DEFAULT_FORGE_SETTINGS.worker, ffmpegPath: 'C:\\tools\\ffmpeg.exe', whisperPath: 'C:\\tools\\whisper-cli.exe' },
]) assert.equal(ForgeWorkerConfigSchema.safeParse(worker).success, true)

assert.equal(ForgeWorkerConfigSchema.safeParse({
  ...DEFAULT_FORGE_SETTINGS.worker, ffmpegPath: '../bin/ffmpeg',
}).success, false)
assert.equal(ForgeWorkerConfigSchema.safeParse({
  ...DEFAULT_FORGE_SETTINGS.worker, whisperPath: '/opt/whisper/../secrets/whisper-cli',
}).success, false)
assert.equal(ForgeWorkerConfigSchema.safeParse({
  ...DEFAULT_FORGE_SETTINGS.worker, maxConcurrentWorkers: 33,
}).success, false)

assert.equal(ForgeGovernanceConfigSchema.safeParse({
  ...DEFAULT_FORGE_SETTINGS.governance,
  defaultBudgetCapUsd: 50,
  hardProjectCapUsd: 25,
}).success, false, 'default budget must not exceed the hard cap')
assert.equal(ForgeGovernanceConfigSchema.safeParse({
  ...DEFAULT_FORGE_SETTINGS.governance,
  requireApprovalBeforePublish: false,
}).success, false, 'approval policy cannot be disabled')
assert.equal(ForgeSettingsSchema.safeParse(DEFAULT_FORGE_SETTINGS).success, true)

const connector = ConnectorHealthSchema.parse({
  connectorId: 'forge-runtime', label: 'Forge Runtime', status: 'healthy', latencyMs: 42,
  activeInboxJobs: 3, checkedAt: '2026-08-27T10:00:00+05:00',
})
assert.equal(connector.latencyMs, 42)
assert.equal(ConnectorHealthSchema.safeParse({ ...connector, apiKey: 'must-not-exist' }).success, false)

assert.equal(AuditLogEntrySchema.safeParse({
  id: '93cc7ab0-6dd0-4e51-9bc8-49d4cf166f91', accountId, actorId: null,
  action: 'diagnostics.exported', target: 'forge-settings', outcome: 'success',
  occurredAt: '2026-08-27T10:00:00+05:00', metadata: { connectorCount: 1 },
}).success, true)
assert.equal(AuditLogEntrySchema.safeParse({
  id: '93cc7ab0-6dd0-4e51-9bc8-49d4cf166f91', accountId, actorId: null,
  action: 'secret.rotated', target: 'uzum', outcome: 'success',
  occurredAt: '2026-08-27T10:00:00+05:00', metadata: { api_key: 'plaintext-must-fail' },
}).success, false)

const sanitized = sanitizeDiagnosticValue({
  authorization: 'Bearer forbidden-token',
  nested: {
    apiKey: 'sk-forbidden-secret-value',
    error: 'failed at C:\\Users\\tenant\\private\\worker.log',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.signature',
  },
})
const serializedSanitized = JSON.stringify(sanitized)
assert.equal(serializedSanitized.includes('forbidden-token'), false)
assert.equal(serializedSanitized.includes('sk-forbidden'), false)
assert.equal(serializedSanitized.includes('C:\\\\Users'), false)
assert.equal(serializedSanitized.includes('eyJhbGci'), false)

const diagnostics = buildForgeDiagnosticBundle({
  generatedAt: '2026-08-27T10:00:00+05:00', appVersion: 'test',
  connectors: [connector], settings: DEFAULT_FORGE_SETTINGS,
  recentErrors: [{ message: 'Connector health check failed', reference: 'mock-key-12345' }],
})
const serializedDiagnostics = JSON.stringify(diagnostics)
assert.equal(serializedDiagnostics.includes(DEFAULT_FORGE_SETTINGS.worker.ffmpegPath), false)
assert.equal(serializedDiagnostics.includes(DEFAULT_FORGE_SETTINGS.worker.whisperPath), false)
assert.equal(serializedDiagnostics.includes('Connector health check failed'), true)
assert.equal(serializedDiagnostics.includes('mock-key-12345'), true)

console.log('Forge settings passed: strict config validation, write-only secrets, masking, and sanitized diagnostics.')
