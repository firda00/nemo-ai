import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { ArtifactManifestSchema, type ArtifactManifest } from '../agent-hub/contracts/sandbox.ts'
import { renderTypstPdf } from '../agent-hub/documents/typst-renderer.ts'
import { checkSensorGrounding } from '../agent-hub/evals/grounding-checker.ts'
import { runPrecisionEval, type PrecisionEvalResult } from '../agent-hub/evals/eval-runner.ts'
import { probeCapabilities } from '../agent-hub/media/ffmpeg-engine.ts'
import { deriveFfprobePath, runFfmpegPipeline } from '../agent-hub/media/ffmpeg-pipeline.ts'
import { createStoryboardManifest } from '../agent-hub/media/storyboard-engine.ts'
import { makeSolidPng } from '../agent-hub/media/test-fixtures.mjs'
import { SubagentSupervisor, type SubagentExecutor } from '../agent-hub/orchestration/subagent-supervisor.ts'
import { runWasiSandbox } from '../agent-hub/sandbox/wasi-runner.ts'
import { buildGateway } from '../agent-hub/server/gateway.ts'
import { disabledQueue } from '../agent-hub/server/queue.ts'
import { canRoleUseProfile } from '../agent-hub/skills/agency-roles.ts'
import { signVisionBody } from '../agent-hub/vision/device-verifier.ts'
import {
  createRuntimeClient,
  type RuntimeRpcErrorShape,
  type RuntimeRpcTransport,
} from '../supabase/functions/_shared/runtime.ts'

const ACCOUNT_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7b801'
const DEVICE_ID = 'bay-camera-e2e-01'
const DEVICE_SECRET = 'e2e-device-secret-with-at-least-32-bytes'
const WORKFLOW_TYPE = 'vision_event_shadow_evaluation'

type ExecutionMode = 'shadow' | 'live'

interface RuntimeWorkflowRow {
  id: string
  account_id: string
  execution_mode: ExecutionMode
  current_state: string
  workflow_type: string
  context: Record<string, unknown>
}

interface RuntimeInboxRow {
  id: string
  account_id: string
  provider: string
  external_event_id: string
  payload: Record<string, unknown>
  workflow_id: string
}

interface RuntimeOutboxRow {
  id: string
  account_id: string
  workflow_id: string
  policy_decision_id: string
  connector_id: string
  action_type: string
  payload: Record<string, unknown>
}

/**
 * Contract-level Runtime adapter. PostgreSQL race/FK/RLS behavior remains covered by the SQL
 * invariant suites; this harness composes the public SECURITY DEFINER RPC contract without placing
 * a service-role credential or a real tenant integration in the E2E process.
 */
class InMemoryRuntime implements RuntimeRpcTransport {
  readonly inboxEvents: RuntimeInboxRow[] = []
  readonly workflows = new Map<string, RuntimeWorkflowRow>()
  readonly outboxActions: RuntimeOutboxRow[] = []
  private evalResult: PrecisionEvalResult | null = null

  async rpc(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: RuntimeRpcErrorShape | null }> {
    try {
      if (name === 'runtime_ingest_event') return { data: this.ingest(args), error: null }
      if (name === 'runtime_evaluate_live_gate') return { data: this.evaluateLiveGate(args), error: null }
      if (name === 'runtime_enqueue_outbox_action') return { data: this.enqueueOutbox(args), error: null }
      return { data: null, error: { code: 'RPC_NOT_IMPLEMENTED' } }
    } catch (error) {
      return {
        data: null,
        error: { code: error instanceof Error ? error.message : 'RUNTIME_TEST_FAILURE' },
      }
    }
  }

  recordEvalSummary(result: PrecisionEvalResult): void {
    this.evalResult = result
  }

  completeShadowEvaluation(workflowId: string, context: Record<string, unknown>): void {
    const workflow = this.workflows.get(workflowId)
    if (!workflow || workflow.execution_mode !== 'shadow') throw new Error('SHADOW_WORKFLOW_REQUIRED')
    workflow.current_state = 'completed'
    workflow.context = { ...workflow.context, ...context }
  }

  createLiveCandidate(shadowWorkflowId: string, proposedAction: Record<string, unknown>): RuntimeWorkflowRow {
    const shadow = this.workflows.get(shadowWorkflowId)
    if (!shadow || shadow.execution_mode !== 'shadow' || shadow.current_state !== 'completed') {
      throw new Error('GROUNDED_SHADOW_WORKFLOW_REQUIRED')
    }
    const grounding = shadow.context.grounding as { grounded?: unknown } | undefined
    if (grounding?.grounded !== true || !this.evalResult?.eligible_for_live) {
      throw new Error('GROUNDED_SHADOW_WORKFLOW_REQUIRED')
    }
    const live: RuntimeWorkflowRow = {
      id: randomUUID(),
      account_id: shadow.account_id,
      execution_mode: 'live',
      current_state: 'waiting_for_policy',
      workflow_type: shadow.workflow_type,
      context: { source_shadow_workflow_id: shadow.id, proposed_action: proposedAction },
    }
    this.workflows.set(live.id, live)
    return live
  }

  private ingest(args: Record<string, unknown>): Record<string, unknown> {
    const accountId = String(args.p_account_id)
    const externalEventId = String(args.p_external_event_id)
    const existing = this.inboxEvents.find((row) =>
      row.account_id === accountId
      && row.provider === String(args.p_provider)
      && row.external_event_id === externalEventId)
    if (existing) {
      return { status: 'duplicate', workflow_id: existing.workflow_id, inbox_event_id: existing.id }
    }
    const workflow: RuntimeWorkflowRow = {
      id: randomUUID(),
      account_id: accountId,
      execution_mode: String(args.p_execution_mode) as ExecutionMode,
      current_state: 'received',
      workflow_type: String(args.p_workflow_type),
      context: {},
    }
    const inbox: RuntimeInboxRow = {
      id: randomUUID(),
      account_id: accountId,
      provider: String(args.p_provider),
      external_event_id: externalEventId,
      payload: args.p_payload as Record<string, unknown>,
      workflow_id: workflow.id,
    }
    this.workflows.set(workflow.id, workflow)
    this.inboxEvents.push(inbox)
    return { status: 'created', workflow_id: workflow.id, inbox_event_id: inbox.id }
  }

  private evaluateLiveGate(args: Record<string, unknown>): Record<string, unknown> {
    const workflow = this.workflows.get(String(args.p_workflow_id))
    const confidence = Number(args.p_confidence_score)
    const threshold = Number(args.p_threshold)
    if (!workflow || workflow.account_id !== String(args.p_account_id)) throw new Error('WORKFLOW_NOT_FOUND')
    if (workflow.execution_mode !== 'live' || workflow.current_state !== 'waiting_for_policy') {
      throw new Error('LIVE_GATE_STATE_INVALID')
    }
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1
      || !Number.isFinite(threshold) || threshold < 0.95 || threshold > 1) {
      throw new Error('LIVE_GATE_SCORE_INVALID')
    }
    if (!this.evalResult?.eligible_for_live || confidence < threshold) throw new Error('LIVE_GATE_BLOCKED')
    workflow.current_state = 'waiting_for_action'
    return {
      live_gate_decision: 'allow',
      outbox_eligibility: 'queued',
      policy_decision_id: randomUUID(),
    }
  }

  private enqueueOutbox(args: Record<string, unknown>): Record<string, unknown> {
    const workflow = this.workflows.get(String(args.p_workflow_id))
    if (!workflow || workflow.execution_mode !== 'live' || workflow.current_state !== 'waiting_for_action') {
      throw new Error('OUTBOX_STATE_INVALID')
    }
    const action: RuntimeOutboxRow = {
      id: randomUUID(),
      account_id: String(args.p_account_id),
      workflow_id: workflow.id,
      policy_decision_id: String(args.p_policy_decision_id),
      connector_id: String(args.p_connector_id),
      action_type: String(args.p_action_type),
      payload: args.p_payload as Record<string, unknown>,
    }
    this.outboxActions.push(action)
    return { outbox_action_id: action.id, status: 'pending' }
  }
}

function uuidV7(timestampMs: number): string {
  const timestamp = Math.floor(timestampMs).toString(16).padStart(12, '0').slice(-12)
  const random = randomBytes(10).toString('hex')
  const variant = ['8', '9', 'a', 'b'][randomBytes(1)[0] & 3]
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${random.slice(0, 3)}-${variant}${random.slice(3, 6)}-${random.slice(6, 18)}`
}

function artifactManifest(input: {
  jobId: string
  name: string
  mimeType: string
  bytes: Uint8Array
  storagePath: string
  engineVersion: string
  executionTimeMs: number
  seed: string | number
  durationSeconds?: number
}): ArtifactManifest {
  return ArtifactManifestSchema.parse({
    job_id: input.jobId,
    status: 'COMPLETED',
    exit_code: 0,
    execution_time_ms: input.executionTimeMs,
    stdout_sanitized: '',
    stderr_sanitized: '',
    artifacts: [{
      name: input.name,
      mime_type: input.mimeType,
      size_bytes: input.bytes.byteLength,
      ...(input.durationSeconds ? { duration_seconds: input.durationSeconds } : {}),
      sha256: createHash('sha256').update(input.bytes).digest('hex'),
      storage_path: input.storagePath,
    }],
    provenance: { engine_version: input.engineVersion, seed: input.seed },
  })
}

describe('ADR 001/002 multimodal business pipeline', () => {
  test('camera shadow ingest -> isolated agents -> grounding -> live candidate -> outbox', async () => {
    const runtime = new InMemoryRuntime()
    const now = Date.now()
    const eventId = uuidV7(now)
    const event = {
      event_id: eventId,
      account_id: ACCOUNT_ID,
      device_id: DEVICE_ID,
      timestamp: new Date(now).toISOString(),
      event_type: 'BAY_VEHICLE_ENTERED',
      precision_score: 0.99,
      untrusted_attributes: {
        license_plate_raw: '01A777AA',
        vehicle_model_raw: 'Chevrolet Cobalt',
      },
    }
    const rawBody = Buffer.from(JSON.stringify(event))
    const app = await buildGateway({
      admin: runtime,
      queue: disabledQueue(),
      pepper: 'e2e-gateway-pepper',
      crmSecret: 'e2e-crm-gateway-secret',
      now: () => now,
      visionDeviceResolver: async (deviceId) => deviceId === DEVICE_ID ? ({
        accountId: ACCOUNT_ID, deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET,
      }) : null,
    } as never, { logger: false })
    const response = await app.inject({
      method: 'POST',
      url: '/v1/vision/events',
      headers: {
        'content-type': 'application/json',
        'x-nemo-device-signature': signVisionBody(rawBody, DEVICE_SECRET),
      },
      payload: rawBody,
    })
    await app.close()
    const gateway = response.json<Record<string, unknown>>()

    expect(response.statusCode).toBe(202)
    expect(runtime.inboxEvents).toHaveLength(1)
    expect(runtime.inboxEvents[0]).toMatchObject({
      account_id: ACCOUNT_ID,
      provider: 'vision',
      external_event_id: eventId,
    })
    expect(runtime.inboxEvents[0].payload).toMatchObject({
      event_type: 'BAY_VEHICLE_ENTERED',
      safety: { execution_mode: 'shadow', external_side_effects_allowed: false },
    })
    const shadowWorkflowId = String(gateway.workflow_id)
    expect(runtime.workflows.get(shadowWorkflowId)?.execution_mode).toBe('shadow')
    expect(runtime.workflows.get(shadowWorkflowId)?.workflow_type).toBe(WORKFLOW_TYPE)

    const datePath = new Date(now).toISOString().slice(0, 10).replaceAll('-', '/')
    const mediaDirectory = await mkdtemp(path.join(tmpdir(), 'nemo-e2e-media-'))
    try {
      const png = makeSolidPng(320, 180, [21, 96, 189])
      const pngPath = path.join(mediaDirectory, 'vehicle.png')
      const mp4Path = path.join(mediaDirectory, 'vehicle-promo.mp4')
      await writeFile(pngPath, png)
      const ffmpegPath = process.env.FFMPEG_PATH ?? path.join(
        import.meta.dirname, '..', 'render-worker', 'node_modules', '@remotion',
        'compositor-win32-x64-msvc', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
      )
      const capabilities = await probeCapabilities(ffmpegPath)
      expect(capabilities.missingRequired).toEqual([])

      const executor: SubagentExecutor = async (task) => {
        const profile = String(task.input.profile) as 'PROFILE_A_WASI' | 'PROFILE_B_DOCS' | 'PROFILE_C_BROWSER'
        if (!canRoleUseProfile(task.role, profile)) throw new Error('COMPUTE_PROFILE_DENIED')

        if (task.id === 'estimate') {
          const sandbox = await runWasiSandbox({
            jobId: String(task.input.job_id),
            input: {
              source: `
const labor = parameters.labor_hours * parameters.hourly_rate;
const total = labor + parameters.materials;
console.log(JSON.stringify({ labor, materials: parameters.materials, total, currency: parameters.currency }));
`,
              parameters: { labor_hours: 3.5, hourly_rate: 250_000, materials: 450_000, currency: 'UZS' },
            },
          })
          if (sandbox.status !== 'completed' || !sandbox.manifest) throw new Error('ESTIMATE_SANDBOX_FAILED')
          return {
            merge_marker: 'estimate',
            estimate: JSON.parse(sandbox.manifest.stdout_sanitized),
            estimate_manifest: ArtifactManifestSchema.parse(sandbox.manifest),
          }
        }

        if (task.id === 'proposal') {
          const started = performance.now()
          const rendered = renderTypstPdf({
            kind: 'typst_document',
            template: 'commercial_proposal',
            output_name: 'commercial-proposal.pdf',
            title: 'Nemo AI Service Proposal',
            recipient: 'CRM Deal deal-42',
            currency: 'UZS',
            sections: [{ heading: 'Vehicle service', body: 'Grounded estimate for Chevrolet Cobalt.' }],
            line_items: [
              { description: 'Labor hours', quantity: 3.5, unit_price: 250_000 },
              { description: 'Materials', quantity: 1, unit_price: 450_000 },
            ],
            seed: 42,
          })
          return {
            merge_marker: 'proposal',
            pdf_manifest: artifactManifest({
              jobId: String(task.input.job_id),
              name: rendered.outputName,
              mimeType: 'application/pdf',
              bytes: rendered.bytes,
              storagePath: `tenants/${ACCOUNT_ID}/artifacts/${datePath}/${rendered.outputName}`,
              engineVersion: 'typst-ts/0.7.0-profile-b',
              executionTimeMs: Math.round(performance.now() - started),
              seed: rendered.seed,
            }),
          }
        }

        const storyboard = createStoryboardManifest({
          title: 'Vehicle service promo',
          scenes: [
            { asset_id: 'vehicle', duration_seconds: 0.3, overlay: 'Vehicle received' },
            { asset_id: 'vehicle', duration_seconds: 0.3, overlay: 'Estimate prepared' },
          ],
        }, {
          account_id: ACCOUNT_ID,
          output_name: 'vehicle-promo.mp4',
          upload_url: `https://storage.example.test/tenants/${ACCOUNT_ID}/artifacts/${datePath}/vehicle-promo.mp4`,
          expires_at: new Date(now + 240_000).toISOString(),
          date_path: datePath,
          assets: [{
            id: 'vehicle',
            download_url: `https://storage.example.test/tenants/${ACCOUNT_ID}/assets/vehicle.png`,
            mime_type: 'image/png',
            size_bytes: png.byteLength,
            sha256: createHash('sha256').update(png).digest('hex'),
          }],
          width: 320,
          height: 180,
          fps: 10,
          video_bitrate_kbps: 300,
          max_output_bytes: 2 * 1024 * 1024,
          seed: 42,
        })
        const rendered = await runFfmpegPipeline({
          payload: storyboard,
          inputs: {
            assets: new Map([['vehicle', pngPath]]),
            subtitlesPath: null,
            outputPath: mp4Path,
            workDirectory: mediaDirectory,
          },
          capabilities,
          ffmpegPath,
          ffprobePath: deriveFfprobePath(ffmpegPath),
        })
        return {
          merge_marker: 'media',
          storyboard,
          video_manifest: artifactManifest({
            jobId: String(task.input.job_id),
            name: storyboard.output_name,
            mimeType: 'video/mp4',
            bytes: rendered.bytes,
            storagePath: storyboard.output.storage_path,
            engineVersion: 'ffmpeg-profile-c/e2e',
            executionTimeMs: rendered.executionTimeMs,
            seed: storyboard.seed,
            durationSeconds: rendered.durationSeconds,
          }),
        }
      }

      const result = await new SubagentSupervisor(executor).run([
        { id: 'estimate', role: 'FINANCE_ANALYST', input: { profile: 'PROFILE_A_WASI', job_id: randomUUID() } },
        { id: 'proposal', role: 'MARKETER', input: { profile: 'PROFILE_B_DOCS', job_id: randomUUID() } },
        { id: 'media', role: 'MARKETER', input: { profile: 'PROFILE_C_BROWSER', job_id: randomUUID() } },
      ])
      expect(result.branches.map((branch) => branch.status)).toEqual(['completed', 'completed', 'completed'])
      expect(result.merged.merge_marker).toBe('media')
      expect(result.merged.estimate).toEqual({ labor: 875_000, materials: 450_000, total: 1_325_000, currency: 'UZS' })
      const estimateManifest = ArtifactManifestSchema.parse(result.merged.estimate_manifest)
      const pdfManifest = ArtifactManifestSchema.parse(result.merged.pdf_manifest)
      const videoManifest = ArtifactManifestSchema.parse(result.merged.video_manifest)
      expect(estimateManifest.provenance.engine_version).toContain('profile-a')
      expect(pdfManifest.artifacts[0].mime_type).toBe('application/pdf')
      expect(videoManifest.artifacts[0]).toMatchObject({ mime_type: 'video/mp4' })
      expect(videoManifest.artifacts[0].duration_seconds).toBeGreaterThan(0)

      const grounding = checkSensorGrounding({
        observations: [{
          domain: 'deal',
          entity_id: 'deal-42',
          confidence: event.precision_score,
          attributes: { license_plate: '01A777AA', vehicle_model: 'Chevrolet Cobalt', estimate_total: 1_325_000 },
        }],
        confirmedEntities: [{
          domain: 'deal',
          entity_id: 'deal-42',
          active: true,
          attributes: { license_plate: '01A777AA', vehicle_model: 'Chevrolet Cobalt', estimate_total: 1_325_000 },
        }],
      })
      expect(grounding).toMatchObject({ grounded: true, grounding_score: 1, false_detection: false })

      const evalResult = runPrecisionEval(Array.from({ length: 100 }, (_, index) => ({
        workflow_id: `shadow-eval-${index}`,
        predicted_action: index < 90,
        expected_action: index < 90,
        grounding_score: 1,
      })))
      const f1 = 2 * evalResult.precision * evalResult.recall / (evalResult.precision + evalResult.recall)
      expect(f1).toBeGreaterThanOrEqual(0.95)
      expect(evalResult.false_action_rate).toBeLessThanOrEqual(0.01)
      expect(evalResult.eligible_for_live).toBe(true)
      runtime.recordEvalSummary(evalResult)
      runtime.completeShadowEvaluation(shadowWorkflowId, { grounding, artifacts: [pdfManifest, videoManifest] })

      const proposedAction = {
        channel: 'amocrm',
        action: 'send_grounded_offer',
        deal_id: 'deal-42',
        estimate_total: 1_325_000,
        artifact_refs: {
          pdf: pdfManifest.artifacts[0].storage_path,
          mp4: videoManifest.artifacts[0].storage_path,
        },
      }
      // ADR 002 forbids upgrading a shadow row. A separate live candidate keeps the sensor ingest
      // immutable and links the authorized action back to its evaluated shadow workflow.
      const liveWorkflow = runtime.createLiveCandidate(shadowWorkflowId, proposedAction)
      expect(liveWorkflow.id).not.toBe(shadowWorkflowId)
      expect(runtime.workflows.get(shadowWorkflowId)?.execution_mode).toBe('shadow')

      const gate = await runtime.rpc('runtime_evaluate_live_gate', {
        p_account_id: ACCOUNT_ID,
        p_workflow_id: liveWorkflow.id,
        p_confidence_score: grounding.grounding_score,
        p_threshold: 0.95,
      })
      expect(gate.error).toBeNull()
      expect(gate.data).toMatchObject({ live_gate_decision: 'allow', outbox_eligibility: 'queued' })
      expect(runtime.workflows.get(liveWorkflow.id)?.current_state).toBe('waiting_for_action')

      const policyDecisionId = String((gate.data as Record<string, unknown>).policy_decision_id)
      await createRuntimeClient(runtime).enqueueOutboxAction({
        accountId: ACCOUNT_ID,
        workflowId: liveWorkflow.id,
        policyDecisionId,
        connectorId: 'amocrm-primary',
        actionType: 'send_grounded_offer',
        payload: proposedAction,
        idempotencyKey: `grounded-offer:${liveWorkflow.id}`,
        actorId: 'e2e-live-gate',
      })
      expect(runtime.outboxActions).toHaveLength(1)
      expect(runtime.outboxActions[0]).toMatchObject({
        account_id: ACCOUNT_ID,
        workflow_id: liveWorkflow.id,
        policy_decision_id: policyDecisionId,
        connector_id: 'amocrm-primary',
        action_type: 'send_grounded_offer',
        payload: {
          artifact_refs: {
            pdf: pdfManifest.artifacts[0].storage_path,
            mp4: videoManifest.artifacts[0].storage_path,
          },
        },
      })
    } finally {
      await rm(mediaDirectory, { recursive: true, force: true })
    }
  }, 120_000)
})
