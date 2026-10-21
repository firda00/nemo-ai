import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { transform } from 'esbuild'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ScopedComputeApiTransport } from '../agent-hub/compute/scoped-client'
import { SupabaseDocumentComputeClient } from '../agent-hub/workers/document-worker'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const WORKFLOW = '22222222-2222-4222-8222-222222222222'
const DOCUMENT_TOKEN = 'document-worker-synthetic-token-for-tests-only'
const MEDIA_TOKEN = 'media-worker-synthetic-token-for-tests-only'
let source: string

beforeAll(async () => {
  const original = readFileSync(new URL('../supabase/functions/compute-worker-api/index.ts', import.meta.url), 'utf8')
  // Only the SDK import is replaced; the real Edge handler/auth/allowlists run below.
  const withoutSdk = original.replace(/^import \{ createClient \} from '[^']+'\s*\r?\n/, '')
  expect(withoutSdk).not.toBe(original)
  source = (await transform(withoutSdk, { loader: 'ts', target: 'es2022' })).code
})

function edge() {
  const rpc = vi.fn(async (name: string) => ({
    data: name === 'document_finalize_workflow'
      ? { ok: true, status: 'completed', already: false }
      : [{ account_id: ACCOUNT, workflow_id: WORKFLOW }],
    error: null,
  }))
  let handler!: (request: Request) => Promise<Response>
  const values: Record<string, string> = {
    SUPABASE_URL: 'https://database.example.test', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-server-role',
    NEMO_DOCUMENT_WORKER_TOKEN: DOCUMENT_TOKEN, NEMO_MEDIA_WORKER_TOKEN: MEDIA_TOKEN,
  }
  vm.runInNewContext(source, {
    TextEncoder, TextDecoder, Uint8Array, crypto: globalThis.crypto, Response,
    createClient: () => ({ rpc }),
    Deno: { env: { get: (name: string) => values[name] }, serve: (callback: typeof handler) => { handler = callback } },
  })
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)))
  return { rpc, fetch }
}

describe('actual document client through scoped transport and Edge auth', () => {
  it('finalizes and recovers document workflows through the actual HTTP allowlist', async () => {
    const mock = edge()
    const client = new SupabaseDocumentComputeClient(new ScopedComputeApiTransport('https://example.test/functions/v1/compute-worker-api', DOCUMENT_TOKEN, mock.fetch))
    expect(await client.finalizeWorkflow(ACCOUNT, WORKFLOW)).toEqual({ kind: 'finalized', status: 'completed', already: false })
    expect(await client.listUnfinalized(25)).toEqual([{ account_id: ACCOUNT, workflow_id: WORKFLOW }])
    expect(mock.rpc.mock.calls).toEqual([
      ['document_finalize_workflow', { p_account_id: ACCOUNT, p_workflow_id: WORKFLOW }],
      ['document_list_unfinalized', { p_limit: 25 }],
    ])
    expect(mock.fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps the document lifecycle denied to a media token at the real Edge boundary', async () => {
    const mock = edge()
    const client = new SupabaseDocumentComputeClient(new ScopedComputeApiTransport('https://example.test/compute', MEDIA_TOKEN, mock.fetch))
    await expect(client.finalizeWorkflow(ACCOUNT, WORKFLOW)).rejects.toThrow('DOCUMENT_FINALIZE_FAILED:COMPUTE_RPC_DENIED')
    await expect(client.listUnfinalized(1)).rejects.toThrow('DOCUMENT_SWEEP_FAILED:COMPUTE_RPC_DENIED')
    expect(mock.rpc).not.toHaveBeenCalled()
    expect(mock.fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['document_finalize_workflow', { p_account_id: ACCOUNT, p_workflow_id: 'not-uuid' }],
    ['document_finalize_workflow', { p_account_id: 'other', p_workflow_id: WORKFLOW }],
    ['document_finalize_workflow', { p_account_id: ACCOUNT, p_workflow_id: WORKFLOW, ignore_lease: true }],
    ['document_list_unfinalized', { p_limit: 26 }],
    ['document_list_unfinalized', { p_limit: 0 }],
    ['document_list_unfinalized', { p_limit: 1.5 }],
    ['document_list_unfinalized', { p_limit: 2, p_account_id: ACCOUNT }],
  ])('rejects malformed %s arguments before HTTP', async (name, args) => {
    const fetch = vi.fn()
    const transport = new ScopedComputeApiTransport('https://example.test/compute', DOCUMENT_TOKEN, fetch)
    expect(await transport.rpc(String(name), args as Record<string, unknown>)).toEqual({ data: null, error: { code: 'COMPUTE_RPC_ARGUMENTS_INVALID' } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps arbitrary RPCs inaccessible', async () => {
    const fetch = vi.fn()
    const transport = new ScopedComputeApiTransport('https://example.test/compute', DOCUMENT_TOKEN, fetch)
    expect(await transport.rpc('document_register_artifact', { p_account_id: ACCOUNT })).toEqual({ data: null, error: { code: 'COMPUTE_RPC_DENIED' } })
    expect(fetch).not.toHaveBeenCalled()
  })
})
