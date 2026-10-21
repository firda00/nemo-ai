import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('model gateway absolute budget', () => {
  beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); vi.stubGlobal('Deno', { env: { get: () => undefined } }) })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
  const opts = { apiKey: 'synthetic-only', model: 'synthetic/selected', messages: [{ role: 'user' as const, content: 'hello' }], fallbackModel: 'synthetic/free' }
  const result = () => Response.json({ choices: [{ message: { content: 'done' } }], usage: { total_tokens: 3 } })

  it('aborts a hung provider after one total budget, without trying more models', async () => {
    let signal: AbortSignal | undefined
    const fetch = vi.fn((_url, init) => { signal = init.signal; return new Promise<Response>(() => {}) })
    vi.stubGlobal('fetch', fetch)
    const { callOpenRouter } = await import('../supabase/functions/_shared/llm')
    const outcome = callOpenRouter(opts).catch(e => e.message)
    await vi.advanceTimersByTimeAsync(45_001)
    expect(await outcome).toBe('MODEL_TIMEOUT')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(signal?.aborted).toBe(true)
  })

  it('bounds stalled body reads and releases the slot', async () => {
    const cancel = vi.fn()
    const fetch = vi.fn().mockResolvedValueOnce(new Response(new ReadableStream({ cancel }))).mockImplementation(async () => result())
    vi.stubGlobal('fetch', fetch)
    const { callOpenRouter } = await import('../supabase/functions/_shared/llm')
    const outcome = callOpenRouter(opts).catch(e => e.message)
    await vi.advanceTimersByTimeAsync(45_001)
    expect(await outcome).toBe('MODEL_TIMEOUT')
    expect(cancel).toHaveBeenCalled()
    expect((await callOpenRouter(opts)).content).toBe('done')
  })

  it('does not multiply transient retries inside each model attempt', async () => {
    const fetch = vi.fn(async () => new Response('', {status:503}))
    vi.stubGlobal('fetch', fetch)
    const { callOpenRouter } = await import('../supabase/functions/_shared/llm')
    const outcome = callOpenRouter(opts).catch(e => e.message)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await outcome).toContain('503')
    expect(fetch).toHaveBeenCalledTimes(6)
  })

  it('expires queued requests without starting them later or leaking slots', async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetch)
    const { callOpenRouter } = await import('../supabase/functions/_shared/llm')
    const pending = Array.from({length:9}, () => callOpenRouter(opts).catch(e => e.message))
    await vi.advanceTimersByTimeAsync(45_001)
    expect(await Promise.all(pending)).toEqual(Array(9).fill('MODEL_TIMEOUT'))
    expect(fetch).toHaveBeenCalledTimes(6)
    fetch.mockImplementation(async () => result())
    expect((await Promise.all(Array.from({length:6}, () => callOpenRouter(opts)))).every(x=>x.content==='done')).toBe(true)
  })

  it('refuses oversized provider bodies before allocation', async () => {
    const fetch = vi.fn(async () => new Response('', {headers:{'content-length':String(3*1024*1024)}}))
    vi.stubGlobal('fetch', fetch)
    const { callOpenRouter } = await import('../supabase/functions/_shared/llm')
    await expect(callOpenRouter({...opts,model:'openai/gpt-4o-mini',fallbackModel:undefined})).rejects.toThrow('INVALID_PROVIDER_RESPONSE')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
