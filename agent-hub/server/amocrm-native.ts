import { createHash, randomUUID } from 'node:crypto'
import type { RuntimeClient, RuntimeIngestResult } from '../../supabase/functions/_shared/runtime.ts'

const MAX_FORM_FIELDS = 4_000
const MAX_KEY_DEPTH = 10
const MAX_NATIVE_EVENTS = 100
const MAX_RUNTIME_PAYLOAD_BYTES = 60 * 1024
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/
const SAFE_SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

type FormValue = string | FormObject
interface FormObject { [key: string]: FormValue }

export class AmoWebhookParseError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'AmoWebhookParseError'
    this.code = code
  }
}

export interface NativeAmoEvent {
  accountSubdomain: string
  entity: string
  action: string
  eventType: string
  externalEntityId: string
  externalEventId: string
  occurredAt: string
  payload: Record<string, unknown>
}

export interface ParsedNativeAmoWebhook {
  accountSubdomain: string
  events: NativeAmoEvent[]
}

function isObject(value: FormValue | undefined): value is FormObject {
  return Boolean(value) && typeof value === 'object'
}

function parseKey(key: string): string[] {
  const match = /^([^\[\]]+)((?:\[[^\[\]]+\])*)$/.exec(key)
  if (!match) throw new AmoWebhookParseError('invalid_form_key')
  const segments = [match[1], ...Array.from(match[2].matchAll(/\[([^\[\]]+)\]/g), (one) => one[1])]
  if (segments.length > MAX_KEY_DEPTH) throw new AmoWebhookParseError('form_too_deep')
  if (segments.some((segment) => !SAFE_SEGMENT.test(segment) || FORBIDDEN_SEGMENTS.has(segment))) {
    throw new AmoWebhookParseError('unsafe_form_key')
  }
  return segments
}

/** Parse PHP-style bracket keys without accepting prototype keys or ambiguous duplicate paths. */
export function parseAmoFormBody(body: string): FormObject {
  const root: FormObject = Object.create(null) as FormObject
  let fields = 0
  for (const [key, value] of new URLSearchParams(body)) {
    fields += 1
    if (fields > MAX_FORM_FIELDS) throw new AmoWebhookParseError('too_many_form_fields')
    const path = parseKey(key)
    let cursor = root
    for (let index = 0; index < path.length - 1; index += 1) {
      const segment = path[index]
      const existing = cursor[segment]
      if (existing === undefined) {
        const child = Object.create(null) as FormObject
        cursor[segment] = child
        cursor = child
      } else if (isObject(existing)) {
        cursor = existing
      } else {
        throw new AmoWebhookParseError('ambiguous_form_path')
      }
    }
    const leaf = path[path.length - 1]
    if (cursor[leaf] !== undefined) throw new AmoWebhookParseError('duplicate_form_field')
    cursor[leaf] = value
  }
  return root
}

function scalar(object: FormObject, key: string): string | null {
  const value = object[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeSubdomain(raw: string): string {
  const normalized = raw.trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.amocrm\.(?:ru|com)$/, '')
  if (!SAFE_SUBDOMAIN.test(normalized)) throw new AmoWebhookParseError('invalid_account_subdomain')
  return normalized
}

function collectRecords(value: FormValue): FormObject[] {
  if (typeof value === 'string') return value ? [{ id: value }] : []
  if (scalar(value, 'id') || scalar(value, 'uid')) return [value]
  return Object.keys(value)
    .sort((left, right) => Number(left) - Number(right))
    .flatMap((key) => collectRecords(value[key]))
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function occurredAt(record: FormObject, receivedAt: Date): string {
  const raw = scalar(record, 'updated_at')
    ?? scalar(record, 'last_modified')
    ?? scalar(record, 'date_create')
    ?? scalar(record, 'created_at')
  if (!raw) return receivedAt.toISOString()
  if (/^\d{9,13}$/.test(raw)) {
    const numeric = Number(raw)
    const milliseconds = raw.length > 10 ? numeric : numeric * 1_000
    const parsed = new Date(milliseconds)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  const parsed = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'))
  return Number.isNaN(parsed.getTime()) ? receivedAt.toISOString() : parsed.toISOString()
}

function eventType(entity: string, action: string, record: FormObject): string {
  if (entity === 'leads' && action === 'status') return 'DEAL_STAGE_CHANGED'
  if (entity === 'contacts' && action === 'add') return 'NEW_CONTACT_CREATED'
  if (entity === 'task' && action === 'update'
    && (scalar(record, 'action_close') === '1' || scalar(record, 'status') === '1')) {
    return 'TASK_COMPLETED'
  }
  return `AMOCRM_${entity}_${action}`.toUpperCase().slice(0, 120)
}

/** Convert one native amoCRM delivery into bounded, enrichment-ready runtime events. */
export function parseNativeAmoWebhook(body: string, receivedAt = new Date()): ParsedNativeAmoWebhook {
  const form = parseAmoFormBody(body)
  const account = form.account
  if (!isObject(account)) throw new AmoWebhookParseError('missing_account')
  const subdomain = normalizeSubdomain(scalar(account, 'subdomain') ?? '')
  const events: NativeAmoEvent[] = []

  for (const [entity, actionsValue] of Object.entries(form)) {
    if (entity === 'account' || !isObject(actionsValue)) continue
    for (const [action, recordsValue] of Object.entries(actionsValue)) {
      for (const record of collectRecords(recordsValue)) {
        if (events.length >= MAX_NATIVE_EVENTS) throw new AmoWebhookParseError('too_many_events')
        const externalEntityId = scalar(record, 'id') ?? scalar(record, 'uid')
        if (!externalEntityId) throw new AmoWebhookParseError('missing_entity_id')
        const fingerprint = createHash('sha256').update(canonicalJson(record), 'utf8').digest('hex')
        const externalEventId = `amocrm:${subdomain}:${entity}:${action}:${externalEntityId}:${fingerprint}`
        const payload = {
          contract: 'amocrm-native-v1',
          needs_enrichment: true,
          account: { subdomain },
          entity,
          action,
          external_entity_id: externalEntityId,
          data: record,
        }
        if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_RUNTIME_PAYLOAD_BYTES) {
          throw new AmoWebhookParseError('event_payload_too_large')
        }
        events.push({
          accountSubdomain: subdomain,
          entity,
          action,
          eventType: eventType(entity, action, record),
          externalEntityId,
          externalEventId,
          occurredAt: occurredAt(record, receivedAt),
          payload,
        })
      }
    }
  }

  if (!events.length) throw new AmoWebhookParseError('no_supported_events')
  return { accountSubdomain: subdomain, events }
}

export async function ingestNativeAmoWebhook(
  runtime: RuntimeClient,
  accountId: string,
  parsed: ParsedNativeAmoWebhook,
): Promise<RuntimeIngestResult[]> {
  const results: RuntimeIngestResult[] = []
  for (const event of parsed.events) {
    results.push(await runtime.ingestEvent({
      accountId,
      provider: 'amocrm',
      externalEventId: event.externalEventId,
      payload: event.payload,
      executionMode: 'shadow',
      correlationId: randomUUID(),
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      contractVersion: 'amocrm-native-v1',
      identityVersion: 'amocrm-native-payload-v1',
      workflowType: 'amocrm_native_enrichment',
      workflowVersion: '1.0.0',
      actorId: 'gateway:amocrm-native-webhook',
    }))
  }
  return results
}
