import { afterEach, describe, expect, test, vi } from 'vitest'
import { buildFrontierRequest, callFrontierProvider, FRONTIER_MAX_OUTPUT_TOKENS, parseFrontierInput,
  parseFrontierResponse, prepareFrontierState, type FrontierInput, type FrontierState } from '../supabase/functions/_shared/frontierChat'
import { handleFrontierChat, type FrontierHandlerDeps } from '../supabase/functions/_shared/frontierChatHandler'
import { isFrontierSelection, type FrontierSelection } from '../supabase/functions/_shared/frontierModels'
import { sealSecret } from '../supabase/functions/_shared/secretBox'

const astra: FrontierSelection = { provider: 'openai', model: 'gpt-6-astra', effort: 'low' }
const fable: FrontierSelection = { provider: 'anthropic', model: 'claude-fable-5-1', effort: 'medium' }
const identity = { accountId: 'tenant-a', userId: 'user-a' }
const fn = { type: 'function' as const, function: { name: 'calculate', description: 'Calculate a number', parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } } }
const input = (selection = astra, options: Partial<FrontierInput> = {}): FrontierInput => ({ selection,
  messages: [{ role: 'system', content: 'Be concise.' }, { role: 'user', content: 'Calculate.' }], tools: [], ...options })
const stateOf = (selection = astra, tools: FrontierInput['tools'] = []): FrontierState => {
  const result = prepareFrontierState(input(selection, { tools }), undefined, Date.now())
  if (!result.ok) throw new Error(result.code)
  return result.state
}
const astraPayload = (output: unknown[] = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }]) => ({
  model: astra.model, status: 'completed', output, usage: { input_tokens: 30, output_tokens: 20 },
})
const fablePayload = (content: unknown[] = [{ type: 'text', text: 'Done.' }], stop_reason = 'end_turn') => ({
  model: fable.model, stop_reason, content, usage: { input_tokens: 30, output_tokens: 20 },
})
const calls: Array<{ url: string; body: Record<string, unknown> }> = []
const events: string[] = []
const replies: unknown[] = []
test('missing local encryption is a service error even when resuming a context', async () => {
  const fake = deps()
  fake.seal = async () => { throw new Error('Synthetic encryption unavailable') }
  const opened = vi.fn(async () => { throw new Error('Should not decrypt') })
  fake.open = opened
  const result = await handleFrontierChat(input(astra, {continuation:'enc:v2:synthetic:context',messages:[{role:'user',content:'Continue'}]}),identity,fake)
  expect(result.body).toEqual({ok:false,code:'CONTINUATION_UNAVAILABLE'})
  expect(opened).not.toHaveBeenCalled()
  expect(calls).toHaveLength(0)
})
function deps(options: { missing?: boolean; vaultFailure?: boolean } = {}): FrontierHandlerDeps {
  // Synthetic encryption key only. This process never reads local env files or makes a
  // network call. Real AES-GCM verifies user/tenant/model/effort binding in these tests.
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'))
  return { admin: { from(table: string) {
    events.push(table)
    const query = { select() { return query }, eq(field: string, value: string) { events.push(`${field}:${value}`); return query },
      maybeSingle: async () => ({ data: options.missing ? null : { api_key: 'synthetic-provider-key-never-sent' }, error: options.vaultFailure ? { code: 'offline' } : null }) }
    return query
  }, rpc() { throw new Error('BYO must not debit platform credits') } }, fetchImpl: (async (url, init) => {
    events.push('fetch')
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify(replies.shift() ?? astraPayload()), { status: 200 })
  }) as typeof fetch }
}
afterEach(() => { vi.unstubAllEnvs(); calls.length = 0; events.length = 0; replies.length = 0 })

describe('exact model and capability boundary', () => {
  test('exact native IDs require matching provider and supported effort', () => {
    expect(isFrontierSelection(astra)).toBe(true)
    expect(isFrontierSelection(fable)).toBe(true)
    for (const bad of [{ ...astra, model: 'openai/gpt-6-astra' }, { ...astra, provider: 'anthropic' }, { ...astra, effort: 'none' }, { ...astra, fallbacks: true }]) {
      expect(parseFrontierInput(input(bad as FrontierSelection))).toEqual({ ok: false, code: 'INVALID_MODEL' })
    }
  })
  test('unknown fields, native tools, video and remote images fail before key lookup', async () => {
    const cases = [
      { ...input(), temperature: 0.5 }, { ...input(), tools: [{ type: 'web_search' }] },
      { ...input(), messages: [{ role: 'user', content: [{ type: 'video_url', video_url: { url: 'https://example.com/a.mp4' } }] }] },
      { ...input(), messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }] },
    ]
    const fake = deps()
    for (const value of cases) expect((await handleFrontierChat(value, identity, fake)).status).toBe(400)
    expect(events).toEqual([])
  })
  test('inline vision translates into native input structures', () => {
    for (const selection of [astra, fable]) {
      const value = input(selection, { messages: [{ role: 'user', content: [{ type: 'text', text: 'Read image' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }] })
      expect(parseFrontierInput(value).ok).toBe(true)
      const prepared = prepareFrontierState(value, undefined, Date.now())
      if (!prepared.ok) throw new Error(prepared.code)
      const wire = buildFrontierRequest(prepared.state, 'synthetic')
      expect(JSON.stringify(wire.body)).toContain(selection.provider === 'openai' ? 'input_image' : 'media_type')
      expect(wire.body).not.toHaveProperty('temperature')
      expect(wire.body).not.toHaveProperty('thinking')
      expect(wire.body).not.toHaveProperty('fallbacks')
    }
  })
})

describe('native round trips and opaque continuation', () => {
  test('Astra Responses preserves encrypted reasoning and parallel function IDs exactly', async () => {
    const native = [
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque-astra-reasoning' },
      { type: 'function_call', id: 'fc_1', call_id: 'call_a', name: 'calculate', arguments: '{"n":1}', status: 'completed' },
      { type: 'function_call', id: 'fc_2', call_id: 'call_b', name: 'calculate', arguments: '{"n":2}', status: 'completed' },
    ]
    replies.push(astraPayload(native), astraPayload())
    const fake = deps()
    const first = await handleFrontierChat(input(astra, { tools: [fn] }), identity, fake)
    expect(first.status).toBe(200)
    if (!first.body.ok) throw new Error(first.body.code)
    expect(first.body.frontier.status).toBe('tool_calls')
    expect(first.body.frontier.continuation).toMatch(/^enc:v2:/)
    expect(JSON.stringify(first.body)).not.toContain('opaque-astra-reasoning')
    const second = await handleFrontierChat(input(astra, { tools: [fn], continuation: first.body.frontier.continuation,
      messages: [{ role: 'tool', tool_call_id: 'call_b', content: '2' }, { role: 'tool', tool_call_id: 'call_a', content: '1' }] }), identity, fake)
    expect(second.status).toBe(200)
    expect(calls.map(call => call.url)).toEqual(['https://api.openai.com/v1/responses', 'https://api.openai.com/v1/responses'])
    expect(calls[0].body).toMatchObject({ model: astra.model, store: false, include: ['reasoning.encrypted_content'], reasoning: { effort: 'low' }, max_output_tokens: FRONTIER_MAX_OUTPUT_TOKENS })
    expect((calls[1].body.input as unknown[]).slice(1, 4)).toEqual(native)
    expect((calls[1].body.input as unknown[]).slice(-2)).toEqual([
      { type: 'function_call_output', call_id: 'call_b', output: '2' }, { type: 'function_call_output', call_id: 'call_a', output: '1' },
    ])
  })
  test('Fable preserves every native thinking/signature block and groups all tool results', async () => {
    const blocks = [
      { type: 'thinking', thinking: '', signature: 'opaque-fable-signature' },
      { type: 'redacted_thinking', data: 'redacted-provider-blob' },
      { type: 'tool_use', id: 'toolu_a', name: 'calculate', input: { n: 1 } },
      { type: 'tool_use', id: 'toolu_b', name: 'calculate', input: { n: 2 } },
    ]
    replies.push(fablePayload(blocks, 'tool_use'), fablePayload())
    const fake = deps()
    const first = await handleFrontierChat(input(fable, { tools: [fn] }), identity, fake)
    expect(first.status).toBe(200)
    if (!first.body.ok) throw new Error(first.body.code)
    expect(JSON.stringify(first.body)).not.toContain('opaque-fable-signature')
    const second = await handleFrontierChat(input(fable, { tools: [fn], continuation: first.body.frontier.continuation,
      messages: [{ role: 'tool', tool_call_id: 'toolu_a', content: '1' }, { role: 'tool', tool_call_id: 'toolu_b', content: '2' }] }), identity, fake)
    expect(second.status).toBe(200)
    expect(calls.map(call => call.url)).toEqual(['https://api.anthropic.com/v1/messages', 'https://api.anthropic.com/v1/messages'])
    expect(calls[0].body).toMatchObject({ model: fable.model, output_config: { effort: 'medium' }, tool_choice: { type: 'auto' } })
    const messages = calls[1].body.messages as unknown[]
    expect(messages[1]).toEqual({ role: 'assistant', content: blocks })
    expect(messages[2]).toEqual({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_a', content: '1' }, { type: 'tool_result', tool_use_id: 'toolu_b', content: '2' },
    ] })
  })
  test('finished conversations append user turns without rebuilding the history', async () => {
    replies.push(fablePayload(), fablePayload())
    const fake = deps()
    const first = await handleFrontierChat(input(fable), identity, fake)
    if (!first.body.ok) throw new Error(first.body.code)
    const second = await handleFrontierChat(input(fable, { continuation: first.body.frontier.continuation, messages: [{ role: 'user', content: 'Continue.' }] }), identity, fake)
    expect(second.status).toBe(200)
    expect((calls[1].body.messages as unknown[]).slice(0, 1)).toEqual(calls[0].body.messages)
    expect((calls[1].body.messages as unknown[]).at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] })
  })
  test('tenant/user/model/effort changes and ciphertext tampering fail before vault reads', async () => {
    const fake = deps()
    const first = await handleFrontierChat(input(), identity, fake)
    if (!first.body.ok) throw new Error(first.body.code)
    const continuation = first.body.frontier.continuation
    events.length = 0
    const value = input(astra, { continuation, messages: [{ role: 'user', content: 'Continue.' }] })
    const cases = [
      await handleFrontierChat(value, { ...identity, accountId: 'tenant-b' }, fake),
      await handleFrontierChat(value, { ...identity, userId: 'user-b' }, fake),
      await handleFrontierChat({ ...value, selection: fable }, identity, fake),
      await handleFrontierChat({ ...value, selection: { ...astra, effort: 'high' } }, identity, fake),
      await handleFrontierChat({ ...value, continuation: continuation.slice(0, -10) + 'corruption' }, identity, fake),
      await handleFrontierChat({ ...value, continuation: JSON.stringify(stateOf()) }, identity, fake),
    ]
    for (const result of cases) expect(result.body).toEqual({ ok: false, code: 'INVALID_CONTINUATION' })
    expect(events).toEqual([])
  })
  test('missing, duplicated and invented tool results cannot resume pending work', async () => {
    replies.push(astraPayload([{ type: 'function_call', call_id: 'call_a', name: 'calculate', arguments: '{"n":1}' }]))
    const fake = deps()
    const first = await handleFrontierChat(input(astra, { tools: [fn] }), identity, fake)
    if (!first.body.ok) throw new Error(first.body.code)
    events.length = 0
    for (const messages of [
      [{ role: 'user', content: 'Skip the tool' }],
      [{ role: 'tool', tool_call_id: 'not_pending', content: '1' }],
      [{ role: 'tool', tool_call_id: 'call_a', content: '1' }, { role: 'tool', tool_call_id: 'call_a', content: '1' }],
    ]) {
      const result = await handleFrontierChat({ ...input(astra, { tools: [fn], continuation: first.body.frontier.continuation }), messages }, identity, fake)
      expect(result.body).toEqual({ ok: false, code: 'INVALID_TOOL_RESULTS' })
    }
    const changedTools = await handleFrontierChat(input(astra, { tools: [], continuation: first.body.frontier.continuation,
      messages: [{ role: 'tool', tool_call_id: 'call_a', content: '1' }] }), identity, fake)
    expect(changedTools.body).toEqual({ ok: false, code: 'INVALID_CONTINUATION' })
    expect(events).toEqual([])
  })
  test('expired or full continuations reject without paid work', () => {
    const previous = { ...stateOf(), turns: 1, expiresAt: 1 }
    expect(prepareFrontierState(input(astra, { continuation: 'enc:v2:example' }), previous, 2)).toEqual({ ok: false, code: 'INVALID_CONTINUATION' })
    expect(prepareFrontierState(input(astra, { continuation: 'enc:v2:example' }), { ...previous, expiresAt: 999, turns: 40 }, 2)).toEqual({ ok: false, code: 'CONTEXT_LIMIT' })
  })
})

describe('failure handling, cost boundary and deadlines', () => {
  test('missing key, vault outage and unavailable continuation protection never fall back', async () => {
    expect((await handleFrontierChat(input(), identity, deps({ missing: true }))).body).toEqual({ ok: false, code: 'NEED_KEY' })
    expect((await handleFrontierChat(input(), identity, deps({ vaultFailure: true }))).body).toEqual({ ok: false, code: 'KEY_UNAVAILABLE' })
    events.length = 0
    const noSeal = { ...deps(), seal: async () => { throw new Error('not configured') } }
    expect((await handleFrontierChat(input(), identity, noSeal)).body).toEqual({ ok: false, code: 'CONTINUATION_UNAVAILABLE' })
    expect(events).toEqual([])
    expect(calls).toEqual([])
  })
  test('refusal and exhausted output cannot masquerade as completed answers', () => {
    expect(parseFrontierResponse(stateOf(fable), { ...fablePayload(), stop_reason: 'refusal', stop_details: { category: 'generic' } })).toMatchObject({ ok: false, code: 'PROVIDER_REFUSAL' })
    expect(parseFrontierResponse(stateOf(fable), { ...fablePayload(), stop_reason: 'max_tokens' })).toMatchObject({ ok: false, code: 'OUTPUT_INCOMPLETE' })
    expect(parseFrontierResponse(stateOf(fable), { ...fablePayload(), stop_reason: 'pause_turn' })).toMatchObject({ ok: false, code: 'OUTPUT_INCOMPLETE' })
    expect(parseFrontierResponse(stateOf(), { ...astraPayload(), status: 'incomplete' })).toMatchObject({ ok: false, code: 'OUTPUT_INCOMPLETE' })
    expect(parseFrontierResponse(stateOf(), astraPayload([{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }] }]))).toMatchObject({ ok: false, code: 'PROVIDER_REFUSAL' })
  })
  test('wrong actual model, malformed arguments, unknown tools and invalid usage fail closed', () => {
    const state = stateOf(astra, [fn])
    for (const payload of [
      { ...astraPayload(), model: 'gpt-4o-mini' }, { ...astraPayload(), usage: {} },
      { ...astraPayload(), usage: { input_tokens: 1, output_tokens: FRONTIER_MAX_OUTPUT_TOKENS + 1 } },
      astraPayload([{ type: 'function_call', call_id: 'call_a', name: 'not_allowed', arguments: '{}' }]),
      astraPayload([{ type: 'function_call', call_id: 'call_a', name: 'calculate', arguments: 'oops' }]),
      astraPayload([{ type: 'reasoning', summary: [] }]),
    ]) expect(parseFrontierResponse(state, payload)).toMatchObject({ ok: false, code: 'INVALID_PROVIDER_RESPONSE' })
  })
  test('Fable cache reads/writes are included in total input usage', () => {
    const result = parseFrontierResponse(stateOf(fable), { ...fablePayload(), usage: { input_tokens: 30, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 40 } })
    expect(result).toMatchObject({ ok: true, usage: { prompt_tokens: 170, total_tokens: 190, payer: 'tenant_provider' } })
  })
  test('429, HTML, byte overflow and stalled bodies make only one provider attempt', async () => {
    const responses = [new Response('secret-looking body not forwarded', { status: 429 }), new Response('<html>'),
      new Response('x'.repeat(1_000_001)), new Response(new ReadableStream({ start() {} }))]
    const expected = ['RATE_LIMITED', 'INVALID_PROVIDER_RESPONSE', 'INVALID_PROVIDER_RESPONSE', 'PROVIDER_UNAVAILABLE']
    for (const [index, response] of responses.entries()) {
      let count = 0
      const result = await callFrontierProvider(stateOf(), 'synthetic', { fetchImpl: (async () => { count++; return response }) as typeof fetch, deadlineAt: Date.now() + 35 })
      expect(result).toEqual({ ok: false, code: expected[index] })
      expect(count).toBe(1)
    }
  })
  test('absolute deadline and cancellation bound even an uncooperative transport', async () => {
    const controller = new AbortController()
    const pending = callFrontierProvider(stateOf(), 'synthetic', { fetchImpl: (() => new Promise(() => {})) as typeof fetch,
      deadlineAt: Date.now() + 300, signal: controller.signal })
    controller.abort()
    expect(await pending).toEqual({ ok: false, code: 'PROVIDER_UNAVAILABLE' })
    const fake = { ...deps(), fetchImpl: (() => new Promise(() => {})) as typeof fetch }
    expect((await handleFrontierChat(input(), identity, fake, { deadlineAt: Date.now() + 30 })).body).toEqual({ ok: false, code: 'PROVIDER_UNAVAILABLE' })
  })
  test('credential ciphertext cannot be substituted for a chat continuation', async () => {
    const fake = deps()
    const ciphertext = await sealSecret('synthetic-provider-key', 'provider-key:tenant-a:openai')
    const result = await handleFrontierChat(input(astra, { continuation: ciphertext, messages: [{ role: 'user', content: 'Continue' }] }), identity, fake)
    expect(result.body).toEqual({ ok: false, code: 'INVALID_CONTINUATION' })
    expect(events).toEqual([])
  })
  test('a vault result arriving after cancellation cannot start a paid request', async () => {
    const fake = deps()
    let started: () => void = () => {}
    const reading = new Promise<void>(resolve => { started = resolve })
    let release: (value: unknown) => void = () => {}
    fake.admin = { from() {
      const query = { select: () => query, eq: () => query, maybeSingle: () => { started(); return new Promise(resolve => { release = resolve }) } }
      return query
    } }
    const controller = new AbortController()
    const pending = handleFrontierChat(input(), identity, fake, { signal: controller.signal })
    await reading
    controller.abort()
    expect((await pending).body).toEqual({ ok: false, code: 'PROVIDER_UNAVAILABLE' })
    release({ data: { api_key: 'synthetic-late' }, error: null })
    await Promise.resolve()
    expect(calls).toEqual([])
  })
})
