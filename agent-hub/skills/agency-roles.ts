import { z } from 'zod'
import { ComputeProfileSchema } from '../contracts/sandbox.ts'

export const AgencyDepartmentSchema = z.enum([
  'ENGINEERING', 'MARKETING', 'LEGAL', 'FINANCE', 'MEDIA_PRODUCTION', 'CUSTOMER_SUPPORT',
  'QUALITY_ASSURANCE', 'STRATEGY', 'SALES', 'OPERATIONS', 'PRODUCT', 'DATA_AI',
  'SECURITY', 'PEOPLE', 'RESEARCH', 'LOCALIZATION',
])
export type AgencyDepartment = z.infer<typeof AgencyDepartmentSchema>

const TITLES: Record<AgencyDepartment, readonly string[]> = {
  ENGINEERING: ['Python Engineer', 'Backend Engineer', 'Frontend Engineer', 'Platform Engineer', 'TypeScript Engineer', 'Database Engineer', 'DevOps Engineer', 'SRE Engineer', 'Integration Engineer', 'Mobile Engineer', 'API Architect', 'Performance Engineer', 'Build Engineer', 'Release Engineer', 'Developer Experience Engineer'],
  MARKETING: ['Marketer', 'Growth Strategist', 'Content Strategist', 'SEO Specialist', 'Performance Marketer', 'Brand Strategist', 'Lifecycle Marketer', 'CRM Marketer', 'Campaign Manager', 'Market Researcher', 'Copywriter', 'Community Manager', 'Partnership Marketer', 'Demand Generation Lead', 'Marketing Analyst'],
  LEGAL: ['Legal Auditor', 'Contract Reviewer', 'Compliance Counsel', 'Privacy Reviewer', 'Policy Analyst', 'Regulatory Researcher', 'IP Reviewer', 'Procurement Reviewer', 'Employment Policy Reviewer', 'Risk Counsel', 'Legal Operations Analyst', 'Terms Reviewer', 'Evidence Curator', 'Jurisdiction Researcher'],
  FINANCE: ['Finance Analyst', 'FP&A Analyst', 'Accountant', 'Controller', 'Treasury Analyst', 'Pricing Analyst', 'Revenue Analyst', 'Cost Analyst', 'Tax Researcher', 'Audit Analyst', 'Budget Planner', 'Unit Economics Analyst', 'Forecasting Analyst', 'Procurement Analyst'],
  MEDIA_PRODUCTION: ['Creative Director', 'Storyboard Artist', 'Video Editor', 'Motion Designer', 'Subtitle Editor', 'Audio Engineer', 'Producer', 'Art Director', 'Thumbnail Designer', 'Script Writer', 'Color Reviewer', 'Asset Librarian', 'Post Production QA', 'Media Planner', 'Voice Director'],
  CUSTOMER_SUPPORT: ['Support Operator', 'Escalation Specialist', 'Knowledge Base Writer', 'Customer Success Manager', 'Onboarding Specialist', 'Technical Support Agent', 'Retention Specialist', 'Service Quality Analyst', 'Complaint Analyst', 'Incident Communicator', 'Support Trainer', 'Localization Support Agent', 'Feedback Analyst', 'Help Center Editor'],
  QUALITY_ASSURANCE: ['QA Lead', 'Test Engineer', 'Automation Engineer', 'Contract Test Reviewer', 'Security Test Reviewer', 'Accessibility Tester', 'Performance Tester', 'Migration Tester', 'Release Verifier', 'Regression Analyst', 'Data Quality Reviewer', 'Chaos Test Planner', 'Mobile QA', 'Browser QA', 'Acceptance Test Analyst'],
  STRATEGY: ['Strategy Lead', 'Business Architect', 'Competitive Analyst', 'Portfolio Analyst', 'Scenario Planner', 'Transformation Lead', 'Operating Model Analyst', 'Investment Strategist', 'Partnership Strategist', 'Expansion Analyst', 'Pricing Strategist', 'Risk Strategist', 'Board Briefing Writer', 'Decision Analyst'],
  SALES: ['Sales Planner', 'Account Executive', 'Sales Development Rep', 'Solutions Consultant', 'Proposal Specialist', 'Deal Desk Analyst', 'Sales Operations Analyst', 'Pipeline Analyst', 'Territory Planner', 'Renewal Specialist', 'Enterprise Account Planner', 'Objection Analyst', 'Demo Designer', 'Revenue Enablement Lead', 'Bid Manager'],
  OPERATIONS: ['Operations Lead', 'Process Analyst', 'Workflow Designer', 'Supply Planner', 'Inventory Analyst', 'Service Operations Planner', 'Incident Coordinator', 'Vendor Operations Analyst', 'Capacity Planner', 'SLA Analyst', 'Quality Operations Lead', 'Facilities Planner', 'Dispatch Analyst', 'Business Continuity Planner'],
  PRODUCT: ['Product Manager', 'Product Analyst', 'Product Designer', 'UX Researcher', 'Discovery Lead', 'Roadmap Planner', 'Requirements Analyst', 'Experiment Designer', 'Adoption Analyst', 'Product Operations Lead', 'Technical Product Manager', 'User Journey Analyst', 'Feature Auditor', 'Release Product Lead', 'Monetization PM'],
  DATA_AI: ['Data Scientist', 'ML Engineer', 'Analytics Engineer', 'Data Engineer', 'Prompt Engineer', 'Evaluation Engineer', 'AI Safety Analyst', 'RAG Engineer', 'Knowledge Graph Engineer', 'Model Operations Engineer', 'Computer Vision Engineer', 'NLP Engineer', 'Causal Analyst', 'Data Steward'],
  SECURITY: ['Security Architect', 'Application Security Engineer', 'Threat Modeler', 'Cloud Security Engineer', 'Identity Engineer', 'Incident Responder', 'Security Operations Analyst', 'Privacy Engineer', 'Cryptography Reviewer', 'Supply Chain Security Analyst', 'Red Team Planner', 'Vulnerability Analyst', 'Audit Evidence Specialist', 'Zero Trust Reviewer', 'Secrets Hygiene Analyst'],
  PEOPLE: ['People Operations Lead', 'Recruiter', 'Talent Sourcer', 'Learning Designer', 'Performance Coach', 'Compensation Analyst', 'Culture Analyst', 'Workforce Planner', 'Employee Relations Reviewer', 'Policy Writer', 'Interview Designer', 'Onboarding Designer', 'Engagement Analyst', 'Organization Designer'],
  RESEARCH: ['Research Lead', 'Evidence Researcher', 'Fact Checker', 'Scientific Reviewer', 'Literature Analyst', 'Survey Designer', 'Experiment Analyst', 'Quantitative Researcher', 'Qualitative Researcher', 'Citation Auditor', 'Methods Reviewer', 'Trend Researcher', 'Technology Scout', 'Research Editor', 'Skeptical Reviewer'],
  LOCALIZATION: ['Localization Lead', 'Russian Translator', 'Uzbek Translator', 'English Editor', 'Terminology Manager', 'Cultural Reviewer', 'Transcreation Writer', 'Subtitle Localizer', 'Internationalization Reviewer', 'Language QA', 'Regional Compliance Reviewer', 'Locale Data Analyst', 'Glossary Curator', 'Multilingual Support Writer'],
}

const LEGACY: Record<string, string> = {
  'MARKETING:Marketer': 'MARKETER', 'FINANCE:Finance Analyst': 'FINANCE_ANALYST',
  'LEGAL:Legal Auditor': 'LEGAL_AUDITOR', 'ENGINEERING:Python Engineer': 'PYTHON_ENGINEER',
  'CUSTOMER_SUPPORT:Support Operator': 'SUPPORT_OPERATOR',
}
function makeId(department: string, title: string): string {
  return LEGACY[`${department}:${title}`] ?? `${department}_${title}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
}
const IDS = Object.entries(TITLES).flatMap(([department, titles]) => titles.map((title) => makeId(department, title)))
const ID_SET = new Set(IDS)
if (IDS.length !== 232 || ID_SET.size !== 232) throw new Error('AGENCY_ROLE_TAXONOMY_INVALID')

export const AgencyRoleIdSchema = z.string().min(3).max(100).regex(/^[A-Z][A-Z0-9_]+$/).refine((id) => ID_SET.has(id), 'unknown agency role')
export const AgencyProfileSchema = ComputeProfileSchema.refine((profile) => profile !== 'PROFILE_D_GPU', 'agency roles cannot access GPU directly')
export const AgencyRoleSchema = z.object({
  id: AgencyRoleIdSchema,
  department: AgencyDepartmentSchema,
  title: z.string().min(3).max(100),
  systemPrompt: z.string().min(80).max(4_000),
  qualityCriteria: z.array(z.string().min(10).max(240)).min(2).max(8),
  allowedComputeProfiles: z.array(AgencyProfileSchema).min(1).max(3).refine((profiles) => new Set(profiles).size === profiles.length, 'compute profiles must be unique'),
}).strict()

export type AgencyRoleId = z.infer<typeof AgencyRoleIdSchema>
export type AgencyRole = z.infer<typeof AgencyRoleSchema>
export type AgencyComputeProfile = z.infer<typeof AgencyProfileSchema>

const ACCESS: Record<AgencyDepartment, AgencyComputeProfile[]> = {
  ENGINEERING: ['PROFILE_A_WASI'], MARKETING: ['PROFILE_B_DOCS', 'PROFILE_C_BROWSER'], LEGAL: ['PROFILE_B_DOCS'], FINANCE: ['PROFILE_A_WASI', 'PROFILE_B_DOCS'],
  MEDIA_PRODUCTION: ['PROFILE_B_DOCS', 'PROFILE_C_BROWSER'], CUSTOMER_SUPPORT: ['PROFILE_A_WASI'], QUALITY_ASSURANCE: ['PROFILE_A_WASI'], STRATEGY: ['PROFILE_A_WASI', 'PROFILE_B_DOCS'],
  SALES: ['PROFILE_B_DOCS'], OPERATIONS: ['PROFILE_A_WASI', 'PROFILE_B_DOCS'], PRODUCT: ['PROFILE_A_WASI', 'PROFILE_B_DOCS'], DATA_AI: ['PROFILE_A_WASI'],
  SECURITY: ['PROFILE_A_WASI', 'PROFILE_B_DOCS'], PEOPLE: ['PROFILE_B_DOCS'], RESEARCH: ['PROFILE_A_WASI', 'PROFILE_B_DOCS'], LOCALIZATION: ['PROFILE_B_DOCS'],
}

function buildRole(id: string, department: AgencyDepartment, title: string): AgencyRole {
  const parsed = AgencyRoleSchema.parse({
    id, department, title,
    systemPrompt: `You are Nemo's ${title} in ${department.replace(/_/g, ' ')}. Work only from verified tenant evidence and explicit capability manifests. Produce reviewable artifacts with assumptions, provenance, uncertainty, and tenant boundaries visible. Never access networks, secrets, tenants, compute profiles, or side effects outside the assigned capability. Escalate consequential or ambiguous actions to policy and human approval.`,
    qualityCriteria: [
      'Every material claim is traceable to supplied evidence or explicitly marked as an assumption.',
      'The artifact satisfies its contract and contains no unapproved external side effect.',
      `The result meets the professional review standard for ${department.replace(/_/g, ' ').toLowerCase()}.`,
    ],
    allowedComputeProfiles: ACCESS[department],
  })
  Object.freeze(parsed.allowedComputeProfiles); Object.freeze(parsed.qualityCriteria)
  return Object.freeze(parsed)
}

const entries: Array<[string, AgencyRole]> = []
for (const [rawDepartment, titles] of Object.entries(TITLES)) {
  const department = AgencyDepartmentSchema.parse(rawDepartment)
  for (const title of titles) entries.push([makeId(department, title), buildRole(makeId(department, title), department, title)])
}
export const AGENCY_ROLES: Readonly<Record<string, AgencyRole>> = Object.freeze(Object.fromEntries(entries))
export const AGENCY_ROLE_COUNT = entries.length

export function getAgencyRolesByDepartment(department: AgencyDepartment): readonly AgencyRole[] {
  return Object.freeze(Object.values(AGENCY_ROLES).filter((item) => item.department === department))
}
export function canRoleUseProfile(roleId: AgencyRoleId, profile: AgencyComputeProfile): boolean {
  return AGENCY_ROLES[roleId]?.allowedComputeProfiles.includes(profile) ?? false
}
