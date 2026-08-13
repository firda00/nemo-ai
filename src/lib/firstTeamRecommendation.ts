import type { AgentActionPolicy, ChannelType } from '../types/platform'

export interface OnboardingBusinessProfile {
  name: string | null
  operating_markets: string[] | null
  owner_role: string | null
  primary_goal: string | null
  task_types: string[] | null
  data_sources: string[] | null
  default_action_policy: AgentActionPolicy | null
}

export interface FirstTeamRecommendation {
  title: string
  description: string
  channels: ChannelType[]
  actionPolicy: AgentActionPolicy
  country: string
  purpose: string
  niche: string
}

const taskBlueprints: Record<string, { title: string; specialist: string; niche: string }> = {
  marketplace: { title: 'Marketplace Growth Team', specialist: 'marketplace analyst and listing optimizer', niche: 'Marketplace / E-commerce' },
  sales: { title: 'AI Sales Team', specialist: 'lead qualifier and sales specialist', niche: 'Sales / SMB' },
  support: { title: 'AI Support Team', specialist: 'knowledge specialist and escalation coordinator', niche: 'Customer Support' },
  content: { title: 'AI Content Team', specialist: 'content strategist and copywriter', niche: 'Content / Marketing' },
  operations: { title: 'AI Operations Team', specialist: 'operations analyst and workflow coordinator', niche: 'Business Operations' },
  development: { title: 'AI Development Team', specialist: 'software engineer and code reviewer', niche: 'Software Development' },
  research: { title: 'AI Research Team', specialist: 'researcher and evidence reviewer', niche: 'Research' },
}

const taskPriority = ['marketplace', 'sales', 'support', 'content', 'operations', 'development', 'research']
const marketLabels: Record<string, string> = { uz: 'Uzbekistan', us: 'United States', uz_us: 'Uzbekistan and the United States', other: 'the selected market' }

export function recommendFirstTeam(profile: OnboardingBusinessProfile): FirstTeamRecommendation {
  const tasks = (profile.task_types ?? []).filter((task) => task in taskBlueprints)
  const primaryTask = taskPriority.find((task) => tasks.includes(task)) ?? 'operations'
  const primary = taskBlueprints[primaryTask]
  const specialists = tasks.map((task) => taskBlueprints[task].specialist)
  const sources = profile.data_sources ?? []
  const channels: ChannelType[] = []
  if (sources.includes('telegram')) channels.push('telegram')
  if (sources.includes('website')) channels.push('widget')
  const company = profile.name?.trim() || 'the business'
  const purpose = profile.primary_goal?.trim() || `Build a measurable operating workflow for ${company}.`
  const market = marketLabels[profile.operating_markets?.[0] ?? 'other'] ?? marketLabels.other
  const sourceText = sources.filter((source) => source !== 'later').join(', ') || 'sources connected later'

  return {
    title: primary.title,
    description: `Create ${primary.title} for ${company}, operating in ${market}. The owner's goal is: ${purpose}\n\nUse a master agent with ${specialists.join(', ') || primary.specialist}. Ground work in these available sources: ${sourceText}. Decompose each goal, preserve evidence in Agent Trace, run quality checks, and send every external change through the configured action policy. Escalate uncertainty to the owner.`,
    channels,
    actionPolicy: profile.default_action_policy === 'read_only' ? 'read_only' : 'approval_required',
    country: market,
    purpose,
    niche: primary.niche,
  }
}
