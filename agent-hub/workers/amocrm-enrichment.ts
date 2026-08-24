import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { loadLocalEnv } from '../load-local-env.mjs'
import { AmoApiError, AmoEnrichmentClient, parseAmoCredential } from '../amocrm/enrichment-client.ts'
import { acquireAmoPermit, recordAmoFailure, recordAmoSuccess } from '../amocrm/circuit-breaker.ts'
import { AmoDataQualityError, normalizeDealStageChanged } from '../amocrm/normalizer.ts'
import { openSecret, providerSecretContext } from '../../supabase/functions/_shared/secretBox.ts'
import { RuntimeClient, type RuntimeRpcTransport, type WorkflowClaim } from '../../supabase/functions/_shared/runtime.ts'

const WORKFLOW_TYPE = 'amocrm_native_enrichment'
const WORKER_ID = `amocrm-enrichment:${process.pid}`

interface ProviderKeyStore {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        eq(column: string, value: string): {
          maybeSingle(): Promise<{ data: { api_key?: string } | null; error: unknown }>
        }
      }
    }
  }
}

export interface EnrichmentDependencies {
  runtime: RuntimeClient
  keyStore: ProviderKeyStore
  clientFactory?: (credential: ReturnType<typeof parseAmoCredential>) => AmoEnrichmentClient
  now?: () => Date
  jitter?: () => number
  onClaimError?: (claim: WorkflowClaim, error: unknown) => void
}

function retryAt(delayMs: number, now: () => Date): string {
  return new Date(now().getTime() + Math.max(1_000, Math.min(300_000, delayMs))).toISOString()
}

function exponentialBackoffMs(attemptCount: number, jitter: () => number): number {
  const base = Math.min(300_000, 1_000 * (2 ** Math.max(0, attemptCount - 1)))
  return Math.min(300_000, base + Math.floor(jitter() * Math.min(base, 5_000)))
}

function circuitRetryAt(
  upstreamRetryAt: string | null | undefined,
  attemptCount: number,
  now: () => Date,
  jitter: () => number,
): string {
  const local = now().getTime() + exponentialBackoffMs(attemptCount, jitter)
  const upstream = upstreamRetryAt ? Date.parse(upstreamRetryAt) : Number.NaN
  return new Date(Math.max(local, Number.isFinite(upstream) ? upstream : 0)).toISOString()
}

async function transitionToDeadLetter(
  runtime: RuntimeClient,
  claim: WorkflowClaim,
  code: string,
): Promise<void> {
  await runtime.transitionWorkflow({
    accountId: claim.account_id,
    workflowId: claim.workflow_id,
    expectedEpoch: claim.lease_epoch,
    claimToken: claim.claim_token,
    toState: 'dead_letter',
    payload: { error_code: code },
    actorId: WORKER_ID,
    transitionType: 'dead_letter',
    errorCode: code,
    sanitizedErrorMessage: 'amoCRM enrichment could not produce a verified event',
    terminalReasonCode: code,
  })
}

async function scheduleRetry(
  runtime: RuntimeClient,
  claim: WorkflowClaim,
  code: string,
  nextAttemptAt: string,
): Promise<void> {
  await runtime.transitionWorkflow({
    accountId: claim.account_id,
    workflowId: claim.workflow_id,
    expectedEpoch: claim.lease_epoch,
    claimToken: claim.claim_token,
    toState: 'retry_scheduled',
    payload: { error_code: code },
    actorId: WORKER_ID,
    transitionType: 'retry_scheduled',
    nextAttemptAt,
    errorCode: code,
    sanitizedErrorMessage: 'amoCRM enrichment will be retried',
  })
}

async function credentialFor(store: ProviderKeyStore, accountId: string) {
  const { data, error } = await store.from('provider_keys').select('api_key')
    .eq('account_id', accountId).eq('provider', 'amocrm').maybeSingle()
  if (error || !data?.api_key) throw new AmoDataQualityError('AMOCRM_CREDENTIAL_MISSING')
  const plaintext = await openSecret(data.api_key, providerSecretContext(accountId, 'amocrm'))
  return parseAmoCredential(plaintext)
}

export async function processAmoClaim(
  claim: WorkflowClaim,
  dependencies: EnrichmentDependencies,
): Promise<'checkpointed' | 'retry_scheduled' | 'dead_letter'> {
  const now = dependencies.now ?? (() => new Date())
  const jitter = dependencies.jitter ?? Math.random
  if (claim.execution_mode !== 'shadow' || claim.workflow_type !== WORKFLOW_TYPE) {
    await transitionToDeadLetter(dependencies.runtime, claim, 'INVALID_ENRICHMENT_WORKFLOW')
    return 'dead_letter'
  }
  if (claim.event_type !== 'DEAL_STAGE_CHANGED') {
    await transitionToDeadLetter(dependencies.runtime, claim, 'UNSUPPORTED_EVENT_TYPE')
    return 'dead_letter'
  }

  const externalDealId = String(claim.payload.external_entity_id ?? '')
  if (!/^\d+$/.test(externalDealId)) {
    await transitionToDeadLetter(dependencies.runtime, claim, 'AMOCRM_LEAD_ID_INVALID')
    return 'dead_letter'
  }

  let credential: ReturnType<typeof parseAmoCredential>
  try {
    credential = await credentialFor(dependencies.keyStore, claim.account_id)
  } catch (error) {
    const code = error instanceof AmoDataQualityError || error instanceof AmoApiError
      ? error.code : 'AMOCRM_CREDENTIAL_INVALID'
    await transitionToDeadLetter(dependencies.runtime, claim, code)
    return 'dead_letter'
  }

  const permit = await acquireAmoPermit(dependencies.runtime, claim.account_id)
  if (!permit.allowed || !permit.permit_token) {
    if (claim.attempt_count >= claim.max_attempts) {
      await transitionToDeadLetter(dependencies.runtime, claim, 'CIRCUIT_BREAKER_EXHAUSTED')
      return 'dead_letter'
    }
    await scheduleRetry(
      dependencies.runtime,
      claim,
      'AMOCRM_CIRCUIT_OPEN',
      circuitRetryAt(permit.retry_at, claim.attempt_count, now, jitter),
    )
    return 'retry_scheduled'
  }

  const client = dependencies.clientFactory?.(credential) ?? new AmoEnrichmentClient(credential)
  let permitConfirmed = false
  try {
    const lead = await client.getLead(externalDealId)
    const contactId = lead._embedded?.contacts?.[0]?.id
    if (!Number.isSafeInteger(contactId) || Number(contactId) <= 0) {
      await recordAmoSuccess(dependencies.runtime, claim.account_id, permit.permit_token)
      permitConfirmed = true
      throw new AmoDataQualityError('AMOCRM_CONTACT_MISSING')
    }
    const contact = await client.getContact(Number(contactId))
    await recordAmoSuccess(dependencies.runtime, claim.account_id, permit.permit_token)
    permitConfirmed = true
    const event = normalizeDealStageChanged({
      accountId: claim.account_id,
      eventType: claim.event_type,
      externalDealId,
      lead,
      contact,
    })
    await dependencies.runtime.checkpointAndTransition({
      accountId: claim.account_id,
      workflowId: claim.workflow_id,
      expectedEpoch: claim.lease_epoch,
      claimToken: claim.claim_token,
      contextPatch: { enriched_event: event, enrichment_contract: 'unified-crm-v5' },
      actorId: WORKER_ID,
    })
    return 'checkpointed'
  } catch (error) {
    if (error instanceof AmoDataQualityError) {
      await transitionToDeadLetter(dependencies.runtime, claim, error.code)
      return 'dead_letter'
    }
    const apiError = error instanceof AmoApiError ? error : new AmoApiError('AMOCRM_ENRICHMENT_FAILED')
    if (permitConfirmed) throw error
    await recordAmoFailure(dependencies.runtime, claim.account_id, permit.permit_token, apiError.code)
    if (claim.attempt_count >= claim.max_attempts) {
      await transitionToDeadLetter(dependencies.runtime, claim, 'AMOCRM_RETRY_EXHAUSTED')
      return 'dead_letter'
    }
    await scheduleRetry(
      dependencies.runtime,
      claim,
      apiError.code,
      retryAt(apiError.retryAfterMs ?? exponentialBackoffMs(claim.attempt_count, jitter), now),
    )
    return 'retry_scheduled'
  }
}

export async function runEnrichmentBatch(dependencies: EnrichmentDependencies, limit = 10): Promise<number> {
  const claims = await dependencies.runtime.claimWorkflows({
    workerId: WORKER_ID,
    leaseDurationSeconds: 60,
    limit,
    executionMode: 'shadow',
    workflowType: WORKFLOW_TYPE,
  })
  for (const claim of claims) {
    try {
      await processAmoClaim(claim, dependencies)
    } catch (error) {
      dependencies.onClaimError?.(claim, error)
    }
  }
  return claims.length
}

async function main(): Promise<void> {
  const root = path.resolve(import.meta.dirname, '..', '..')
  loadLocalEnv(root)
  const url = process.env.SUPABASE_URL ?? ''
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? ''
  if (!url || !serviceKey || !process.env.CREDENTIAL_ENCRYPTION_KEY) {
    throw new Error('Missing SUPABASE_URL, service-role key, or CREDENTIAL_ENCRYPTION_KEY')
  }
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const runtime = new RuntimeClient(admin as unknown as RuntimeRpcTransport)
  for (;;) {
    try {
      const count = await runEnrichmentBatch({
        runtime,
        keyStore: admin as unknown as ProviderKeyStore,
        onClaimError: (claim, error) => {
          const code = error instanceof Error ? error.name : 'UNKNOWN_ERROR'
          console.error(`[amocrm-enrichment] claim ${claim.workflow_id} failed: ${code}`)
        },
      })
      if (!count) await new Promise((resolve) => setTimeout(resolve, 2_000))
    } catch (error) {
      const code = error instanceof Error ? error.name : 'UNKNOWN_ERROR'
      console.error(`[amocrm-enrichment] poll failed: ${code}`)
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[amocrm-enrichment] stopped: ${error instanceof Error ? error.message : 'unknown error'}`)
    process.exitCode = 1
  })
}
