import { z } from 'zod'

export const A2A_PROTOCOL_VERSION = '1.0' as const
export const A2A_MAX_MESSAGE_BYTES = 16 * 1024
export const A2A_MAX_SUMMARY_BYTES = 1024
export const A2A_MAX_DATA_BYTES = 8 * 1024

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const STORAGE_PATH = /^tenants\/[0-9a-f-]{36}\/(?:artifacts|a2a)\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]{1,160}$/
const SENSITIVE_KEY = /^(?:authorization|cookie|password|passwd|secret|api_?key|access_?token|refresh_?token|service_?role(?:_?key)?|private_?key)$/i
const SENSITIVE_VALUE = /(?:bearer\s+[a-z0-9._~+/-]+=*|eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.|sk-[a-zA-Z0-9_-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function scanUntrustedValue(value: unknown, path: Array<string | number>, context: z.RefinementCtx): void {
  if (typeof value === 'string') {
    if (SENSITIVE_VALUE.test(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'A2A payload contains secret-like material', path })
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanUntrustedValue(item, [...path, index], context))
    return
  }
  if (!value || typeof value !== 'object') return

  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) || key === '__proto__' || key === 'prototype' || key === 'constructor') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `A2A payload key is prohibited: ${key}`, path: [...path, key] })
      continue
    }
    scanUntrustedValue(nested, [...path, key], context)
  }
}

const BoundedDataSchema = z.record(z.unknown()).superRefine((value, context) => {
  if (byteLength(JSON.stringify(value)) > A2A_MAX_DATA_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `A2A data exceeds ${A2A_MAX_DATA_BYTES} bytes` })
  }
  scanUntrustedValue(value, [], context)
})

export const A2AIntentSchema = z.enum([
  'handoff',
  'query',
  'approval_request',
  'result',
  'error',
])

export const A2AArtifactRefSchema = z.object({
  artifact_id: z.string().uuid(),
  kind: z.enum(['document', 'image', 'video', 'dataset', 'code', 'other']),
  sha256: z.string().regex(SHA256),
  storage_path: z.string().min(1).max(512).regex(STORAGE_PATH),
}).strict()

export const A2AEvidenceRefSchema = z.object({
  evidence_id: z.string().min(1).max(160).regex(SAFE_ID),
  source_type: z.enum(['tenant_record', 'artifact', 'tool_result', 'policy_decision', 'human_input']),
  sha256: z.string().regex(SHA256).optional(),
}).strict()

export const A2AMessageSchema = z.object({
  version: z.literal(A2A_PROTOCOL_VERSION),
  message_id: z.string().regex(UUID_V7, 'message_id must be UUIDv7'),
  account_id: z.string().uuid(),
  workflow_id: z.string().uuid(),
  from_agent_id: z.string().regex(SAFE_ID),
  to_agent_id: z.string().regex(SAFE_ID),
  intent: A2AIntentSchema,
  created_at: z.string().datetime({ offset: true }),
  sender_lease_epoch: z.number().int().positive(),
  summary: z.string().min(1).max(600).superRefine((value, context) => {
    if (byteLength(value) > A2A_MAX_SUMMARY_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `A2A summary exceeds ${A2A_MAX_SUMMARY_BYTES} bytes` })
    }
    if (SENSITIVE_VALUE.test(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'A2A summary contains secret-like material' })
    }
  }),
  data: BoundedDataSchema.default({}),
  artifact_refs: z.array(A2AArtifactRefSchema).max(32).default([]),
  evidence_refs: z.array(A2AEvidenceRefSchema).max(32).default([]),
  confidence: z.number().finite().min(0).max(1).optional(),
  requires_approval: z.boolean().default(false),
}).strict().superRefine((message, context) => {
  if (message.from_agent_id === message.to_agent_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'A2A sender and recipient must differ', path: ['to_agent_id'] })
  }
  if (message.intent === 'approval_request' && !message.requires_approval) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'approval_request must require approval', path: ['requires_approval'] })
  }
  if (message.intent === 'result' && message.evidence_refs.length === 0 && message.artifact_refs.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'A2A result requires evidence_refs or artifact_refs', path: ['evidence_refs'] })
  }
  for (let index = 0; index < message.artifact_refs.length; index += 1) {
    const expectedPrefix = `tenants/${message.account_id}/`
    if (!message.artifact_refs[index].storage_path.startsWith(expectedPrefix)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A2A artifact must belong to the message tenant',
        path: ['artifact_refs', index, 'storage_path'],
      })
    }
  }
  if (byteLength(JSON.stringify(message)) > A2A_MAX_MESSAGE_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `A2A message exceeds ${A2A_MAX_MESSAGE_BYTES} bytes` })
  }
})

export type A2AIntent = z.infer<typeof A2AIntentSchema>
export type A2AArtifactRef = z.infer<typeof A2AArtifactRefSchema>
export type A2AEvidenceRef = z.infer<typeof A2AEvidenceRefSchema>
export type A2AMessage = z.infer<typeof A2AMessageSchema>

export class A2AProtocolError extends Error {
  readonly code: 'A2A_MESSAGE_TOO_LARGE' | 'A2A_INVALID_JSON' | 'A2A_SCHEMA_REJECTED'

  constructor(code: A2AProtocolError['code'], message: string) {
    super(message)
    this.name = 'A2AProtocolError'
    this.code = code
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, canonicalize(nested)]),
  )
}

export function buildA2AIdempotencyKey(message: Pick<A2AMessage, 'account_id' | 'workflow_id' | 'message_id'>): string {
  return `${message.account_id}:${message.workflow_id}:${message.message_id}`
}

export function encodeA2AMessage(input: unknown): string {
  const parsed = A2AMessageSchema.safeParse(input)
  if (!parsed.success) {
    throw new A2AProtocolError('A2A_SCHEMA_REJECTED', parsed.error.issues.map((issue) => issue.message).join('; '))
  }
  return JSON.stringify(canonicalize(parsed.data))
}

export function decodeA2AMessage(input: string | Uint8Array): A2AMessage {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  if (bytes.byteLength > A2A_MAX_MESSAGE_BYTES) {
    throw new A2AProtocolError('A2A_MESSAGE_TOO_LARGE', `A2A message exceeds ${A2A_MAX_MESSAGE_BYTES} bytes`)
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new A2AProtocolError('A2A_INVALID_JSON', 'A2A message is not valid UTF-8 JSON')
  }

  const parsed = A2AMessageSchema.safeParse(decoded)
  if (!parsed.success) {
    throw new A2AProtocolError('A2A_SCHEMA_REJECTED', parsed.error.issues.map((issue) => issue.message).join('; '))
  }
  return parsed.data
}
