export interface CapabilitySkill {
  id: string
  version: number
  tools: string[]
  instruction: string
}

// User-selectable, production-safe methods. A skill may unlock only the keyless tools
// listed here; provider keys, channel ACLs and the customer-facing deny-list still win.
// Outbound-message skills are deliberately draft-only unless a dedicated tool policy
// explicitly allows a write.
export const CAPABILITY_SKILLS: CapabilitySkill[] = [
  {
    id: 'data-analysis', version: 1,
    tools: ['run_code', 'web_search', 'read_webpage'],
    instruction: 'Calculate instead of guessing. State inputs, method, result, anomalies and confidence. Keep facts separate from assumptions.',
  },
  {
    id: 'web-research', version: 1,
    tools: ['web_search', 'read_webpage'],
    instruction: 'Research current facts from multiple relevant sources. Cite source URLs, dates and disagreements; never invent a source.',
  },
  {
    id: 'scheduling', version: 1,
    tools: ['book_appointment'],
    instruction: 'Confirm service, exact date, time and timezone before booking. Never claim a booking exists unless the tool confirms it.',
  },
  {
    id: 'grounded-knowledge', version: 1,
    tools: [],
    instruction: 'Answer factual questions only from supplied business knowledge. If evidence is missing or conflicting, say so and request the missing source or escalate.',
  },
  {
    id: 'structured-intake', version: 1,
    tools: [],
    instruction: 'Collect only the minimum missing fields, one short question at a time. Summarize the request, constraints, owner and next step without inventing values.',
  },
  {
    id: 'lead-crm-handoff', version: 1,
    tools: [],
    instruction: 'Qualify need, fit, budget, authority, timing and consent. Produce a concise CRM handoff with known facts, missing fields, score rationale and next action.',
  },
  {
    id: 'follow-up-drafting', version: 1,
    tools: [],
    instruction: 'Draft concise follow-ups with context, value, one clear CTA and a respectful stop condition. Do not send anything unless an approved tool call confirms delivery.',
  },
  {
    id: 'meeting-to-tasks-text', version: 1,
    tools: [],
    instruction: 'For pasted meeting text, extract decisions, action items, assignee, deadline, dependency and unresolved question. Mark missing owners or dates explicitly; do not infer them.',
  },
  {
    id: 'task-sla-control', version: 1,
    tools: [],
    instruction: 'Track every task by owner, deadline, priority, status, blocker and definition of done. Flag overdue and at-risk work with a concrete recovery action.',
  },
  {
    id: 'document-evidence-review', version: 1,
    tools: [],
    instruction: 'Review documents claim by claim. Quote only short necessary evidence, identify contradictions and missing data, and label conclusions as proven, uncertain or unsupported.',
  },
  {
    id: 'commercial-comparison', version: 1,
    tools: ['run_code'],
    instruction: 'Compare offers using the same criteria: total cost, scope, terms, exclusions, risk and weighted fit. Show the basis for each score and do not hide unknowns.',
  },
  {
    id: 'catalog-inventory-analysis', version: 1,
    tools: ['run_code'],
    instruction: 'Analyze product or inventory data for stockouts, slow movers, margin, demand and data-quality issues. Recommend actions tied to specific rows or metrics.',
  },
  {
    id: 'logistics-exception-control', version: 1,
    tools: ['run_code'],
    instruction: 'Normalize shipment events, compare planned versus actual milestones, flag ETA/SLA exceptions and name the owner, evidence and next recovery action.',
  },
  {
    id: 'executive-reporting', version: 1,
    tools: [],
    instruction: 'Produce an executive brief: outcome, KPI movement, causes, risks, decisions needed and next actions with owners and dates. Keep activity separate from business result.',
  },
  {
    id: 'content-production-review', version: 1,
    tools: ['web_search', 'read_webpage'],
    instruction: 'Build and review content against audience, business goal, hook, proof, platform format, CTA and brand voice. Reject generic AI filler and unsupported claims.',
  },
]

export const SKILL_TOOLS: Record<string, string[]> = Object.fromEntries(
  CAPABILITY_SKILLS.map((skill) => [skill.id, skill.tools]),
)

const SKILL_INDEX = new Map(CAPABILITY_SKILLS.map((skill) => [skill.id, skill]))

export function selectedSkillBlock(ids: unknown): string {
  if (!Array.isArray(ids)) return ''
  const selected = [...new Set(ids.map(String))]
    .map((id) => SKILL_INDEX.get(id))
    .filter((skill): skill is CapabilitySkill => Boolean(skill))
    .slice(0, 6)
  if (!selected.length) return ''
  return '\n\n=== ENABLED WORK METHODS ===\n' + selected
    .map((skill) => `- ${skill.id}@${skill.version}: ${skill.instruction}`)
    .join('\n')
}
