export interface ScopedComputeRpcResult<T> {
  data: T | null
  error: { code?: string; message?: string } | null
}

export interface ScopedComputeRpcTransport {
  rpc<T>(name: string, args: Record<string, unknown>): PromiseLike<ScopedComputeRpcResult<T>>
}

const ALLOWED_RPCS = new Set(['runtime_claim_compute_jobs', 'runtime_finish_compute_job', 'document_finalize_workflow', 'document_list_unfinalized'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validDocumentArguments(name: string, args: Record<string, unknown>): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  const keys = Object.keys(args).sort()
  if (name === 'document_finalize_workflow') {
    return keys.join(',') === 'p_account_id,p_workflow_id'
      && typeof args.p_account_id === 'string' && UUID.test(args.p_account_id)
      && typeof args.p_workflow_id === 'string' && UUID.test(args.p_workflow_id)
  }
  if (name === 'document_list_unfinalized') {
    return keys.length === 0 || (keys.length === 1 && keys[0] === 'p_limit'
      && typeof args.p_limit === 'number' && Number.isInteger(args.p_limit) && args.p_limit >= 1 && args.p_limit <= 25)
  }
  return true
}

export class ScopedComputeApiTransport implements ScopedComputeRpcTransport {
  private readonly endpoint: URL
  private readonly token: string
  private readonly fetchImpl: typeof fetch

  constructor(endpoint: string, token: string, fetchImpl: typeof fetch = fetch) {
    this.endpoint = new URL(endpoint)
    if (this.endpoint.protocol !== 'https:' && this.endpoint.hostname !== 'localhost' && this.endpoint.hostname !== '127.0.0.1') {
      throw new Error('COMPUTE_API_HTTPS_REQUIRED')
    }
    if (!token || token.length < 32) throw new Error('COMPUTE_WORKER_TOKEN_INVALID')
    this.token = token
    this.fetchImpl = fetchImpl
  }

  async rpc<T>(name: string, args: Record<string, unknown>): Promise<ScopedComputeRpcResult<T>> {
    if (!ALLOWED_RPCS.has(name)) return { data: null, error: { code: 'COMPUTE_RPC_DENIED' } }
    if (!validDocumentArguments(name, args)) return { data: null, error: { code: 'COMPUTE_RPC_ARGUMENTS_INVALID' } }
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
        body: JSON.stringify({ rpc: name, args }),
      })
      const body = await response.json() as ScopedComputeRpcResult<T>
      if (!response.ok) return { data: null, error: body.error ?? { code: 'COMPUTE_API_FAILED' } }
      return body
    } catch {
      return { data: null, error: { code: 'COMPUTE_API_UNAVAILABLE' } }
    }
  }
}
