// Scenario-driven mock of src/lib/supabase for the MOUNTED document-card smoke. Both edge
// calls the REAL card makes go through here: cli-chat (the generation step, answering with
// the STRUCTURED JSON contract) and document-jobs (enqueue/status/download). Every call is
// recorded in globalThis.__docCalls so the smoke can assert request-id reuse, absence of
// enqueue after scope loss, and the repeat-vs-fresh distinction. No network, no live model.
interface Scenario {
  kind?: 'docx_document' | 'pptx_presentation' | 'typst_document'
  generate?: 'content' | 'needs_data' | 'fail' | 'hang'
  generateText?: string
  generateResponse?: unknown
  enqueue?: 'ok' | 'quota' | 'lost_response'
  session?: 'hang'
  status?: 'completed' | 'processing_then_completed' | 'failed' | 'processing_forever'
  download?: 'ok' | 'unregistered'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any
g.__docCalls = g.__docCalls ?? []
g.__docSeenRequestIds = g.__docSeenRequestIds ?? []
// Simulated server state survives a real page.reload; production storage is not involved.
const acceptedKey = 'nemo.test.accepted-document-requests'
g.__docStatusPolls = 0

const scenario = (): Scenario => (g.__doc ?? {}) as Scenario
const JOB = 'cd55c5de-5555-4555-8555-5555555def55'
const SHA = 'a'.repeat(64)
function artifactFor(kind: string) {
  const [name, mime_type] = kind === 'typst_document' ? ['document.pdf', 'application/pdf']
    : kind === 'pptx_presentation' ? ['slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']
      : ['document.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
  return { name, mime_type, size_bytes: 2048, sha256: SHA }
}

const refusal = (status: number, body: unknown) => ({
  data: null,
  error: { context: new Response(JSON.stringify(body), { status }) },
})

export const isSupabaseEnabled = true

// other desk children import this too; the harness has no gateway session
export async function getAccessToken(): Promise<string | null> {
  return null
}

// inert surfaces for OTHER consumers that get this alias when the whole SmartTaskDesk is
// bundled (useAgentStore etc.): auth answers "no session", tables answer empty — nothing
// here may throw at import or on incidental calls
function emptyChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'neq', 'order', 'limit', 'in', 'not', 'insert', 'update', 'delete', 'upsert']) {
    chain[method] = () => chain
  }
  chain.maybeSingle = async () => ({ data: null, error: null })
  chain.single = async () => ({ data: null, error: null })
  chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(resolve, reject)
  return chain
}

export const supabase = {
  auth: {
    getSession: async () => {
      const result = () => ({ data: { session: g.__docAuth?.user ? { user: g.__docAuth.user, access_token: `test-session-${g.__docAuth.user.id}` } : null }, error: null })
      if (scenario().session === 'hang') return new Promise((resolve) => { g.__docReleaseSession = () => resolve(result()) })
      return result()
    },
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
  },
  from: () => emptyChain(),
  channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
  removeChannel: () => {},
  functions: {
    async invoke(name: string, options: Record<string, unknown>) {
      const body = (options.body ?? {}) as Record<string, unknown>
      const s = scenario()
      const kind = s.kind ?? g.__docJobKind ?? 'docx_document'
      const artifact = artifactFor(kind)
      if (name === 'cli-chat') {
        g.__docCalls.push({ name, body, authorization: (options.headers as Record<string, string>)?.Authorization })
        if (s.generate === 'hang') {
          // controllable deferred: the smoke RELEASES it after the identity switch to prove
          // the late response is fenced (no store, no enqueue) — a never-resolving promise
          // could not prove that
          return new Promise((resolve) => {
            g.__docReleaseGenerate = () => resolve({
              data: { message: { content: JSON.stringify({ type: 'content', text: 'Поздний текст, который не должен никуда попасть.' }) } },
              error: null,
            })
          })
        }
        if (s.generate === 'fail') return refusal(502, { error: 'boom' })
        const payload = s.generateResponse ?? (s.generate === 'needs_data'
          ? { type: 'needs_data', missing: 'выручка за месяц' }
          : { type: 'content', text: s.generateText ?? 'Сгенерированный текст документа. Абзац достаточной длины для модели содержимого.' })
        return { data: { message: { content: JSON.stringify(payload) } }, error: null }
      }
      // document-jobs
      const action = body.action
      g.__docCalls.push({ name, action, request_id: body.request_id, job_id: body.job_id, input: body.input, authorization: (options.headers as Record<string, string>)?.Authorization })
      if (action === 'enqueue') {
        g.__docJobKind = body.kind
        if (s.enqueue === 'quota') return refusal(429, { ok: false, error: 'quota_exceeded' })
        const accepted = JSON.parse(sessionStorage.getItem(acceptedKey) ?? '{}') as Record<string, string>
        const key = `${g.__docAuth.user?.id}:${body.request_id}`
        const payload = JSON.stringify({ kind: body.kind, input: body.input })
        const seen = key in accepted
        if (seen && accepted[key] !== payload) return refusal(409, { ok: false, error: 'idempotency_conflict' })
        accepted[key] = payload
        sessionStorage.setItem(acceptedKey, JSON.stringify(accepted))
        g.__docCalls[g.__docCalls.length - 1].deduplicated = seen
        if (!seen) g.__docSeenRequestIds.push(body.request_id)
        if (s.enqueue === 'lost_response') throw new Error('Simulated lost response after acceptance')
        return { data: { ok: true, job_id: JOB, workflow_id: JOB, deduplicated: seen }, error: null }
      }
      if (action === 'status') {
        g.__docStatusPolls += 1
        const mode = s.status ?? 'completed'
        const processing = { ok: true, status: 'processing', error_code: null, kind, artifact: null }
        if (mode === 'processing_forever') return { data: processing, error: null }
        if (mode === 'failed') return { data: { ok: true, status: 'failed', error_code: 'DOCUMENT_MANIFEST_INVALID', kind, artifact: null }, error: null }
        if (mode === 'processing_then_completed' && g.__docStatusPolls < 3) return { data: processing, error: null }
        return { data: { ok: true, status: 'completed', error_code: null, kind, artifact }, error: null }
      }
      if (action === 'download') {
        if (s.download === 'unregistered') return refusal(409, { ok: false, error: 'artifact_unregistered' })
        return { data: { ok: true, url: `https://signed.example/${artifact.name}`, expires_in: 300, ...artifact }, error: null }
      }
      return refusal(400, { ok: false, error: 'unknown_action' })
    },
  },
}
