import { describe, expect, test } from 'vitest'
import { loadDialogueRows, updateDialogueState, withDialogueSession, type DialogueSessionOptions } from '../src/lib/dialogueSession'

const agentId = '10000000-0000-4000-8000-000000000001'
const dialogueId = '20000000-0000-4000-8000-000000000002'
function fixture() {
  let listener: ((event: string, session: { user: { id: string }; access_token: string } | null) => void) | undefined
  const session = { user: { id: 'user-a' }, access_token: 'jwt-a' }
  const controller = new AbortController()
  const requests: Array<{ url: URL; authorization: string; method: string; body?: unknown }> = []
  let responder = async (url: URL, method: string): Promise<Response> => new Response(JSON.stringify(
    url.pathname.endsWith('/users') ? [{ account_id: 'account-a' }] : url.pathname.endsWith('/agents') ? [{ id: agentId, name: 'Agent' }] :
      url.pathname.endsWith('/dialogues') ? [{ id: dialogueId, agent_id: agentId, ...(method === 'PATCH' ? { status: 'resolved', operator_takeover: false } : {}) }] :
        [{ id: 'new', dialogue_id: dialogueId }, { id: 'old', dialogue_id: dialogueId }]), { status: 200 })
  const client = { auth: { getSession: async () => ({ data: { session } }), onAuthStateChange: (callback: typeof listener) => { listener = callback; return { data: { subscription: { unsubscribe: () => { listener = undefined } } } } } } }
  const options: DialogueSessionOptions = { userId: 'user-a', alive: () => true, signal: controller.signal, timeoutMs: 1000,
    connection: { url: 'https://synthetic.invalid', anonKey: 'public-synthetic' },
    fetch: (async (input, init) => {
      const url = new URL(String(input)), method = init?.method ?? 'GET'
      requests.push({ url, method, authorization: (init?.headers as Record<string, string>).Authorization, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
      return responder(url, method)
    }) as typeof fetch }
  return { client, options, requests, session, controller, respond: (next: typeof responder) => { responder = next }, auth: (id: string | null) => listener?.(id ? 'SIGNED_IN' : 'SIGNED_OUT', id ? { user: { id }, access_token: `jwt-${id}` } : null) }
}

describe('dialogue session boundary', () => {
  test('profile, agents, dialogue ids and message ids are scoped; chronological history and one pinned JWT', async () => {
    const f = fixture()
    const result = await withDialogueSession(f.client, f.options, async scope => { f.session.access_token = 'jwt-replacement'; return loadDialogueRows(scope) })
    expect(f.requests.map(request => request.authorization)).toEqual(['Bearer jwt-a', 'Bearer jwt-a', 'Bearer jwt-a', 'Bearer jwt-a'])
    expect(f.requests[0].url.searchParams.get('id')).toBe('eq.user-a')
    expect(f.requests[1].url.searchParams.get('account_id')).toBe('eq.account-a')
    expect(f.requests[2].url.searchParams.get('agent_id')).toBe(`in.(${agentId})`)
    expect(f.requests[3].url.searchParams.get('dialogue_id')).toBe(`in.(${dialogueId})`)
    expect(result.messages.map(row => row.id)).toEqual(['old', 'new'])
  })

  test('status update validates ownership then updates exactly the selected agent/dialogue and verifies result', async () => {
    const f = fixture()
    await withDialogueSession(f.client, f.options, scope => updateDialogueState(scope, dialogueId, agentId, { status: 'resolved', operator_takeover: false }))
    expect(f.requests[1].url.searchParams.get('account_id')).toBe('eq.account-a')
    expect(f.requests[2].method).toBe('PATCH')
    expect(f.requests[2].url.searchParams.get('id')).toBe(`eq.${dialogueId}`)
    expect(f.requests[2].url.searchParams.get('agent_id')).toBe(`eq.${agentId}`)
    expect(f.requests[2].body).toEqual({ status: 'resolved', operator_takeover: false })
  })

  test.each([{ rows: null }, { rows: [] }, { rows: [{ account_id: '' }] }, { rows: [{ account_id: 'a' }, { account_id: 'b' }] }])('unavailable/malformed profile blocks tenant work: %j', async ({ rows }) => {
    const f = fixture(); f.respond(async () => new Response(JSON.stringify(rows)))
    await expect(withDialogueSession(f.client, f.options, loadDialogueRows)).rejects.toThrow()
    expect(f.requests).toHaveLength(1)
  })

  test('foreign/missing selected agent never reaches a PATCH', async () => {
    const f = fixture(); f.respond(async url => new Response(JSON.stringify(url.pathname.endsWith('/users') ? [{ account_id: 'account-a' }] : [{ id: 'different-agent' }])))
    await expect(withDialogueSession(f.client, f.options, scope => updateDialogueState(scope, dialogueId, agentId, { status: 'resolved', operator_takeover: false }))).rejects.toThrow('DIALOGUE_UNAVAILABLE')
    expect(f.requests.every(request => request.method === 'GET')).toBe(true)
  })

  test.each([{ rows: [] }, { rows: [{ id: dialogueId, status: 'open', operator_takeover: true }] }])('unconfirmed write response cannot become UI success', async ({ rows }) => {
    const f = fixture(); f.respond(async (url, method) => new Response(JSON.stringify(url.pathname.endsWith('/users') ? [{ account_id: 'account-a' }] : method === 'PATCH' ? rows : [{ id: agentId }])))
    await expect(withDialogueSession(f.client, f.options, scope => updateDialogueState(scope, dialogueId, agentId, { status: 'resolved', operator_takeover: false }))).rejects.toThrow('UPDATE_UNCONFIRMED')
  })

  test('logout after a held profile cannot start a later tenant query', async () => {
    const f = fixture(); let resolve!: (response: Response) => void
    f.respond(() => new Promise(done => { resolve = done }))
    const pending = withDialogueSession(f.client, f.options, loadDialogueRows)
    await Promise.resolve(); await Promise.resolve()
    f.auth(null)
    await expect(pending).rejects.toThrow()
    resolve(new Response(JSON.stringify([{ account_id: 'account-a' }])))
    await Promise.resolve(); await Promise.resolve()
    expect(f.requests).toHaveLength(1)
  })

  test('identity change while ownership check is held prevents a queued update', async () => {
    const f = fixture(); let resolve!: (response: Response) => void
    f.respond(async url => url.pathname.endsWith('/users') ? new Response(JSON.stringify([{ account_id: 'account-a' }])) : new Promise(done => { resolve = done }))
    const pending = withDialogueSession(f.client, f.options, scope => updateDialogueState(scope, dialogueId, agentId, { status: 'resolved', operator_takeover: false }))
    while (!resolve) await new Promise(done => setTimeout(done, 0))
    f.auth('user-b'); await expect(pending).rejects.toThrow()
    resolve(new Response(JSON.stringify([{ id: agentId }]))); await Promise.resolve(); await Promise.resolve()
    expect(f.requests.every(request => request.method === 'GET')).toBe(true)
  })

  test('deadline bounds stalled session, transport and response body', async () => {
    for (const stage of ['session', 'fetch', 'body']) {
      const f = fixture(); f.options.timeoutMs = 10
      if (stage === 'session') f.client.auth.getSession = () => new Promise(() => {})
      else if (stage === 'fetch') f.respond(() => new Promise(() => {}))
      else f.respond(async () => ({ ok: true, text: () => new Promise(() => {}) }) as Response)
      await expect(withDialogueSession(f.client, f.options, loadDialogueRows)).rejects.toThrow('REQUEST_INTERRUPTED')
    }
  })

  test('missing identity/unmounted view fails before reading session or transport', async () => {
    const f = fixture(); f.options.alive = () => false
    await expect(withDialogueSession(f.client, f.options, loadDialogueRows)).rejects.toThrow('SESSION_SCOPE_LOST')
    expect(f.requests).toHaveLength(0)
  })
})
