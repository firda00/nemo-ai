// The margin-upload pipeline as a pure, injected unit: read → hash → parse → compute, EVERY
// phase raced against ONE shared deadline. A stalled file read or hash resolves to a timeout
// within the bound (never a forever-busy UI), an expired budget never starts the next phase,
// and a late completion of an abandoned phase cannot continue the pipeline — the race already
// returned, so no further phase can run.
import { computeProductMargin, type MarginReport } from './productMargin'
import { type XlsxParseResult } from './xlsxIngest'

export interface MarginPipelineDeps {
  readBuffer: () => Promise<ArrayBuffer>
  hash: (buffer: ArrayBuffer) => Promise<string>
  parse: (buffer: ArrayBuffer, timeoutMs: number) => Promise<XlsxParseResult>
}

export type MarginPipelineResult =
  | { ok: true; report: MarginReport }
  | { ok: false; reason: string; detail?: string }

const TIMEOUT: MarginPipelineResult = { ok: false, reason: 'parse_timeout' }

export async function runMarginPipeline(
  deps: MarginPipelineDeps,
  // currency null = adopt the file's own declared currency or come back with needs_currency —
  // the chat card asks the user instead of guessing
  options: { currency: string | null; fileName: string; deadlineMs?: number },
): Promise<MarginPipelineResult> {
  const deadlineMs = Number.isInteger(options.deadlineMs) && options.deadlineMs! > 0 ? Math.min(options.deadlineMs!, 60_000) : 25_000
  const deadlineAt = Date.now() + deadlineMs
  let expiredFlag = false
  let expire: (error: Error) => void = () => {}
  const expired = new Promise<never>((_resolve, reject) => { expire = reject })
  expired.catch(() => {})
  const timer = setTimeout(() => { expiredFlag = true; expire(new Error('MARGIN_DEADLINE')) }, deadlineMs)
  // the timer flag alone is not enough: a phase that busy-loops past the deadline resolves its
  // microtask BEFORE the timer macrotask runs — the CLOCK is the authority, the flag a shortcut
  const outOfBudget = () => expiredFlag || Date.now() >= deadlineAt
  try {
    const buffer = await Promise.race([deps.readBuffer(), expired])
    if (outOfBudget()) return TIMEOUT
    const fileSha256 = await Promise.race([deps.hash(buffer), expired])
    if (outOfBudget()) return TIMEOUT
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) return TIMEOUT // never start the worker on an exhausted budget
    const parsed = await Promise.race([deps.parse(buffer, remaining), expired])
    if (!parsed.ok) return { ok: false, reason: parsed.reason, detail: parsed.detail }
    // the deadline gates STARTING the synchronous compute; compute itself is not preemptible —
    // its real bound is the parser's row caps, and no hard deadline is claimed over it
    if (outOfBudget()) return TIMEOUT
    const result = computeProductMargin(parsed, { currency: options.currency, fileName: options.fileName, fileSha256 })
    if (!result.ok) return { ok: false, reason: result.reason, detail: 'detail' in result ? result.detail : undefined }
    return { ok: true, report: result }
  } catch (error) {
    return error instanceof Error && error.message === 'MARGIN_DEADLINE' ? TIMEOUT : { ok: false, reason: 'bad_archive' }
  } finally {
    clearTimeout(timer)
  }
}
