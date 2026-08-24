const ALLOWED_AMO_HOST = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?\.amocrm\.(?:ru|com)$/

export class AmoApiError extends Error {
  readonly code: string
  readonly retryAfterMs: number | null

  constructor(code: string, retryAfterMs: number | null = null) {
    super(code)
    this.name = 'AmoApiError'
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

export interface AmoCredential {
  host: string
  accessToken: string
}

export interface AmoLead {
  id: number
  pipeline_id?: number | null
  status_id?: number | null
  updated_at?: number | null
  custom_fields_values?: unknown
  _embedded?: { contacts?: Array<{ id?: number }> }
}

export interface AmoContact {
  id: number
  name?: string | null
  custom_fields_values?: Array<{
    field_code?: string | null
    values?: Array<{ value?: unknown }>
  }> | null
}

function normalizeHost(raw: string): string {
  const candidate = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '')
  const host = candidate.includes('.') ? candidate : `${candidate}.amocrm.ru`
  if (!ALLOWED_AMO_HOST.test(host)) throw new AmoApiError('AMOCRM_DOMAIN_NOT_ALLOWED')
  return host
}

export function parseAmoCredential(value: string): AmoCredential {
  const separator = value.indexOf('|')
  if (separator <= 0 || separator === value.length - 1) throw new AmoApiError('AMOCRM_CREDENTIAL_INVALID')
  const host = normalizeHost(value.slice(0, separator))
  const accessToken = value.slice(separator + 1).trim()
  if (!accessToken || accessToken.length > 8192) throw new AmoApiError('AMOCRM_CREDENTIAL_INVALID')
  return { host, accessToken }
}

function retryAfterMilliseconds(value: string | null, now = Date.now()): number {
  if (!value) return 1_000
  if (/^\d+$/.test(value.trim())) return Math.min(300_000, Number(value.trim()) * 1_000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(1_000, Math.min(300_000, date - now)) : 1_000
}

export class AmoEnrichmentClient {
  private readonly credential: AmoCredential
  private readonly timeoutMs: number
  private readonly fetcher: typeof fetch
  private readonly jitter: () => number

  constructor(
    credential: AmoCredential,
    options: { timeoutMs?: number; fetcher?: typeof fetch; jitter?: () => number } = {},
  ) {
    this.credential = credential
    this.timeoutMs = options.timeoutMs ?? 8_000
    this.fetcher = options.fetcher ?? fetch
    this.jitter = options.jitter ?? Math.random
  }

  private async get<T>(path: string): Promise<T> {
    if (!/^\/api\/v4\/[a-z_]+\/\d+(?:\?.*)?$/.test(path)) throw new AmoApiError('AMOCRM_PATH_NOT_ALLOWED')
    const url = new URL(`https://${this.credential.host}${path}`)
    if (url.protocol !== 'https:' || !ALLOWED_AMO_HOST.test(url.hostname)) {
      throw new AmoApiError('AMOCRM_DOMAIN_NOT_ALLOWED')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetcher(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.credential.accessToken}`, Accept: 'application/json' },
        redirect: 'manual',
        signal: controller.signal,
      })
      if (response.status >= 300 && response.status < 400) throw new AmoApiError('AMOCRM_REDIRECT_BLOCKED')
      if (response.status === 429) {
        const base = retryAfterMilliseconds(response.headers.get('retry-after'))
        throw new AmoApiError('AMOCRM_RATE_LIMITED', base + Math.floor(this.jitter() * Math.min(1_000, base)))
      }
      if (!response.ok) throw new AmoApiError(`AMOCRM_HTTP_${response.status}`)
      return await response.json() as T
    } catch (error) {
      if (error instanceof AmoApiError) throw error
      if (controller.signal.aborted) throw new AmoApiError('AMOCRM_TIMEOUT')
      throw new AmoApiError('AMOCRM_NETWORK_ERROR')
    } finally {
      clearTimeout(timer)
    }
  }

  getLead(leadId: string): Promise<AmoLead> {
    if (!/^\d+$/.test(leadId)) throw new AmoApiError('AMOCRM_LEAD_ID_INVALID')
    return this.get<AmoLead>(`/api/v4/leads/${leadId}?with=contacts`)
  }

  getContact(contactId: number): Promise<AmoContact> {
    if (!Number.isSafeInteger(contactId) || contactId <= 0) throw new AmoApiError('AMOCRM_CONTACT_ID_INVALID')
    return this.get<AmoContact>(`/api/v4/contacts/${contactId}`)
  }
}
