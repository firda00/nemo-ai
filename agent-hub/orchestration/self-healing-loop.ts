import { createHash, randomUUID } from 'node:crypto'
import type { ArtifactManifest } from '../contracts/sandbox.ts'
import {
  runWasiSandbox,
  sanitizeSandboxOutput,
  type WasiRunnerRequest,
  type WasiRunnerResult,
} from '../sandbox/wasi-runner.ts'

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_SOURCE_BYTES = 48 * 1024
const MAX_ERROR_BYTES = 12 * 1024

export interface SelfHealingTaskContext {
  source: string
  parameters?: Record<string, unknown>
  jobId?: string
}

export interface CorrectionRequest {
  attempt: number
  profile: 'PROFILE_A_WASI'
  source: string
  sanitizedError: string
  errorCode: string
  prompt: string
}

export type SelfHealingCorrector = (request: Readonly<CorrectionRequest>) => Promise<string>
export type SelfHealingRunner = (request: WasiRunnerRequest) => Promise<WasiRunnerResult>

export interface SelfHealingOptions {
  /** Maximum total executions, including the initial attempt. */
  maxRetries?: number
  timeoutMs?: number
  profile?: 'PROFILE_A_WASI'
  corrector?: SelfHealingCorrector
  runner?: SelfHealingRunner
  parseOutput?: (stdout: string) => unknown
}

export interface SelfHealingIteration {
  attempt: number
  source: string
  sourceHash: string
  status: 'completed' | 'failed'
  exitCode: number
  errorCode: string | null
  stdoutSanitized: string
  stderrSanitized: string
  correctionPrompt?: string
  correctedSource?: string
  correctedSourceHash?: string
}

export interface SelfHealingResult {
  status: 'completed'
  output: unknown
  source: string
  attempts: number
  manifest: ArtifactManifest
  history: SelfHealingIteration[]
}

export class SelfHealingExhaustedError extends Error {
  readonly code = 'SELF_HEALING_EXHAUSTED'
  readonly history: readonly SelfHealingIteration[]

  constructor(history: readonly SelfHealingIteration[]) {
    super(`Self-healing exhausted after ${history.length} attempt(s)`)
    this.name = 'SelfHealingExhaustedError'
    this.history = Object.freeze(history.map((iteration) => Object.freeze({ ...iteration })))
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function hashSource(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  return bytes.byteLength <= maxBytes ? value : bytes.subarray(0, maxBytes).toString('utf8')
}

function validateSource(source: string): string {
  if (typeof source !== 'string' || source.trim().length === 0 || byteLength(source) > MAX_SOURCE_BYTES) {
    throw new Error('SELF_HEALING_SOURCE_INVALID')
  }
  return source
}

/** Removes secrets first, then host-specific file URIs and absolute Windows/POSIX temp paths. */
export function sanitizeSelfHealingError(raw: string): string {
  const secretSafe = sanitizeSandboxOutput(String(raw ?? ''))
  const pathSafe = secretSafe
    .replace(/file:\/\/(?:\/[A-Za-z]:\/|\/)[^\s)]+/gi, '[HOST_PATH]')
    .replace(/\b[A-Za-z]:[\\/](?:[^\\/\r\n:]+[\\/])*[^\\/\r\n:]*/g, '[HOST_PATH]')
    .replace(/\/(?:home|Users|tmp|private\/tmp|var\/tmp)\/[^\s):]+/g, '[HOST_PATH]')
  return truncateUtf8(pathSafe, MAX_ERROR_BYTES)
}

export function buildCorrectionPrompt(input: {
  attempt: number
  source: string
  sanitizedError: string
  errorCode: string
}): string {
  return JSON.stringify({
    contract: 'nemo-self-healing-correction-v1',
    profile: 'PROFILE_A_WASI',
    failed_attempt: input.attempt,
    constraints: [
      'Return corrected source code only.',
      'Do not add network, filesystem, environment, subprocess, FFI, or system access.',
      'Read inputs only from globalThis.parameters.',
      'Write one JSON-serializable result to stdout.',
    ],
    source: input.source,
    sanitized_error: {
      code: input.errorCode,
      message: input.sanitizedError,
    },
  })
}

function defaultParseOutput(stdout: string): unknown {
  const trimmed = stdout.trim()
  if (!trimmed) throw new Error('SELF_HEALING_OUTPUT_INVALID')
  try {
    return JSON.parse(trimmed)
  } catch {
    throw new Error('SELF_HEALING_OUTPUT_INVALID')
  }
}

function executionFailure(result: WasiRunnerResult): { code: string; message: string; exitCode: number } {
  const exitCode = result.manifest?.exit_code ?? 1
  const code = result.errorCode ?? (exitCode === 0 ? 'SELF_HEALING_OUTPUT_INVALID' : 'SANDBOX_EXECUTION_FAILED')
  const message = result.manifest?.stderr_sanitized || `sandbox exited with code ${exitCode}`
  return { code, message, exitCode }
}

export async function executeWithSelfHealing(
  taskContext: SelfHealingTaskContext,
  options: SelfHealingOptions = {},
): Promise<SelfHealingResult> {
  const profile = options.profile ?? 'PROFILE_A_WASI'
  if (profile !== 'PROFILE_A_WASI') throw new Error('SELF_HEALING_PROFILE_DENIED')
  const maxAttempts = options.maxRetries ?? DEFAULT_MAX_ATTEMPTS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error('SELF_HEALING_RETRY_LIMIT_INVALID')
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    throw new Error('SELF_HEALING_TIMEOUT_INVALID')
  }

  const runner = options.runner ?? runWasiSandbox
  const parseOutput = options.parseOutput ?? defaultParseOutput
  const parameters = taskContext.parameters ?? {}
  let source = validateSource(taskContext.source)
  const jobId = taskContext.jobId ?? randomUUID()
  const history: SelfHealingIteration[] = []

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let result: WasiRunnerResult
    try {
      result = await runner({ jobId, input: { source, parameters }, timeoutMs })
    } catch (error) {
      result = {
        status: 'failed',
        errorCode: 'SANDBOX_EXECUTION_FAILED',
        manifest: {
          job_id: jobId,
          status: 'FAILED',
          exit_code: 1,
          execution_time_ms: 0,
          stdout_sanitized: '',
          stderr_sanitized: error instanceof Error ? error.message : 'sandbox execution failed',
          artifacts: [],
          provenance: { engine_version: 'profile-a-runner-boundary' },
        },
      }
    }

    let output: unknown
    let failure: { code: string; message: string; exitCode: number } | null = null
    if (result.status === 'completed' && result.manifest?.exit_code === 0) {
      try {
        output = parseOutput(result.manifest.stdout_sanitized)
      } catch (error) {
        failure = {
          code: 'SELF_HEALING_OUTPUT_INVALID',
          message: error instanceof Error ? error.message : 'invalid sandbox output',
          exitCode: 0,
        }
      }
    } else {
      failure = executionFailure(result)
    }

    if (!failure && result.manifest) {
      history.push({
        attempt,
        source,
        sourceHash: hashSource(source),
        status: 'completed',
        exitCode: 0,
        errorCode: null,
        stdoutSanitized: result.manifest.stdout_sanitized,
        stderrSanitized: '',
      })
      return {
        status: 'completed',
        output,
        source,
        attempts: attempt,
        manifest: result.manifest,
        history,
      }
    }

    const sanitizedError = sanitizeSelfHealingError(failure?.message ?? 'sandbox execution failed')
    const iteration: SelfHealingIteration = {
      attempt,
      source,
      sourceHash: hashSource(source),
      status: 'failed',
      exitCode: failure?.exitCode ?? 1,
      errorCode: failure?.code ?? 'SANDBOX_EXECUTION_FAILED',
      stdoutSanitized: result.manifest?.stdout_sanitized ?? '',
      stderrSanitized: sanitizedError,
    }
    history.push(iteration)
    if (attempt === maxAttempts || !options.corrector) throw new SelfHealingExhaustedError(history)

    const prompt = buildCorrectionPrompt({
      attempt,
      source,
      sanitizedError,
      errorCode: iteration.errorCode ?? 'SANDBOX_EXECUTION_FAILED',
    })
    const correctedSource = validateSource(await options.corrector(Object.freeze({
      attempt,
      profile,
      source,
      sanitizedError,
      errorCode: iteration.errorCode ?? 'SANDBOX_EXECUTION_FAILED',
      prompt,
    })))
    iteration.correctionPrompt = prompt
    iteration.correctedSource = correctedSource
    iteration.correctedSourceHash = hashSource(correctedSource)
    source = correctedSource
  }

  throw new SelfHealingExhaustedError(history)
}
