// Streamed, capped body reads shared by wrappers (margin-report, cli-chat).
// Refuses an oversized body WHILE it arrives instead of allocating it first, and shares the
// request's ONE absolute deadline instead of granting the sender a budget of its own.
// Structurally typed so tests drive it with fakes.
const DEADLINE_ERR = 'BOUNDED_BODY_TIMEOUT'

export async function readBytesBounded(
  req: { headers: { get: (name: string) => string | null }; body: ReadableStream<Uint8Array> | null },
  options: { maxBytes: number; deadlineAt: number; now?: () => number },
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: 'too_large' | 'read_failed' | 'timeout' }> {
  const nowMs = options.now ?? (() => Date.now())
  const declared = Number(req.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    // refuse on metadata alone — but still release the unread stream, NON-blocking: a caller
    // whose cancel never settles must not be able to hold this refusal hostage
    void req.body?.cancel().catch(() => {})
    return { ok: false, reason: 'too_large' }
  }
  const body = req.body
  if (!body) return { ok: true, bytes: new Uint8Array(0) }
  let expire: (error: Error) => void = () => {}
  const expired = new Promise<never>((_resolve, reject) => { expire = reject })
  expired.catch(() => {})
  const timer = setTimeout(() => expire(new Error(DEADLINE_ERR)), Math.max(0, options.deadlineAt - nowMs()))
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      if (nowMs() >= options.deadlineAt) { void reader.cancel().catch(() => {}); return { ok: false, reason: 'timeout' } }
      const { done, value } = await Promise.race([reader.read(), expired])
      if (done) break
      total += value.byteLength
      if (total > options.maxBytes) { void reader.cancel().catch(() => {}); return { ok: false, reason: 'too_large' } }
      chunks.push(value)
    }
  } catch (error) {
    void reader.cancel().catch(() => {})
    const timedOut = error instanceof Error && error.message === DEADLINE_ERR
    return { ok: false, reason: timedOut ? 'timeout' : 'read_failed' }
  } finally {
    clearTimeout(timer)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
  return { ok: true, bytes: merged }
}
