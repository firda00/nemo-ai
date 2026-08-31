const SECRET_KEY = /(authorization|api[_-]?key|token|secret|password|passwd|credential|cookie|cvv|cvc|pin)/i

export function redactText(value: unknown): string {
  return String(value ?? '')
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, '[PRIVATE KEY REDACTED]')
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[CARD REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL REDACTED]')
    .replace(/(?<!\w)(?:\+?\d[\s().-]*){9,15}(?!\w)/g, '[PHONE REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[JWT REDACTED]')
    .replace(/\b(?:Bearer\s+)?(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|sb_secret_)[A-Za-z0-9_.-]{10,}/gi, '[TOKEN REDACTED]')
    .replace(/\b(password|passwd|пароль|cvv|cvc|pin|api[_-]?key|token|secret|private[_-]?key|credential)\s*[:=]\s*[^\s,;}]+/gi, '$1=[REDACTED]')
    .replace(/\b((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+):[^\s@/]+@/gi, '$1:[PASSWORD REDACTED]@')
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
