export interface ScopedComputeRpcResult<T> {
  data: T | null
  error: { code?: string; message?: string } | null
}

export interface ScopedComputeRpcTransport {
  rpc<T>(name: string, args: Record<string, unknown>): PromiseLike<ScopedComputeRpcResult<T>>
}

const ALLOWED_RPCS = new Set(['runtime_claim_compute_jobs', 'runtime_finish_compute_job'])

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
