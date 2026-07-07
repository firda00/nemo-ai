// SSRF egress guard for server-side fetches of user-supplied URLs.
// Blocks loopback / link-local (incl. cloud metadata) / private / reserved
// destinations, re-validates every redirect hop (so a public host cannot 30x
// into an internal IP), caps the response size while streaming, and enforces a
// request timeout. Used by fetch-url (KB ingest) and crm-push (CRM webhook).

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const octet of parts) {
    const v = Number(octet)
    if (!Number.isInteger(v) || v < 0 || v > 255) return null
    n = (n << 8) | v
  }
  return n >>> 0
}

function inCidr(n: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base)
  if (b === null) return false
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (n & mask) === (b & mask)
}

function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  if (n === null) return true // unparseable -> treat as unsafe
  return (
    inCidr(n, '0.0.0.0', 8) ||       // "this" network
    inCidr(n, '10.0.0.0', 8) ||      // private
    inCidr(n, '100.64.0.0', 10) ||   // CGNAT
    inCidr(n, '127.0.0.0', 8) ||     // loopback
    inCidr(n, '169.254.0.0', 16) ||  // link-local + cloud metadata (169.254.169.254)
    inCidr(n, '172.16.0.0', 12) ||   // private
    inCidr(n, '192.0.0.0', 24) ||    // IETF protocol assignments
    inCidr(n, '192.0.2.0', 24) ||    // TEST-NET-1
    inCidr(n, '192.168.0.0', 16) ||  // private
    inCidr(n, '198.18.0.0', 15) ||   // benchmarking
    inCidr(n, '198.51.100.0', 24) || // TEST-NET-2
    inCidr(n, '203.0.113.0', 24) ||  // TEST-NET-3
    inCidr(n, '224.0.0.0', 4) ||     // multicast
    inCidr(n, '240.0.0.0', 4)        // reserved
  )
}

function isPrivateV6(ipRaw: string): boolean {
  const ip = ipRaw.toLowerCase().replace(/^\[|\]$/g, '')
  if (ip === '::1' || ip === '::' || ip === '0:0:0:0:0:0:0:1') return true
  if (ip.startsWith('fe80') || ip.startsWith('fc') || ip.startsWith('fd')) return true // link-local + ULA
  const mapped = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/) // IPv4-mapped ::ffff:a.b.c.d
  if (mapped) return isPrivateV4(mapped[1])
  return false
}

function ipLiteralKind(host: string): 'v4' | 'v6' | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'v4'
  if (host.includes(':')) return 'v6'
  return null
}

function hostIsBlocked(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (h === 'metadata' || h === 'metadata.google.internal') return true
  const kind = ipLiteralKind(h)
  if (kind === 'v4') return isPrivateV4(h)
  if (kind === 'v6') return isPrivateV6(h)
  return false
}

// Resolve the hostname and reject if ANY resolved address is private. If DNS
// resolution is unavailable in the runtime, fall back to the literal/host checks
// plus per-hop redirect re-validation (safeFetch below).
async function resolvedIpsBlocked(host: string): Promise<boolean> {
  if (ipLiteralKind(host)) return false // already checked as a literal
  try {
    const ips: string[] = []
    try { ips.push(...(await Deno.resolveDns(host, 'A'))) } catch { /* no A record */ }
    try { ips.push(...(await Deno.resolveDns(host, 'AAAA'))) } catch { /* no AAAA record */ }
    if (ips.length === 0) return false
    return ips.some((ip) => (ip.includes(':') ? isPrivateV6(ip) : isPrivateV4(ip)))
  } catch {
    return false
  }
}

export async function assertSafeUrl(raw: string, opts: { httpsOnly?: boolean } = {}): Promise<URL> {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error('invalid_url')
  }
  if (opts.httpsOnly ? u.protocol !== 'https:' : u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('invalid_protocol')
  }
  if (hostIsBlocked(u.hostname)) throw new Error('blocked_host')
  if (await resolvedIpsBlocked(u.hostname)) throw new Error('blocked_host')
  return u
}

export interface SafeFetchOpts {
  httpsOnly?: boolean
  maxBytes?: number
  timeoutMs?: number
  maxRedirects?: number
}

// SSRF-safe fetch: validates the target (and every redirect hop) against the
// egress blocklist, times out, and caps the amount of body read into memory.
export async function safeFetch(
  raw: string,
  init: RequestInit = {},
  opts: SafeFetchOpts = {},
): Promise<{ res: Response; body: string }> {
  const maxBytes = opts.maxBytes ?? 300_000
  const timeoutMs = opts.timeoutMs ?? 10_000
  const maxRedirects = opts.maxRedirects ?? 4

  let current = await assertSafeUrl(raw, opts)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    let res: Response
    let hops = 0
    // Follow redirects manually so each Location is re-validated (DNS-rebinding /
    // public->internal redirect protection).
    for (;;) {
      res = await fetch(current.toString(), { ...init, redirect: 'manual', signal: ctrl.signal })
      const loc = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && loc) {
        if (hops++ >= maxRedirects) throw new Error('too_many_redirects')
        current = await assertSafeUrl(new URL(loc, current).toString(), opts)
        continue
      }
      break
    }

    const contentLength = Number(res.headers.get('content-length') ?? '0')
    if (contentLength && contentLength > maxBytes) throw new Error('too_large')

    const reader = res.body?.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.length) {
          chunks.push(value)
          received += value.length
          if (received >= maxBytes) {
            await reader.cancel()
            break
          }
        }
      }
    }
    const merged = new Uint8Array(received)
    let off = 0
    for (const c of chunks) {
      merged.set(c, off)
      off += c.length
    }
    return { res, body: new TextDecoder().decode(merged) }
  } finally {
    clearTimeout(timer)
  }
}
