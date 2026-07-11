export const REGULATED_CHANNEL_ERROR =
  'live channels are disabled for this safety-beta team until enforced approval, audit, and data-protection controls are enabled'

export function isRegulatedAgent(agent: { risk_tier?: unknown; niche?: unknown } | null | undefined): boolean {
  if (agent?.risk_tier === 'regulated') return true
  return typeof agent?.niche === 'string' && /(?:^|\s)nemo-risk:regulated(?:\s|$)/i.test(agent.niche)
}
