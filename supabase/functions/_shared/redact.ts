const SECRET_KEY = /(authorization|api[_-]?key|token|secret|password|passwd|credential|cookie|cvv|cvc|pin)/i

export function redactText(value: unknown): string {
  return String(value ?? '')
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[CARD REDACTED]')
    .replace(/\b(?:Bearer\s+)?(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_.-]{10,}/gi, '[TOKEN REDACTED]')
    .replace(/\b(?:password|passwd|пароль|cvv|cvc|pin|api[_-]?key|token|secret)\s*[:=]\s*[^\s,;}]+/gi, '$1=[REDACTED]')
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]'
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactValue(item, depth + 1)
    }
    return out
  }
  return value
}
