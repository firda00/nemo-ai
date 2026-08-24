import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ArtifactManifest } from '../contracts/sandbox.ts'
import { ArtifactManifestSchema, WasiExecutionInputSchema } from '../contracts/sandbox.ts'

const MAX_CAPTURE_BYTES = 64 * 1024
const MAX_TIMEOUT_MS = 5_000
const MEMORY_MIB = 64
const RESULT_PREFIX = '__NEMO_RESULT__'

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:sk-or-v1-|sk-)[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_KEY]'],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, 'Bearer [REDACTED_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
  [/(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[^\s,"']{6,}/gi, '$1=[REDACTED]'],
  [/\+?[1-9]\d{7,14}\b/g, '[REDACTED_PHONE]'],
]

export interface WasiRunnerRequest {
  jobId: string
  input: unknown
  timeoutMs?: number
  denoBinary?: string
}

export interface WasiRunnerResult {
  status: 'completed' | 'failed'
  manifest?: ArtifactManifest
  errorCode?: 'SANDBOX_TIMEOUT' | 'SANDBOX_OUTPUT_LIMIT' | 'SANDBOX_EXECUTION_FAILED'
}

function localDenoBinary(): string {
  const executable = process.platform === 'win32' ? 'deno.exe' : 'deno'
  return path.resolve(import.meta.dirname, '..', '..', 'node_modules', 'deno', executable)
}

export function sanitizeSandboxOutput(value: string): string {
  let sanitized = value
  for (const [pattern, replacement] of SECRET_PATTERNS) sanitized = sanitized.replace(pattern, replacement)
  const bytes = Buffer.from(sanitized, 'utf8')
  if (bytes.byteLength <= MAX_CAPTURE_BYTES) return sanitized
  return bytes.subarray(0, MAX_CAPTURE_BYTES).toString('utf8')
}

function wrapperSource(source: string): string {
  return `
const chunks = [];
for await (const chunk of Deno.stdin.readable) chunks.push(chunk);
const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
const input = new Uint8Array(size);
let offset = 0;
for (const chunk of chunks) { input.set(chunk, offset); offset += chunk.byteLength; }
const parameters = JSON.parse(new TextDecoder().decode(input));
Object.freeze(parameters);
globalThis.parameters = parameters;
globalThis.__nemo_result = undefined;
await (async () => {
${source}
})();
if (globalThis.__nemo_result !== undefined) {
  console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify(globalThis.__nemo_result));
}
`
}

async function collectProcess(
  command: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string; reason: 'exit' | 'timeout' | 'output' }> {
  const controller = new AbortController()
  let reason: 'exit' | 'timeout' | 'output' = 'exit'
  let captured = 0
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  const timer = setTimeout(() => { reason = 'timeout'; controller.abort() }, timeoutMs)
  const child = spawn(command, args, {
    env: {},
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: controller.signal,
  })

  const capture = (target: Buffer[]) => (chunk: Buffer) => {
    if (reason !== 'exit') return
    const remaining = MAX_CAPTURE_BYTES - captured
    if (remaining > 0) target.push(chunk.subarray(0, remaining))
    captured += chunk.byteLength
    if (captured > MAX_CAPTURE_BYTES) {
      reason = 'output'
      controller.abort()
    }
  }
  child.stdout.on('data', capture(stdout))
  child.stderr.on('data', capture(stderr))
  child.stdin.end(stdin)

  const code = await new Promise<number>((resolve) => {
    let settled = false
    const finish = (value: number) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    child.on('error', () => finish(1))
    child.on('close', (value) => finish(value ?? 1))
  })
  clearTimeout(timer)
  return {
    code,
    stdout: sanitizeSandboxOutput(Buffer.concat(stdout).toString('utf8')),
    stderr: sanitizeSandboxOutput(Buffer.concat(stderr).toString('utf8')),
    reason,
  }
}

/**
 * Local Stage 1A harness. Deno runs with every host capability denied and an empty environment.
 * Production security still requires the Linux KVM/Firecracker boundary defined by ADR 002.
 */
export async function runWasiSandbox(request: WasiRunnerRequest): Promise<WasiRunnerResult> {
  const input = WasiExecutionInputSchema.parse(request.input)
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(50, request.timeoutMs ?? MAX_TIMEOUT_MS))
  const directory = await mkdtemp(path.join(tmpdir(), 'nemo-wasi-'))
  const entrypoint = path.join(directory, 'job.ts')
  const startedAt = performance.now()
  try {
    await writeFile(entrypoint, wrapperSource(input.source), { encoding: 'utf8', mode: 0o400 })
    const execution = await collectProcess(request.denoBinary ?? localDenoBinary(), [
      'run',
      '--no-prompt',
      '--no-config',
      '--no-lock',
      '--no-remote',
      '--deny-net',
      '--deny-read',
      '--deny-write',
      '--deny-env',
      '--deny-run',
      '--deny-ffi',
      '--deny-sys',
      `--v8-flags=--max-old-space-size=${MEMORY_MIB}`,
      entrypoint,
    ], JSON.stringify(input.parameters), timeoutMs)
    const executionTimeMs = Math.max(0, Math.round(performance.now() - startedAt))
    const manifest = ArtifactManifestSchema.parse({
      job_id: request.jobId,
      status: execution.code === 0 && execution.reason === 'exit' ? 'COMPLETED' : 'FAILED',
      exit_code: execution.reason === 'timeout' ? 124 : execution.reason === 'output' ? 125 : execution.code,
      execution_time_ms: executionTimeMs,
      stdout_sanitized: execution.stdout.replace(new RegExp(`^${RESULT_PREFIX}.*$`, 'gm'), '').trim(),
      stderr_sanitized: execution.stderr,
      artifacts: [],
      provenance: { engine_version: 'deno-2.9.5-profile-a' },
    })
    if (execution.reason === 'timeout') return { status: 'failed', manifest, errorCode: 'SANDBOX_TIMEOUT' }
    if (execution.reason === 'output') return { status: 'failed', manifest, errorCode: 'SANDBOX_OUTPUT_LIMIT' }
    if (execution.code !== 0) return { status: 'failed', manifest, errorCode: 'SANDBOX_EXECUTION_FAILED' }
    return { status: 'completed', manifest }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
