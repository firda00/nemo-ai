// Pure lead-patch sanitization shared by the runtime (agent.ts) and the
// offline behavior gate (agent-hub/lead-merge-behavior.mjs). No I/O here.
//
// Reserved keys are operational CRM-push state: agent-configured lead-form
// field labels are user-controlled and flow into the LLM allowlist, so a field
// named "crm_pushed" must never overwrite the push guard, and prototype names
// must never reach a JS object key.
const RESERVED_LEAD_KEYS = new Set(['crm_pushed', 'crm_push_claimed_at', 'crm_push_claim', '__proto__', 'prototype', 'constructor'])

export const MAX_LEAD_KEYS = 12
export const MAX_LEAD_VALUE_CHARS = 300

// Allowed extraction keys = core contact fields + the agent's own configured
// lead-form fields (so a custom field like "course" is actually captured),
// minus reserved/dangerous names, capped at MAX_LEAD_KEYS.
export function buildLeadKeys(wantFields: string[] = []): string[] {
  const wanted = wantFields
    .map((f) => String(f).trim())
    .filter((f) => f && !RESERVED_LEAD_KEYS.has(f.toLowerCase()))
  return [...new Set(['name', 'phone', 'email', 'request', 'budget', ...wanted])].slice(0, MAX_LEAD_KEYS)
}

// Strict-JSON patch cleanup: keep only allowed keys with real values, coerce to
// bounded strings, and validate contact fields — never persist a non-numeric
// "phone" or malformed "email" as fact (e.g. the model echoing "тот же номер").
export function sanitizeLeadPatch(raw: unknown, keys: string[]): Record<string, string> {
  const clean: Record<string, string> = {}
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  for (const k of keys) {
    if (RESERVED_LEAD_KEYS.has(String(k).toLowerCase())) continue
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue
    const v = obj[k]
    if (v == null) continue
    const s = String(v).trim()
    if (!s || s.toLowerCase() === 'null') continue
    clean[k] = s.slice(0, MAX_LEAD_VALUE_CHARS)
  }
  if (clean.phone && clean.phone.replace(/\D/g, '').length < 6) delete clean.phone
  if (clean.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean.email)) delete clean.email
  return clean
}
