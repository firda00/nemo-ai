import { supabase as documentSupabase } from '../document-harness/mock-supabase'
import { subscribeAuth } from './mock-auth'
export { isSupabaseEnabled, getAccessToken } from '../document-harness/mock-supabase'

// Every outbound function is still mocked. Only cli-chat gets frontier response fixtures.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any
g.__frontierCalls = []
g.__frontierMode = 'ok'
g.__frontierPending = {}

export const supabase = {
  ...documentSupabase,
  auth: { ...documentSupabase.auth, onAuthStateChange: subscribeAuth },
  functions: {
    async invoke(name: string, options: Record<string, unknown>) {
      if (name !== 'cli-chat') return documentSupabase.functions.invoke(name, options)
      const body = options.body as Record<string, unknown>
      const id = g.__frontierCalls.length + 1
      const signal = options.signal as AbortSignal | undefined
      const call = { id, name, body: JSON.parse(JSON.stringify(body)), aborted: !!signal?.aborted }
      g.__frontierCalls.push(call)
      signal?.addEventListener('abort', () => { call.aborted = true })
      const reply = (text = `MOCK-REPLY-${id}`) => ({ data: body.selection ? {
        ok: true,
        model: (body.selection as { model: string }).model,
        message: { content: text, tool_calls: [] },
        frontier: { selection: body.selection, status: 'completed', continuation: `MOCK_CONTINUATION_${id}` },
      } : { message: { content: text } }, error: null })
      if (g.__frontierMode === 'hold') {
        // Deliberately ignore AbortSignal so a late actual resolution tests the UI fence.
        return new Promise(resolve => { g.__frontierPending[id] = (text?: string) => resolve(reply(text)) })
      }
      if (g.__frontierMode === 'missing') return { data: null, error: { context: Response.json({ ok: false, code: 'NEED_KEY' }, { status: 503 }) } }
      if (g.__frontierMode === 'invalid-continuation') return { data: null, error: { context: Response.json({ ok: false, code: 'INVALID_CONTINUATION' }, { status: 400 }) } }
      if (g.__frontierMode === 'context-limit') return { data: null, error: { context: Response.json({ ok: false, code: 'CONTEXT_LIMIT' }, { status: 400 }) } }
      return reply()
    },
  },
}
