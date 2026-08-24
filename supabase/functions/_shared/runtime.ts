// Typed service-role client for ADR 001 Durable Operations Runtime RPCs.
//
// This module deliberately knows nothing about runtime tables. Edge Functions and Node workers use
// only the public SECURITY DEFINER wrappers, so a future schema refactor does not spread privileged
// table access across every connector.

export type JsonObject = Record<string, unknown>

export interface RuntimeRpcErrorShape {
  code?: string
  message?: string
}

export interface RuntimeRpcTransport {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: RuntimeRpcErrorShape | null }>
}

export class RuntimeRpcError extends Error {
  readonly rpc: string
  readonly code: string

  constructor(rpc: string, error: RuntimeRpcErrorShape | null) {
    const code = String(error?.code ?? 'RUNTIME_RPC_FAILED').slice(0, 64)
    super(`${rpc} failed (${code})`)
    this.name = 'RuntimeRpcError'
    this.rpc = rpc
    this.code = code
  }
}

export interface RuntimeIngestInput {
  accountId: string
  provider: string
  externalEventId: string
  payload: JsonObject
  executionMode: 'shadow' | 'live'
  correlationId: string
  eventType?: string
  occurredAt?: string
  contractVersion?: string
  identityVersion?: string
  workflowType?: string
  workflowVersion?: string
  actorId?: string
}

export interface RuntimeIngestResult {
  status: 'created' | 'duplicate'
  workflow_id: string
  inbox_event_id: string
}

export interface WorkflowClaim {
  account_id: string
  workflow_id: string
  inbox_event_id: string
  workflow_type: string
  workflow_version: string
  execution_mode: 'shadow' | 'live'
  correlation_id: string
  claim_token: string
  lease_epoch: number
  lease_until: string
  attempt_count: number
  context: JsonObject
  event_type: string
  payload: JsonObject
}

export interface WorkflowTransitionInput {
  accountId: string
  workflowId: string
  expectedEpoch: number
  claimToken: string
  toState: string
  payload: JsonObject
  actorId: string
  transitionType?: string
  nextAttemptAt?: string | null
  errorCode?: string | null
  sanitizedErrorMessage?: string | null
  errorEvidenceRef?: string | null
  terminalReasonCode?: string | null
}

export interface WorkflowCheckpointInput {
  accountId: string
  workflowId: string
  expectedEpoch: number
  claimToken: string
  contextPatch: JsonObject
  actorId: string
}

export interface ConnectorPermit {
  allowed: boolean
  state: 'closed' | 'open' | 'half_open'
  permit_token?: string
  probe_token?: string | null
  expires_at?: string
  retry_at?: string | null
}

export interface PolicyDecisionInput {
  accountId: string
  workflowId: string
  rulesetId: string
  policyVersion: string
  decision: 'allow' | 'deny' | 'require_approval'
  reasons: unknown[]
  policyInput: JsonObject
  actionPayload: JsonObject
  actorId: string
  canonicalizationVersion?: string
  evidenceRef?: string | null
  approvalSummary?: string | null
  approvalTtlSeconds?: number
}

export interface EnqueueOutboxInput {
  accountId: string
  workflowId: string
  policyDecisionId: string
  connectorId: string
  actionType: string
  payload: JsonObject
  idempotencyKey: string
  actorId: string
  approvalRequestId?: string | null
  maxAttempts?: number
}

export interface ResolveApprovalInput {
  accountId: string
  workflowId: string
  approvalRequestId: string
  userId: string
  decision: 'approved' | 'rejected'
  connectorId: string
  actionType: string
  payload: JsonObject
  idempotencyKey: string
  maxAttempts?: number
}

export interface OutboxClaim {
  account_id: string
  outbox_action_id: string
  workflow_id: string
  connector_id: string
  action_type: string
  payload: JsonObject
  idempotency_key: string
  claim_token: string
  lease_epoch: number
  lease_until: string
  attempt_count: number
}

export interface FinishOutboxInput {
  accountId: string
  outboxActionId: string
  expectedEpoch: number
  claimToken: string
  resultStatus: 'completed' | 'retry_scheduled' | 'failed' | 'dead_letter' | 'cancelled'
  workerId: string
  nextAttemptAt?: string | null
  providerResultRef?: string | null
  errorCode?: string | null
  sanitizedErrorMessage?: string | null
  errorEvidenceRef?: string | null
  reconciliationState?: 'not_required' | 'ambiguous' | 'confirmed_effect' | 'confirmed_no_effect'
}

function objectResult<T extends object>(rpc: string, data: unknown): T {
  if (!data || Array.isArray(data) || typeof data !== 'object') {
    throw new RuntimeRpcError(rpc, { code: 'INVALID_RPC_RESULT' })
  }
  return data as T
}

function rowsResult<T>(rpc: string, data: unknown): T[] {
  if (!Array.isArray(data)) throw new RuntimeRpcError(rpc, { code: 'INVALID_RPC_RESULT' })
  return data as T[]
}

export class RuntimeClient {
  private readonly transport: RuntimeRpcTransport

  constructor(transport: RuntimeRpcTransport) {
    this.transport = transport
  }

  private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await this.transport.rpc(name, args)
    if (error) throw new RuntimeRpcError(name, error)
    return data
  }

  async ingestEvent(input: RuntimeIngestInput): Promise<RuntimeIngestResult> {
    const rpc = 'runtime_ingest_event'
    const data = await this.call(rpc, {
      p_account_id: input.accountId,
      p_provider: input.provider,
      p_external_event_id: input.externalEventId,
      p_payload: input.payload,
      p_execution_mode: input.executionMode,
      p_correlation_id: input.correlationId,
      p_event_type: input.eventType ?? 'unknown',
      p_occurred_at: input.occurredAt ?? new Date().toISOString(),
      p_contract_version: input.contractVersion ?? 'runtime-ingest-v1',
      p_identity_version: input.identityVersion ?? 'v1',
      p_workflow_type: input.workflowType ?? null,
      p_workflow_version: input.workflowVersion ?? 'v1',
      p_actor_id: input.actorId ?? 'runtime-client',
    })
    return objectResult<RuntimeIngestResult>(rpc, data)
  }

  async claimWorkflows(input: {
    workerId: string
    leaseDurationSeconds?: number
    limit?: number
    executionMode?: 'shadow' | 'live' | null
    workflowType?: string | null
  }): Promise<WorkflowClaim[]> {
    const rpc = 'runtime_claim_workflow'
    const data = await this.call(rpc, {
      p_worker_id: input.workerId,
      p_lease_duration_seconds: input.leaseDurationSeconds ?? 300,
      p_limit: input.limit ?? 1,
      p_execution_mode: input.executionMode ?? null,
      p_workflow_type: input.workflowType ?? null,
    })
    return rowsResult<WorkflowClaim>(rpc, data)
  }

  async checkpointAndTransition(input: WorkflowCheckpointInput): Promise<JsonObject> {
    const rpc = 'runtime_checkpoint_and_transition'
    const data = await this.call(rpc, {
      p_account_id: input.accountId,
      p_workflow_id: input.workflowId,
      p_expected_epoch: input.expectedEpoch,
      p_claim_token: input.claimToken,
      p_context_patch: input.contextPatch,
      p_actor_id: input.actorId,
    })
    return objectResult<JsonObject>(rpc, data)
  }

  async acquireConnectorPermit(input: {
    accountId: string
    connectorId: string
    operation: string
    permitTtlSeconds?: number
  }): Promise<ConnectorPermit> {
    const rpc = 'runtime_acquire_connector_permit'
    const data = await this.call(rpc, {
      p_account_id: input.accountId,
      p_connector_id: input.connectorId,
      p_operation: input.operation,
      p_permit_ttl_seconds: input.permitTtlSeconds ?? 30,
    })
    return objectResult<ConnectorPermit>(rpc, data)
  }

  async recordConnectorSuccess(input: {
    accountId: string
    connectorId: string
    operation: string
    permitToken: string
  }): Promise<JsonObject> {
    const rpc = 'runtime_record_connector_success'
    const data = await this.call(rpc, {
      p_account_id: input.accountId,
      p_connector_id: input.connectorId,
      p_operation: input.operation,
      p_permit_token: input.permitToken,
    })
    return objectResult<JsonObject>(rpc, data)
  }

  async recordConnectorFailure(input: {
    accountId: string
    connectorId: string
    operation: string
    permitToken: string
    errorCode: string
  }): Promise<JsonObject> {
    const rpc = 'runtime_record_connector_failure'
    const data = await this.call(rpc, {
      p_account_id: input.accountId,
      p_connector_id: input.connectorId,
      p_operation: input.operation,
      p_permit_token: input.permitToken,
      p_error_code: input.errorCode,
    })
    return objectResult<JsonObject>(rpc, data)
  }

  async transitionWorkflow(input: WorkflowTransitionInput): Promise<JsonObject> {
    const rpc = 'runtime_transition_workflow'
    const data = await this.call(rpc, {
      p_account_id: input.accountId,
      p_workflow_id: input.workflowId,
      p_expected_epoch: input.expectedEpoch,
      p_claim_token: input.claimToken,
      p_to_state: input.toState,
      p_payload: input.payload,
      p_actor_id: input.actorId,
      p_transition_type: input.transitionType ?? 'checkpoint_saved',
      p_next_attempt_at: input.nextAttemptAt ?? null,
      p_error_code: input.errorCode ?? null,
      p_sanitized_error_message: input.sanitizedErrorMessage ?? null,
      p_error_evidence_ref: input.errorEvidenceRef ?? null,
      p_terminal_reason_code: input.terminalReasonCode ?? null,
    })
    return objectResult<JsonObject>(rpc, data)
  }

  async recordPolicyDecision(input: PolicyDecisionInput): Promise<JsonObject> {
    const rpc = 'runtime_record_policy_decision'
    const data = await this.call(rpc, {
      p_account_id: input.accountId,
      p_workflow_id: input.workflowId,
      p_ruleset_id: input.rulesetId,
      p_policy_version: input.policyVersion,
      p_decision: input.decision,
      p_reasons: input.reasons,
      p_policy_input: input.policyInput,
      p_action_payload: input.actionPayload,
      p_actor_id: input.actorId,
      p_canonicalization_version: input.canonicalizationVersion ?? 'postgres-jsonb-v1',
      p_evidence_ref: input.evidenceRef ?? null,
      p_approval_summary: input.approvalSummary ?? null,
      p_approval_ttl_seconds: input.approvalTtlSeconds ?? 86400,
    })
    return objectResult<JsonObject>(rpc, data)
  }

  async enqueueOutboxAction(input: EnqueueOutboxInput): Promise<JsonObject> {
    const rpc = 'runtime_enqueue_outbox_action'
    const data = await this.call(rpc, {
      p_account_id: input.accountId,
      p_workflow_id: input.workflowId,
      p_policy_decision_id: input.policyDecisionId,
      p_connector_id: input.connectorId,
      p_action_type: input.actionType,
      p_payload: input.payload,
      p_idempotency_key: input.idempotencyKey,
      p_actor_id: input.actorId,
      p_approval_request_id: input.approvalRequestId ?? null,
      p_max_attempts: input.maxAttempts ?? 5,
    })
    return objectResult<JsonObject>(rpc, data)
  }

  async resolveApprovalAndEnqueue(input: ResolveApprovalInput): Promise<JsonObject> {
    const rpc = 'runtime_resolve_approval_and_enqueue_action'
    const data = await this.call(rpc, {
      p_account_id: input.accountId,
      p_workflow_id: input.workflowId,
      p_approval_request_id: input.approvalRequestId,
      p_user_id: input.userId,
      p_decision: input.decision,
      p_connector_id: input.connectorId,
      p_action_type: input.actionType,
      p_payload: input.payload,
      p_idempotency_key: input.idempotencyKey,
      p_max_attempts: input.maxAttempts ?? 5,
    })
    return objectResult<JsonObject>(rpc, data)
  }

  async claimOutboxActions(input: {
    workerId: string
    leaseDurationSeconds?: number
    limit?: number
    connectorId?: string | null
  }): Promise<OutboxClaim[]> {
    const rpc = 'runtime_claim_outbox_actions'
    const data = await this.call(rpc, {
      p_worker_id: input.workerId,
      p_lease_duration_seconds: input.leaseDurationSeconds ?? 300,
      p_limit: input.limit ?? 1,
      p_connector_id: input.connectorId ?? null,
    })
    return rowsResult<OutboxClaim>(rpc, data)
  }

  async finishOutboxAction(input: FinishOutboxInput): Promise<JsonObject> {
    const rpc = 'runtime_finish_outbox_action'
    const data = await this.call(rpc, {
      p_account_id: input.accountId,
      p_outbox_action_id: input.outboxActionId,
      p_expected_epoch: input.expectedEpoch,
      p_claim_token: input.claimToken,
      p_result_status: input.resultStatus,
      p_worker_id: input.workerId,
      p_next_attempt_at: input.nextAttemptAt ?? null,
      p_provider_result_ref: input.providerResultRef ?? null,
      p_error_code: input.errorCode ?? null,
      p_sanitized_error_message: input.sanitizedErrorMessage ?? null,
      p_error_evidence_ref: input.errorEvidenceRef ?? null,
      p_reconciliation_state: input.reconciliationState ?? 'not_required',
    })
    return objectResult<JsonObject>(rpc, data)
  }
}

export function createRuntimeClient(transport: RuntimeRpcTransport): RuntimeClient {
  return new RuntimeClient(transport)
}
