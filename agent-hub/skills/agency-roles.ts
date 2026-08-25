import { z } from 'zod'
import { ComputeProfileSchema } from '../contracts/sandbox.ts'

export const AgencyRoleIdSchema = z.enum([
  'MARKETER',
  'FINANCE_ANALYST',
  'LEGAL_AUDITOR',
  'PYTHON_ENGINEER',
  'SUPPORT_OPERATOR',
])

export const AgencyRoleSchema = z.object({
  id: AgencyRoleIdSchema,
  systemPrompt: z.string().min(40).max(4_000),
  allowedComputeProfiles: z.array(ComputeProfileSchema).min(1).max(3).refine(
    (profiles) => new Set(profiles).size === profiles.length,
    'compute profiles must be unique',
  ),
}).strict()

export type AgencyRoleId = z.infer<typeof AgencyRoleIdSchema>
export type AgencyRole = z.infer<typeof AgencyRoleSchema>
export type AgencyComputeProfile = z.infer<typeof ComputeProfileSchema>

function role(input: AgencyRole): AgencyRole {
  const parsed = AgencyRoleSchema.parse(input)
  Object.freeze(parsed.allowedComputeProfiles)
  return Object.freeze(parsed)
}

export const AGENCY_ROLES: Readonly<Record<AgencyRoleId, AgencyRole>> = Object.freeze({
  MARKETER: role({
    id: 'MARKETER',
    systemPrompt: 'Create evidence-grounded marketing plans and artifacts. Never publish, spend money, or contact an audience without the configured approval policy.',
    allowedComputeProfiles: ['PROFILE_B_DOCS', 'PROFILE_C_BROWSER'],
  }),
  FINANCE_ANALYST: role({
    id: 'FINANCE_ANALYST',
    systemPrompt: 'Analyze only supplied financial evidence, preserve calculation provenance, label uncertainty, and require human approval for consequential financial actions.',
    allowedComputeProfiles: ['PROFILE_A_WASI', 'PROFILE_B_DOCS'],
  }),
  LEGAL_AUDITOR: role({
    id: 'LEGAL_AUDITOR',
    systemPrompt: 'Review supplied documents for risks and inconsistencies without claiming legal authority. Produce drafts and findings only; a qualified human makes legal decisions.',
    allowedComputeProfiles: ['PROFILE_B_DOCS'],
  }),
  PYTHON_ENGINEER: role({
    id: 'PYTHON_ENGINEER',
    systemPrompt: 'Produce bounded computation specifications for the network-denied sandbox. Never request host access, secrets, arbitrary processes, or unapproved external side effects.',
    allowedComputeProfiles: ['PROFILE_A_WASI'],
  }),
  SUPPORT_OPERATOR: role({
    id: 'SUPPORT_OPERATOR',
    systemPrompt: 'Resolve support requests from verified tenant context, protect personal data, and escalate uncertainty or consequential actions to a human operator.',
    allowedComputeProfiles: ['PROFILE_A_WASI'],
  }),
})

export function canRoleUseProfile(roleId: AgencyRoleId, profile: AgencyComputeProfile): boolean {
  return AGENCY_ROLES[roleId].allowedComputeProfiles.includes(profile)
}
