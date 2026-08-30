const SECRET_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi
const AUTHORIZATION = /\b(Authorization\s*[:=]\s*)(?:Bearer\s+)?[^\s,;}]+/gi

/** Redact secrets from one complete log line. */
export function redactLogLine(value) {
  return String(value ?? '')
    .replace(SECRET_ASSIGNMENT, '$1=[REDACTED]')
    .replace(AUTHORIZATION, '$1[REDACTED]')
    .replace(/\b(?:Bearer\s+)?(?:sk-(?:or-v1-|ant-)?|gh[pousr]_|github_pat_|xox[baprs]-|sb_secret_)[A-Za-z0-9_.-]{10,}/gi, '[TOKEN REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[JWT REDACTED]')
    .replace(/\b((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+):[^\s@/]+@/gi, '$1:[PASSWORD REDACTED]@')
}

/**
 * Stateful sanitizer for stdout/stderr chunks. PEM bodies are suppressed even when split across
 * chunks, and incomplete final lines are kept until flush().
 */
export function createLogSanitizer(onText) {
  let pending = ''
  let insidePrivateKey = false

  function emitLine(line, newline) {
    if (/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/.test(line)) {
      insidePrivateKey = true
      onText(`[PRIVATE KEY REDACTED]${newline}`)
      return
    }
    if (insidePrivateKey) {
      if (/-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/.test(line)) insidePrivateKey = false
      return
    }
    onText(`${redactLogLine(line)}${newline}`)
  }

  return {
    write(chunk) {
      pending += String(chunk ?? '')
      const lines = pending.split(/(\r?\n)/)
      pending = lines.pop() ?? ''
      for (let index = 0; index < lines.length; index += 2) {
        emitLine(lines[index] ?? '', lines[index + 1] ?? '')
      }
    },
    flush() {
      if (pending) emitLine(pending, '')
      pending = ''
      insidePrivateKey = false
    },
  }
}
