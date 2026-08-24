import type { RuntimeClient, RuntimeIngestResult } from './runtime.ts'

/** Validated normalized CRM event. The boundary schema lives in agent-hub/contracts/v5.ts. */
export interface NormalizedCrmEvent {
  tenantId: string
  provider: 'AMOCRM' | 'HUBSPOT'
  eventType: 'DEAL_STAGE_CHANGED' | 'NEW_CONTACT_CREATED' | 'TASK_COMPLETED'
  externalDealId: string
  contactPhone: string
  contactName?: string
  pipelineId: string
  statusId: string
  customFields: Record<string, unknown>
  occurredAt: string
}

export interface ShadowCrmIngestInput {
  event: NormalizedCrmEvent
  /** The existing V5 idempotency key includes event type and occurrence time. */
  idempotencyKey: string
  correlationId?: string
  actorId?: string
}

/**
 * Writes a normalized CRM event into Durable Runtime without enabling external side effects.
 *
 * `externalDealId` alone is not an event identity: one deal changes stage many times. Reusing the
 * V5 idempotency key prevents the runtime inbox from collapsing legitimate later changes while still
 * deduplicating provider retries.
 */
export async function ingestCrmEventInShadow(
  runtime: RuntimeClient,
  input: ShadowCrmIngestInput,
): Promise<RuntimeIngestResult> {
  const event = input.event
  return runtime.ingestEvent({
    accountId: event.tenantId,
    provider: event.provider.toLowerCase(),
    externalEventId: input.idempotencyKey,
    payload: event as unknown as Record<string, unknown>,
    executionMode: 'shadow',
    correlationId: input.correlationId ?? crypto.randomUUID(),
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    contractVersion: 'unified-crm-v5',
    identityVersion: 'crm-idempotency-v1',
    workflowType: `${event.provider.toLowerCase()}_shadow_event`,
    workflowVersion: '1.0.0',
    actorId: input.actorId ?? 'gateway:crm-webhook',
  })
}
