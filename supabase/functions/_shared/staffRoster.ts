// Persisted teams have a six-specialist limit in create_agent_team. The
// architect also requires a planner, an executor, and a dedicated reviewer.
export const MIN_STAFF_SPECIALISTS = 3
export const MAX_STAFF_SPECIALISTS = 6

export function staffCandidates(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value) || value.length < MIN_STAFF_SPECIALISTS || value.length > MAX_STAFF_SPECIALISTS) return null
  // Reject the whole roster: dropping members would change dependency indexes
  // and can silently remove the final reviewer. The caller retries generation.
  if (!value.every((member) => member !== null && typeof member === 'object' && !Array.isArray(member)
    && typeof member.role === 'string' && member.role.trim().length > 0)) return null
  return value as Array<Record<string, unknown>>
}
