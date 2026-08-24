import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ArtifactManifest, ComputeJob } from '../agent-hub/contracts/sandbox.ts'
import {
  assertPathInside, buildFfmpegArgs, deriveFfprobePath, MediaJobPayloadSchema,
  MediaPipelineError, runFfmpegPipeline,
} from '../agent-hub/media/ffmpeg-pipeline.ts'
import { probeCapabilities } from '../agent-hub/media/ffmpeg-engine.ts'
import { makeSolidPng } from '../agent-hub/media/test-fixtures.mjs'
import {
  processMediaJob, validateStorageUrl, type MediaComputeClient,
} from '../agent-hub/workers/media-worker.ts'

const ACCOUNT_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7b801'
const JOB_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7b803'
const WORKFLOW_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7b800'
const root = path.resolve(import.meta.dirname, '..')
const ffmpegPath = process.env.FFMPEG_PATH ?? path.join(
  root, 'render-worker', 'node_modules', '@remotion', 'compositor-win32-x64-msvc',
  process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
)
const ffprobePath = process.env.FFPROBE_PATH ?? deriveFfprobePath(ffmpegPath)
const capabilities = await probeCapabilities(ffmpegPath)
assert.deepEqual(capabilities.missingRequired, [])

const png = makeSolidPng(320, 180, [20, 110, 220])
const pngHash = createHash('sha256').update(png).digest('hex')
const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()
const payload = MediaJobPayloadSchema.parse({
  kind: 'ffmpeg_assembly',
  output_name: 'stage2.mp4',
  output: {
    storage_path: `tenants/${ACCOUNT_ID}/artifacts/2026/08/24/stage2.mp4`,
    upload_url: 'https://storage.example.test/upload/stage2',
    expires_at: expiresAt,
  },
  assets: [{
    id: 'scene1', download_url: 'https://storage.example.test/download/scene1',
    mime_type: 'image/png', size_bytes: png.byteLength, sha256: pngHash,
  }],
  clips: [{ asset_id: 'scene1', duration_seconds: 0.6 }],
  width: 320, height: 180, fps: 10, video_bitrate_kbps: 300,
  max_output_bytes: 2 * 1024 * 1024, codec: 'h264', seed: 23,
})

const directDirectory = await mkdtemp(path.join(tmpdir(), 'nemo-media-pipeline-test-'))
try {
  const source = path.join(directDirectory, 'scene1.png')
  const output = path.join(directDirectory, 'stage2.mp4')
  await writeFile(source, png)
  const inputs = { assets: new Map([['scene1', source]]), subtitlesPath: null, outputPath: output, workDirectory: directDirectory }
  const plan = buildFfmpegArgs(payload, inputs, capabilities)
  assert.ok(plan.args.includes('-max_alloc'))
  assert.equal(plan.args[plan.args.indexOf('-r') + 1], '10')
  assert.equal(plan.args[plan.args.indexOf('-b:v') + 1], '300k')
  assert.equal(plan.args[plan.args.indexOf('-maxrate') + 1], '300k')
  // FFmpeg filter graphs legitimately contain semicolons and pipes. Shell
  // expansion markers and command separators via line breaks must never occur.
  assert.equal(plan.args.some((arg) => /[`\r\n]|\$\(/.test(arg)), false)

  const rendered = await runFfmpegPipeline({ payload, inputs, capabilities, ffmpegPath, ffprobePath })
  assert.ok(rendered.bytes.byteLength > 1_000)
  assert.equal(rendered.probe.width, 320)
  assert.equal(rendered.probe.height, 180)
  assert.ok(rendered.probe.fps <= 10.01)
  assert.ok(rendered.durationSeconds > 0 && rendered.durationSeconds <= 0.85)

  assert.throws(() => assertPathInside(directDirectory, path.join(directDirectory, '..', 'escape.mp4')), /escapes/)
  assert.throws(() => MediaJobPayloadSchema.parse({ ...payload, width: 1920, height: 1920 }), /1080p/)
  assert.throws(() => MediaJobPayloadSchema.parse({ ...payload, fps: 61 }), /less than or equal to 60/i)
  assert.throws(() => MediaJobPayloadSchema.parse({ ...payload, video_bitrate_kbps: 12_001 }), /less than or equal to 12000/i)

  const timeoutOutput = path.join(directDirectory, 'timeout.mp4')
  await assert.rejects(
    runFfmpegPipeline({ payload, inputs: { ...inputs, outputPath: timeoutOutput }, capabilities, ffmpegPath, ffprobePath, timeoutMs: 10 }),
    (error: unknown) => error instanceof MediaPipelineError && error.code === 'MEDIA_TIMEOUT',
  )
} finally {
  await rm(directDirectory, { recursive: true, force: true })
}

const publicResolver = async () => [{ address: '203.0.113.10' }]
await validateStorageUrl('https://storage.example.test/object', new Set(['storage.example.test']), publicResolver)
await assert.rejects(
  validateStorageUrl('https://storage.example.test/object', new Set(['storage.example.test']), async () => [{ address: '127.0.0.1' }]),
  /STORAGE_ADDRESS_DENIED/,
)
await assert.rejects(
  validateStorageUrl('https://evil.example.test/object', new Set(['storage.example.test']), publicResolver),
  /STORAGE_HOST_DENIED/,
)

const finished: Array<{ status: string; manifest: ArtifactManifest | null; errorCode: string | null }> = []
const compute: MediaComputeClient = {
  async claim() { return [] },
  async finish(_job, status, manifest, errorCode) { finished.push({ status, manifest, errorCode }) },
}
let uploaded = new Uint8Array()
const fetchImpl: typeof fetch = async (input, init) => {
  const url = String(input)
  if (url.includes('/download/')) {
    return new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.byteLength) } })
  }
  if (url.includes('/upload/') && init?.method === 'PUT') {
    uploaded = new Uint8Array(await new Response(init.body).arrayBuffer())
    return new Response(null, { status: 200 })
  }
  return new Response(null, { status: 404 })
}
const job: ComputeJob = {
  account_id: ACCOUNT_ID, job_id: JOB_ID, workflow_id: WORKFLOW_ID, profile: 'PROFILE_C_BROWSER',
  claim_token: randomUUID(), lease_epoch: 1, lease_until: new Date(Date.now() + 180_000).toISOString(),
  attempt_count: 1, max_attempts: 3, input_payload: payload,
}
const workerRoot = await mkdtemp(path.join(tmpdir(), 'nemo-media-worker-test-'))
try {
  assert.equal(await processMediaJob(job, {
    compute, capabilities, ffmpegPath, ffprobePath,
    storageHosts: new Set(['storage.example.test']), resolver: publicResolver,
    fetchImpl, workRoot: workerRoot,
  }), 'completed')
} finally {
  await rm(workerRoot, { recursive: true, force: true })
}
assert.equal(finished.length, 1)
assert.equal(finished[0].status, 'completed')
assert.equal(finished[0].errorCode, null)
const artifact = finished[0].manifest?.artifacts[0]
assert.ok(artifact)
assert.equal(artifact.mime_type, 'video/mp4')
assert.equal(artifact.size_bytes, uploaded.byteLength)
assert.equal(artifact.sha256, createHash('sha256').update(uploaded).digest('hex'))
assert.ok((artifact.duration_seconds ?? 0) > 0)
assert.equal(finished[0].manifest?.provenance.seed, 23)

const compose = readFileSync(path.join(root, 'docker-compose.yml'), 'utf8')
assert.match(compose, /compute-media-worker:[\s\S]*mem_limit:\s*1g/)
assert.match(compose, /compute-media-worker:[\s\S]*pids_limit:\s*64/)
assert.match(compose, /compute-media-worker:[\s\S]*read_only:\s*true/)
assert.match(compose, /\/tmp\/nemo-media:rw,noexec,nosuid,nodev,size=805306368/)

console.log('ADR 002 Stage 2 media worker passed: render, ffprobe policy, timeout, traversal, SSRF, upload, and manifest.')
