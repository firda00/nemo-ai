// Bounded client-side calls for the briefing panel — pure and injected, so the exact waits the
// UI performs are testable offline. Two invariants:
//   • ONE deadline covers the WHOLE function call INCLUDING parsing an error-response body —
//     a hung 4xx body must not hang the panel after the invoke itself "finished";
//   • a hung PostgREST query resolves to an explicit timedOut result (with the signal aborted
//     where the builder supports it), so loading/busy state always releases.
// Timers are cleared in finally; the expired promise carries a catch so an unraced deadline can
// never surface as an unhandled rejection.

const DEFAULT_TIMEOUT_MS = 20_000

export interface ClientDeadline {
  signal: AbortSignal
  expired: Promise<never>
  finish: () => void
}

export function makeClientDeadline(timeoutMs: number): ClientDeadline {
  const controller = new AbortController()
  let expire: (error: Error) => void = () => {}
  const expired = new Promise<never>((_resolve, reject) => { expire = reject })
  expired.catch(() => {})
  const timer = setTimeout(() => { controller.abort(); expire(new Error('client_timeout')) }, timeoutMs)
  return { signal: controller.signal, expired, finish: () => clearTimeout(timer) }
}

/**
 * Invoke an edge function under one deadline, error-body parsing included.
 * reached=false means the request may or may not have arrived (transport error / timeout):
 * for a write that difference is the difference between "failed" and "outcome unknown".
 */
export async function callBoundedFunction(
  invoke: () => PromiseLike<{ data: unknown; error: { context?: Response } | null }>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ ok: boolean; reached: boolean; payload: any }> {
  const deadline = makeClientDeadline(timeoutMs)
  try {
    const { data, error } = await Promise.race([invoke(), deadline.expired])
    if (!error) return { ok: true, reached: true, payload: data }
    const response = error.context
    // the error body stays under the SAME deadline — its stream can hang like any other
    const payload = response ? await Promise.race([response.json().catch(() => null), deadline.expired]) : null
    return { ok: false, reached: payload !== null, payload }
  } catch {
    return { ok: false, reached: false, payload: null }
  } finally {
    deadline.finish()
  }
}

/** Run a PostgREST query under a deadline; a hang becomes an explicit timedOut result. */
export async function queryBounded<T>(
  run: (signal: AbortSignal) => PromiseLike<T>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ timedOut: false; result: T } | { timedOut: true }> {
  const deadline = makeClientDeadline(timeoutMs)
  try {
    const result = await Promise.race([run(deadline.signal), deadline.expired])
    return { timedOut: false, result }
  } catch {
    return { timedOut: true }
  } finally {
    deadline.finish()
  }
}
