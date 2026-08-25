import { z } from 'zod'
import { ArtifactManifestSchema } from '../contracts/sandbox.ts'
import { redactText } from '../../supabase/functions/_shared/redact.ts'
import { WorkflowTraceInspector, type TraceRpcTransport } from './trace-inspector.ts'

const MAX_SIGNED_URL_TTL_SECONDS = 300
const APPROVAL_LIMIT = 50
const UUID = z.string().uuid()
const DashboardArtifactManifestSchema = ArtifactManifestSchema.pick({
  job_id: true,
  status: true,
  artifacts: true,
  provenance: true,
}).strip()
const DASHBOARD_ARTIFACT_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'video/mp4'])

const MetricsSchema = z.object({
  inbox_total: z.number().int().nonnegative(),
  outbox_delivered: z.number().int().nonnegative(),
  dead_letter_count: z.number().int().nonnegative(),
  live_gate_status: z.enum(['eligible', 'blocked', 'stale', 'no_data']),
  avg_grounding_score: z.number().min(0).max(1),
  f1_score: z.number().min(0).max(1),
  false_action_rate: z.number().min(0).max(1),
  uptime_seconds: z.number().int().nonnegative(),
  zero_data_loss: z.boolean(),
  orphaned_inbox_count: z.number().int().nonnegative(),
  eval_created_at: z.string().datetime({ offset: true }).nullable(),
}).strict()

const ApprovalRowSchema = z.object({
  id: UUID,
  workflow_id: UUID,
  action_type: z.string().min(1).max(128),
  summary: z.string().min(1).max(2_000),
  status: z.literal('pending'),
  expires_at: z.string().datetime({ offset: true }),
  created_at: z.string().datetime({ offset: true }),
  workflow_type: z.string().min(1).max(128),
  execution_mode: z.enum(['shadow', 'live']),
  sensor_metadata: z.record(z.unknown()),
  artifact_manifests: z.array(z.object({
    job_id: UUID,
    profile: z.enum(['PROFILE_A_WASI', 'PROFILE_B_DOCS', 'PROFILE_C_BROWSER', 'PROFILE_D_GPU']),
    result_manifest: z.unknown(),
  }).strict()).max(64),
}).strict()

const DecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().min(1).max(500).optional(),
}).strict()

export interface DashboardSession {
  userId: string
  accountId: string
  role: 'owner' | 'operator'
  isAdmin?: boolean
}

export interface DashboardApiDeps {
  rpc: TraceRpcTransport
  resolveSession(accessToken: string): Promise<DashboardSession | null>
  signArtifact(accountId: string, storagePath: string, ttlSeconds: number): Promise<string | null>
  now?: () => Date
}

export interface DashboardResponse {
  status: number
  body: Record<string, unknown>
}

function bearerToken(header: string | null | undefined): string | null {
  if (!header || header.length > 4_096) return null
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(header)
  return match?.[1] ?? null
}

async function sessionFor(
  deps: DashboardApiDeps,
  authorization: string | null | undefined,
): Promise<DashboardSession | null> {
  const token = bearerToken(authorization)
  if (!token) return null
  try {
    const session = await deps.resolveSession(token)
    if (!session) return null
    UUID.parse(session.userId)
    UUID.parse(session.accountId)
    if (session.role !== 'owner' && session.role !== 'operator' && !session.isAdmin) return null
    return session
  } catch {
    return null
  }
}

function unavailable(): DashboardResponse {
  return { status: 503, body: { error: 'dashboard_unavailable' } }
}

export async function handleDashboardMetrics(
  deps: DashboardApiDeps,
  authorization: string | null | undefined,
): Promise<DashboardResponse> {
  const session = await sessionFor(deps, authorization)
  if (!session) return { status: 401, body: { error: 'unauthorized' } }
  const { data, error } = await deps.rpc.rpc('runtime_dashboard_metrics', {
    p_account_id: session.accountId,
  })
  if (error || !data) return unavailable()
  const metrics = MetricsSchema.safeParse(data)
  return metrics.success
    ? { status: 200, body: { ok: true, metrics: metrics.data } }
    : unavailable()
}

interface SignedArtifact {
  name: string
  mime_type: string
  size_bytes: number
  sha256: string
  url: string
  expires_at: string
}

async function signedArtifacts(
  deps: DashboardApiDeps,
  accountId: string,
  manifests: z.infer<typeof ApprovalRowSchema>['artifact_manifests'],
): Promise<SignedArtifact[]> {
  const expiresAt = new Date((deps.now?.() ?? new Date()).getTime() + MAX_SIGNED_URL_TTL_SECONDS * 1_000)
  const output: SignedArtifact[] = []
  for (const item of manifests) {
    const manifest = DashboardArtifactManifestSchema.safeParse(item.result_manifest)
    if (!manifest.success || manifest.data.status !== 'COMPLETED') continue
    for (const artifact of manifest.data.artifacts) {
      if (!DASHBOARD_ARTIFACT_MIME_TYPES.has(artifact.mime_type)) continue
      if (!artifact.storage_path.startsWith(`tenants/${accountId}/`)) throw new Error('ARTIFACT_TENANT_MISMATCH')
      const signed = await deps.signArtifact(accountId, artifact.storage_path, MAX_SIGNED_URL_TTL_SECONDS)
      if (!signed) throw new Error('ARTIFACT_SIGNING_FAILED')
      const url = new URL(signed)
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('ARTIFACT_SIGNED_URL_INVALID')
      output.push({
        name: artifact.name,
        mime_type: artifact.mime_type,
        size_bytes: artifact.size_bytes,
        sha256: artifact.sha256,
        url: url.toString(),
        expires_at: expiresAt.toISOString(),
      })
    }
  }
  return output
}

export async function handleDashboardApprovals(
  deps: DashboardApiDeps,
  authorization: string | null | undefined,
): Promise<DashboardResponse> {
  const session = await sessionFor(deps, authorization)
  if (!session) return { status: 401, body: { error: 'unauthorized' } }
  const { data, error } = await deps.rpc.rpc('runtime_dashboard_list_approvals', {
    p_account_id: session.accountId,
    p_limit: APPROVAL_LIMIT,
  })
  if (error) return unavailable()
  const parsed = z.array(ApprovalRowSchema).max(APPROVAL_LIMIT).safeParse(data ?? [])
  if (!parsed.success) return unavailable()
  try {
    const approvals = await Promise.all(parsed.data.map(async (approval) => ({
      id: approval.id,
      workflow_id: approval.workflow_id,
      action_type: approval.action_type,
      summary: approval.summary,
      status: approval.status,
      expires_at: approval.expires_at,
      created_at: approval.created_at,
      workflow_type: approval.workflow_type,
      execution_mode: approval.execution_mode,
      sensor_metadata: approval.sensor_metadata,
      artifacts: await signedArtifacts(deps, session.accountId, approval.artifact_manifests),
    })))
    return { status: 200, body: { ok: true, approvals } }
  } catch {
    return unavailable()
  }
}

export async function handleDashboardApprovalDecision(
  deps: DashboardApiDeps,
  authorization: string | null | undefined,
  approvalId: string,
  body: unknown,
): Promise<DashboardResponse> {
  const session = await sessionFor(deps, authorization)
  if (!session) return { status: 401, body: { error: 'unauthorized' } }
  const safeId = UUID.safeParse(approvalId)
  const decision = DecisionSchema.safeParse(body)
  if (!safeId.success || !decision.success) return { status: 400, body: { error: 'invalid_request' } }
  const { data, error } = await deps.rpc.rpc('runtime_dashboard_decide_approval', {
    p_account_id: session.accountId,
    p_approval_request_id: safeId.data,
    p_user_id: session.userId,
    p_decision: decision.data.decision,
    p_reason: decision.data.reason ? redactText(decision.data.reason).slice(0, 500) : null,
  })
  if (error || !data) return { status: 409, body: { error: 'approval_not_pending' } }
  return { status: 200, body: { ok: true, result: data } }
}

export async function handleDashboardTrace(
  deps: DashboardApiDeps,
  authorization: string | null | undefined,
  workflowId: string,
): Promise<DashboardResponse> {
  const session = await sessionFor(deps, authorization)
  if (!session) return { status: 401, body: { error: 'unauthorized' } }
  try {
    const trace = await new WorkflowTraceInspector(deps.rpc)
      .getWorkflowTrace(workflowId, session.accountId)
    return { status: 200, body: { ok: true, trace } }
  } catch {
    return { status: 404, body: { error: 'workflow_not_found' } }
  }
}

export const dashboardApiLimits = Object.freeze({
  signedUrlTtlSeconds: MAX_SIGNED_URL_TTL_SECONDS,
  approvalLimit: APPROVAL_LIMIT,
})
