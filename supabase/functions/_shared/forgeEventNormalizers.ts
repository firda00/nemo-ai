import type { NormalizedForgeEvent } from './forgeEventBridge.ts'

const decoder = new TextDecoder()
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_event')
  return value as Record<string, unknown>
}

function boundedString(value: unknown, max = 256): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const text = String(value).trim()
  return text && text.length <= max ? text : undefined
}

function safeExternalId(prefix: string, value: unknown): string {
  const text = boundedString(value, 220)
  const id = text ? `${prefix}:${text}` : ''
  if (!id || !SAFE_ID.test(id)) throw new Error('invalid_event_id')
  return id
}

function isoTimestamp(value: unknown): string {
  const text = boundedString(value, 64)
  if (!text) throw new Error('invalid_timestamp')
  const numeric = Number(text)
  const milliseconds = Number.isFinite(numeric) && /^\d+(?:\.\d+)?$/.test(text)
    ? numeric * (numeric < 10_000_000_000 ? 1000 : 1)
    : Date.parse(text)
  if (!Number.isFinite(milliseconds)) throw new Error('invalid_timestamp')
  return new Date(milliseconds).toISOString()
}

function parseJson(rawBody: Uint8Array): Record<string, unknown> {
  return asRecord(JSON.parse(decoder.decode(rawBody)))
}

function compact(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length <= 4096) result[key] = value
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value
    else if (typeof value === 'boolean') result[key] = value
  }
  return result
}

function firstFormValue(params: URLSearchParams, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params.get(key)?.trim()
    if (value) return value
  }
  return undefined
}

export function normalizeAmoCrmForgeEvent(rawBody: Uint8Array, request: Request): NormalizedForgeEvent {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams(decoder.decode(rawBody))
    const action = ['add', 'update', 'status'].find((candidate) => form.has(`leads[${candidate}][0][id]`))
    if (!action) throw new Error('unsupported_amocrm_event')
    const leadId = firstFormValue(form, [`leads[${action}][0][id]`])
    const updatedAt = firstFormValue(form, [
      `leads[${action}][0][updated_at]`,
      `leads[${action}][0][last_modified]`,
      'timestamp',
    ])
    if (!leadId || !updatedAt) throw new Error('invalid_amocrm_event')
    const occurredAt = isoTimestamp(updatedAt)
    const suppliedEventId = request.headers.get('x-event-id')
    return {
      externalEventId: suppliedEventId
        ? safeExternalId('amo', suppliedEventId)
        : safeExternalId('amo', `${action}:${leadId}:${Date.parse(occurredAt)}`),
      eventType: action === 'add' ? 'crm.lead.created' : 'crm.lead.updated',
      occurredAt,
      payload: {
        lead_id: leadId,
        action,
        ...compact(Object.fromEntries(form), [
          `leads[${action}][0][status_id]`,
          `leads[${action}][0][pipeline_id]`,
          'account[subdomain]',
        ]),
      },
    }
  }

  if (!contentType.includes('application/json')) throw new Error('unsupported_content_type')
  const body = parseJson(rawBody)
  const lead = asRecord(body.lead)
  const eventType = body.event_type === 'crm.lead.created' || body.event_type === 'crm.lead.updated'
    ? body.event_type
    : undefined
  if (!eventType) throw new Error('unsupported_amocrm_event')
  return {
    externalEventId: safeExternalId('amo', body.event_id),
    eventType,
    occurredAt: isoTimestamp(body.occurred_at ?? body.timestamp),
    payload: compact(lead, ['id', 'status_id', 'pipeline_id', 'responsible_user_id', 'updated_at']),
  }
}

export function normalizeTelegramForgeEvent(rawBody: Uint8Array): NormalizedForgeEvent {
  const body = parseJson(rawBody)
  const updateId = body.update_id
  const message = asRecord(body.message ?? body.edited_message)
  const text = boundedString(message.text, 4096)
  const match = text?.match(/^\/forge(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]+))?$/i)
  const command = match?.[1]?.trim()
  if (!command) throw new Error('unsupported_telegram_command')
  const chat = asRecord(message.chat)
  const occurredAt = isoTimestamp(message.date)
  return {
    externalEventId: safeExternalId('tg', updateId),
    eventType: 'telegram.command.received',
    occurredAt,
    payload: {
      update_id: updateId,
      message_id: message.message_id,
      chat_id: boundedString(chat.id, 64),
      command,
    },
  }
}

export function normalizeUzumForgeEvent(rawBody: Uint8Array): NormalizedForgeEvent {
  const body = parseJson(rawBody)
  const rawType = boundedString(body.event_type ?? body.type, 80)?.toLowerCase()
  const eventType = rawType === 'marketplace.order.status_changed' || rawType === 'order.status_changed'
    || rawType === 'order_status_changed'
    ? 'marketplace.order.status_changed'
    : rawType === 'marketplace.stock.low' || rawType === 'stock.low' || rawType === 'stock_low'
      ? 'marketplace.stock.low'
      : undefined
  if (!eventType) throw new Error('unsupported_uzum_event')
  const data = asRecord(body.data ?? body.payload)
  return {
    externalEventId: safeExternalId('uzum', body.event_id ?? body.id),
    eventType,
    occurredAt: isoTimestamp(body.occurred_at ?? body.timestamp),
    payload: compact(data, ['order_id', 'sku_id', 'status', 'available_stock', 'warehouse_id']),
  }
}
