import { describe, expect, test } from 'vitest'
import {
  dashboardApiLimits,
  handleDashboardApprovalDecision,
  handleDashboardApprovals,
  handleDashboardMetrics,
  handleDashboardTrace,
  type DashboardApiDeps,
} from '../agent-hub/server/dashboard-api.ts'

const ACCOUNT_A = '01917b12-3a5c-7d9e-bf33-9118c7e7b801'
const ACCOUNT_B = '01917b12-3a5c-7d9e-bf33-9118c7e7b802'
const USER_A = '01917b12-3a5c-7d9e-bf33-9118c7e7b803'
const APPROVAL_A = '01917b12-3a5c-7d9e-bf33-9118c7e7b804'
const APPROVAL_B = '01917b12-3a5c-7d9e-bf33-9118c7e7b805'
const WORKFLOW_A = '01917b12-3a5c-7d9e-bf33-9118c7e7b806'
const JOB_A = '01917b12-3a5c-7d9e-bf33-9118c7e7b807'
const NOW = new Date('2026-08-25T12:00:00.000Z')
const TOKEN = 'valid.session.token'

type RpcResult = { data: unknown; error: { code?: string; message?: string } | null }

class DashboardHarness {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = []
  readonly decisions = new Map<string, string>()

  async rpc(name: string, args: Record<string, unknown>): Promise<RpcResult> {
    this.calls.push({ name, args })
    if (name === 'runtime_dashboard_metrics') {
      return {
        data: {
          inbox_total: 125,
          outbox_delivered: 120,
          dead_letter_count: 1,
          live_gate_status: 'eligible',
          avg_grounding_score: 0.98,
          f1_score: 0.97,
          false_action_rate: 0.005,
          uptime_seconds: 86_400,
          zero_data_loss: true,
          orphaned_inbox_count: 0,
          eval_created_at: '2026-08-25T10:00:00+00:00',
        },
        error: null,
      }
    }
    if (name === 'runtime_dashboard_list_approvals') {
      return {
        data: [{
          id: APPROVAL_A,
          workflow_id: WORKFLOW_A,
          action_type: 'send_grounded_offer',
          summary: 'Send grounded offer to CRM contact',
          status: 'pending',
          expires_at: '2026-08-25T13:00:00+00:00',
          created_at: '2026-08-25T11:55:00+00:00',
          workflow_type: 'vision_live_candidate',
          execution_mode: 'live',
          sensor_metadata: { trust_level: 'untrusted', attributes: { plate: '01A777AA' } },
          artifact_manifests: [{
            job_id: JOB_A,
            profile: 'PROFILE_B_DOCS',
            result_manifest: {
              job_id: JOB_A,
              status: 'COMPLETED',
              exit_code: 0,
              execution_time_ms: 250,
              stdout_sanitized: '',
              stderr_sanitized: '',
              artifacts: [{
                name: 'quote.pdf',
                mime_type: 'application/pdf',
                size_bytes: 1024,
                sha256: 'a'.repeat(64),
                storage_path: `tenants/${ACCOUNT_A}/artifacts/2026/08/25/quote.pdf`,
              }],
              provenance: { engine_version: 'nemo-docs/1', seed: 42 },
            },
          }],
        }],
        error: null,
      }
    }
    if (name === 'runtime_dashboard_decide_approval') {
      if (args.p_account_id !== ACCOUNT_A || args.p_approval_request_id === APPROVAL_B) {
        return { data: null, error: { code: 'P0002' } }
      }
      const state = args.p_decision === 'approve' ? 'waiting_for_action' : 'cancelled'
      this.decisions.set(String(args.p_approval_request_id), state)
      return { data: { state, decision: args.p_decision }, error: null }
    }
    if (name === 'runtime_dashboard_workflow_trace') {
      if (args.p_account_id !== ACCOUNT_A || args.p_workflow_id !== WORKFLOW_A) {
        return { data: null, error: { code: 'P0002' } }
      }
      return {
        data: {
          workflow: { id: WORKFLOW_A, current_state: 'waiting_for_approval' },
          transitions: [{ sequence: 1, from_state: 'received', to_state: 'queued', phase_duration_ms: 4 }],
          compute_jobs: [{ id: JOB_A, profile: 'PROFILE_B_DOCS', duration_ms: 250 }],
          outbox_actions: [],
          self_healing_iterations: [{ id: JOB_A, details: { attempt: 1, status: 'completed' } }],
        },
        error: null,
      }
    }
    return { data: null, error: { code: 'UNKNOWN_RPC' } }
  }
}

function dependencies(harness = new DashboardHarness()): DashboardApiDeps & { harness: DashboardHarness } {
  return {
    harness,
    rpc: harness,
    now: () => NOW,
    resolveSession: async (token) => token === TOKEN
      ? { userId: USER_A, accountId: ACCOUNT_A, role: 'operator' }
      : null,
    signArtifact: async (accountId, storagePath, ttlSeconds) => {
      if (accountId !== ACCOUNT_A || !storagePath.startsWith(`tenants/${ACCOUNT_A}/`) || ttlSeconds > 300) return null
      return `https://storage.example.test/signed/${encodeURIComponent(storagePath)}?ttl=${ttlSeconds}`
    },
  }
}

describe('Operational dashboard metrics and approvals', () => {
  test('aggregates tenant metrics and exposes the live-gate reliability state', async () => {
    const deps = dependencies()
    const response = await handleDashboardMetrics(deps, `Bearer ${TOKEN}`)
    expect(response.status).toBe(200)
    expect(response.body.metrics).toMatchObject({
      inbox_total: 125,
      outbox_delivered: 120,
      live_gate_status: 'eligible',
      f1_score: 0.97,
      false_action_rate: 0.005,
      zero_data_loss: true,
    })
    expect(deps.harness.calls[0].args.p_account_id).toBe(ACCOUNT_A)
  })

  test('returns tenant-bound artifact URLs with a five-minute maximum TTL', async () => {
    const deps = dependencies()
    const response = await handleDashboardApprovals(deps, `Bearer ${TOKEN}`)
    expect(response.status).toBe(200)
    const approvals = response.body.approvals as Array<Record<string, unknown>>
    const artifacts = approvals[0].artifacts as Array<Record<string, unknown>>
    expect(artifacts[0].url).toContain(`ttl=${dashboardApiLimits.signedUrlTtlSeconds}`)
    expect(artifacts[0]).not.toHaveProperty('storage_path')
    expect(new Date(String(artifacts[0].expires_at)).getTime() - NOW.getTime()).toBe(300_000)
  })

  test('atomically routes approval to waiting_for_action and rejection to cancelled', async () => {
    const deps = dependencies()
    const approved = await handleDashboardApprovalDecision(
      deps, `Bearer ${TOKEN}`, APPROVAL_A, { decision: 'approve' },
    )
    expect(approved.status).toBe(200)
    expect(deps.harness.decisions.get(APPROVAL_A)).toBe('waiting_for_action')

    const rejected = await handleDashboardApprovalDecision(
      deps, `Bearer ${TOKEN}`, APPROVAL_A, { decision: 'reject', reason: 'Customer opted out; token=supersecretvalue' },
    )
    expect(rejected.status).toBe(200)
    expect(deps.harness.decisions.get(APPROVAL_A)).toBe('cancelled')
    expect(deps.harness.calls.at(-1)?.args.p_reason).toBe('Customer opted out; token=[REDACTED]')
  })

  test('cannot decide an approval belonging to another tenant', async () => {
    const deps = dependencies()
    const response = await handleDashboardApprovalDecision(
      deps, `Bearer ${TOKEN}`, APPROVAL_B, { decision: 'approve' },
    )
    expect(response).toEqual({ status: 409, body: { error: 'approval_not_pending' } })
    const call = deps.harness.calls.at(-1)!
    expect(call.args.p_account_id).toBe(ACCOUNT_A)
    expect(call.args).not.toHaveProperty('p_account_id', ACCOUNT_B)
  })

  test('returns a tenant-scoped FSM, compute, outbox and self-healing trace', async () => {
    const deps = dependencies()
    const response = await handleDashboardTrace(deps, `Bearer ${TOKEN}`, WORKFLOW_A)
    expect(response.status).toBe(200)
    expect(response.body.trace).toMatchObject({
      workflow: { id: WORKFLOW_A },
      transitions: [{ to_state: 'queued' }],
      compute_jobs: [{ profile: 'PROFILE_B_DOCS' }],
      self_healing_iterations: [{ details: { attempt: 1 } }],
    })
  })

  test('rejects missing and malformed session tokens before any privileged RPC', async () => {
    const deps = dependencies()
    expect((await handleDashboardMetrics(deps, null)).status).toBe(401)
    expect((await handleDashboardMetrics(deps, 'Bearer wrong token')).status).toBe(401)
    expect(deps.harness.calls).toHaveLength(0)
  })
})
