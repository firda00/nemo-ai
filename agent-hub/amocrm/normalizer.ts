import type { AmoContact, AmoLead } from './enrichment-client.ts'
import type { NormalizedCrmEvent } from '../../supabase/functions/_shared/runtimeCrm.ts'

export class AmoDataQualityError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'AmoDataQualityError'
    this.code = code
  }
}

function phoneFromContact(contact: AmoContact): string {
  const field = contact.custom_fields_values?.find((item) => item.field_code === 'PHONE')
  const raw = String(field?.values?.[0]?.value ?? '').trim()
  const normalized = raw.startsWith('+') ? `+${raw.slice(1).replace(/\D/g, '')}` : ''
  if (!/^\+[1-9]\d{6,14}$/.test(normalized)) throw new AmoDataQualityError('AMOCRM_CONTACT_PHONE_MISSING')
  return normalized
}

export function normalizeDealStageChanged(input: {
  accountId: string
  eventType: string
  externalDealId: string
  lead: AmoLead
  contact: AmoContact
}): NormalizedCrmEvent {
  if (input.eventType !== 'DEAL_STAGE_CHANGED') throw new AmoDataQualityError('UNSUPPORTED_EVENT_TYPE')
  if (String(input.lead.id) !== input.externalDealId) throw new AmoDataQualityError('AMOCRM_LEAD_ID_MISMATCH')
  if (!Number.isSafeInteger(input.lead.pipeline_id) || !Number.isSafeInteger(input.lead.status_id)) {
    throw new AmoDataQualityError('AMOCRM_STAGE_DATA_MISSING')
  }
  if (!Number.isSafeInteger(input.lead.updated_at) || Number(input.lead.updated_at) <= 0) {
    throw new AmoDataQualityError('AMOCRM_UPDATED_AT_MISSING')
  }
  return {
    tenantId: input.accountId,
    provider: 'AMOCRM',
    eventType: 'DEAL_STAGE_CHANGED',
    externalDealId: input.externalDealId,
    contactPhone: phoneFromContact(input.contact),
    ...(input.contact.name?.trim() ? { contactName: input.contact.name.trim() } : {}),
    pipelineId: String(input.lead.pipeline_id),
    statusId: String(input.lead.status_id),
    customFields: { lead: input.lead.custom_fields_values ?? [] },
    occurredAt: new Date(Number(input.lead.updated_at) * 1_000).toISOString(),
  }
}
