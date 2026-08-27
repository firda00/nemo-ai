import type { BusinessIntent } from '../../../src/types/business-intent.ts'
import { compileSafePlan, sha256, type NormalizedForgeEvent, type TriggerRow } from './forgeEventBridge.ts'

export interface TelegramVoiceForgeInput {
  intent: BusinessIntent
  workspaceId: string
  idempotencyKey: string
}

export async function enqueueTelegramVoiceForge(
  db: any,
  accountId: string,
  input: TelegramVoiceForgeInput,
): Promise<{ executionId: string; workflowId: string; status: 'created' | 'duplicate' }> {
  const { data: rows, error: triggerError } = await db.schema('runtime').from('event_triggers')
    .select('*')
    .eq('account_id', accountId)
    .eq('provider', 'telegram')
    .eq('event_type', 'telegram.command.received')
    .eq('active', true)
    .order('created_at', { ascending: true })
    .limit(1)
  const trigger = rows?.[0] as TriggerRow | undefined
  if (triggerError || !trigger) throw new Error('FORGE_TELEGRAM_TRIGGER_NOT_CONFIGURED')

  const occurredAt = new Date().toISOString()
  const externalEventId = input.idempotencyKey.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 256)
  const event: NormalizedForgeEvent = {
    externalEventId,
    eventType: 'telegram.command.received',
    occurredAt,
    payload: { business_intent: input.intent },
  }
  const payload = { untrusted_event_data: event.payload }
  const plan = await compileSafePlan(trigger, event)
  const { data, error } = await db.rpc('runtime_enqueue_forge_event', {
    p_account_id: accountId,
    p_trigger_id: trigger.id,
    p_external_event_id: externalEventId,
    p_event_type: event.eventType,
    p_occurred_at: occurredAt,
    p_payload: payload,
    p_payload_hash: await sha256(JSON.stringify(payload)),
    p_plan: plan,
    p_estimated_units: trigger.estimated_units,
  })
  if (error) throw new Error('FORGE_VOICE_ENQUEUE_FAILED')
  if (data?.status === 'budget_denied') throw new Error('FORGE_BUDGET_DENIED')
  if (data?.status === 'rate_limited') throw new Error('FORGE_RATE_LIMITED')
  if (!['created', 'duplicate'].includes(data?.status) || !data?.execution_id) throw new Error('FORGE_VOICE_ENQUEUE_FAILED')
  return { executionId: data.execution_id, workflowId: data.workflow_id, status: data.status }
}
