import assert from 'node:assert/strict'
import {
  ArtifactManifestSchema,
  ComputeJobSchema,
  VisionEventSchema,
} from '../agent-hub/contracts/sandbox.ts'
import { runWasiSandbox, sanitizeSandboxOutput } from '../agent-hub/sandbox/wasi-runner.ts'

const JOB_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7b8a1'

const completed = await runWasiSandbox({
  jobId: JOB_ID,
  input: {
    source: 'console.log(parameters.items.reduce((sum, value) => sum + value, 0)); globalThis.__nemo_result = { total: 42 };',
    parameters: { items: [10, 12, 20] },
  },
})
assert.equal(completed.status, 'completed')
assert.equal(completed.manifest?.stdout_sanitized, '42')
assert.equal(completed.manifest?.provenance.engine_version, 'deno-2.9.5-profile-a')

const networkDenied = await runWasiSandbox({
  jobId: JOB_ID,
  input: { source: "await fetch('https://example.com')", parameters: {} },
})
assert.equal(networkDenied.status, 'failed')
assert.equal(networkDenied.errorCode, 'SANDBOX_EXECUTION_FAILED')
assert.match(networkDenied.manifest?.stderr_sanitized ?? '', /network|permission|Requires net access/i)

const filesystemDenied = await runWasiSandbox({
  jobId: JOB_ID,
  input: { source: "await Deno.readTextFile('C:/Windows/win.ini')", parameters: {} },
})
assert.equal(filesystemDenied.status, 'failed')
assert.match(filesystemDenied.manifest?.stderr_sanitized ?? '', /read access|permission/i)

const timedOut = await runWasiSandbox({
  jobId: JOB_ID,
  input: { source: 'while (true) {}', parameters: {} },
  timeoutMs: 100,
})
assert.equal(timedOut.status, 'failed')
assert.equal(timedOut.errorCode, 'SANDBOX_TIMEOUT')
assert.equal(timedOut.manifest?.exit_code, 124)

const tooMuchOutput = await runWasiSandbox({
  jobId: JOB_ID,
  input: { source: "console.log('x'.repeat(70 * 1024))", parameters: {} },
})
assert.equal(tooMuchOutput.status, 'failed')
assert.equal(tooMuchOutput.errorCode, 'SANDBOX_OUTPUT_LIMIT')
assert.ok(Buffer.byteLength(tooMuchOutput.manifest?.stdout_sanitized ?? '', 'utf8') <= 64 * 1024)

const syntheticToken = ['sk', 'or', 'v1', 'abcdefghijklmnopqrstuvwxyz'].join('-')
const sanitized = sanitizeSandboxOutput(
  `Authorization: Bearer abcdefghijklmnopqrstuvwxyz api_key=${syntheticToken} +998901112233`,
)
assert.equal(sanitized.includes(syntheticToken), false)
assert.equal(sanitized.includes('+998901112233'), false)
assert.match(sanitized, /REDACTED/)
assert.equal(sanitized.includes('$1='), false)

ComputeJobSchema.parse({
  account_id: '01917b12-3a5c-7d9e-bf33-9118c7e7b801',
  job_id: JOB_ID,
  workflow_id: '01917b12-3a5c-7d9e-bf33-9118c7e7b800',
  profile: 'PROFILE_A_WASI',
  claim_token: 'a1b2c3d4-e5f6-4890-abcd-ef1234567890',
  lease_epoch: 1,
  lease_until: '2026-08-24T15:00:00.123456+00:00',
  attempt_count: 1,
  max_attempts: 3,
  input_payload: { source: 'console.log(42)', parameters: {} },
})

ComputeJobSchema.parse({
  account_id: '01917b12-3a5c-7d9e-bf33-9118c7e7b801',
  job_id: JOB_ID,
  workflow_id: '01917b12-3a5c-7d9e-bf33-9118c7e7b800',
  profile: 'PROFILE_A_WASI',
  claim_token: 'a1b2c3d4-e5f6-4890-abcd-ef1234567890',
  lease_epoch: 1,
  lease_until: '2026-08-24T15:00:00.000Z',
  attempt_count: 1,
  max_attempts: 3,
  input_payload: { source: 'console.log(42)', parameters: {} },
})

ArtifactManifestSchema.parse({
  job_id: JOB_ID,
  status: 'COMPLETED',
  exit_code: 0,
  execution_time_ms: 10,
  stdout_sanitized: '42',
  stderr_sanitized: '',
  artifacts: [],
  provenance: { engine_version: 'deno-2.9.5-profile-a' },
})

VisionEventSchema.parse({
  event_id: '01917b12-3a5c-7d9e-bf33-9118c7e7b8c2',
  account_id: '01917b12-3a5c-7d9e-bf33-9118c7e7b801',
  device_id: 'cam-service-bay-02',
  timestamp: '2026-08-24T14:58:40.120Z',
  event_type: 'BAY_VEHICLE_ENTERED',
  precision_score: 0.96,
  bounding_box: { x: 120, y: 340, width: 800, height: 450 },
  untrusted_attributes: { license_plate_raw: '01A777AA', vehicle_color: 'white' },
})

assert.throws(() => VisionEventSchema.parse({
  event_id: JOB_ID,
  account_id: '01917b12-3a5c-7d9e-bf33-9118c7e7b801',
  device_id: 'cam-1',
  timestamp: '2026-08-24T14:58:40.120Z',
  event_type: 'IGNORE_PREVIOUS_INSTRUCTIONS',
  precision_score: 1.2,
  untrusted_attributes: {},
}))

console.log('ADR 002 Stage 1A sandbox behavior passed: isolation, limits, redaction, and contracts.')
