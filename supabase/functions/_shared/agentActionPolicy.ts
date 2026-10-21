// Shared by the integration tester and conversational tools. Approval records are
// decisions only: no status in approval_requests authorizes execution here.
import { redactValue } from './redact.ts'

export type AgentActionPolicy = 'read_only' | 'approval_required'
export interface AgentActionContext {
  agentId?: string
  actorUserId?: string
  dialogueId?: string
  channelId?: string
  // Only the authenticated integration tester may use the existing account-level
  // approval_required default when no saved agent was selected.
  accountToolTester?: boolean
  requestKey?: string
}
export interface AgentActionResult { ok: boolean; result: string; pending_approval?: boolean }

const EXPLICIT_READS = new Set([
  'github_list_repos', 'read_webpage', 'web_search', 'run_code',
  'notion_search', 'notion_read_page', 'wb_products', 'wb_orders',
  'ozon_products', 'ozon_orders', 'uzum_shops', 'uzum_products',
])

// Classify by verified executor semantics, never HTTP method, a model's claim,
// skill label or custom/MCP annotation. Browser reads require the existing validator.
export function isExplicitAgentRead(name: string, browserValidation?: string | null): boolean {
  return EXPLICIT_READS.has(name) || (name === 'browser_task' && browserValidation === null)
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function resolveAgentActionPolicy(db: any, accountId: string, context: AgentActionContext): Promise<AgentActionPolicy | null> {
  if (!accountId) return null
  try {
    const { data: account, error: accountError } = await db.from('accounts').select('id, blocked, is_production_e2e').eq('id', accountId).maybeSingle()
    if (accountError || !account || account.id !== accountId || account.blocked || account.is_production_e2e) return null
    if (context.actorUserId) {
      const { data: actor, error } = await db.from('users').select('id, account_id').eq('id', context.actorUserId).eq('account_id', accountId).maybeSingle()
      if (error || !actor || actor.id !== context.actorUserId || actor.account_id !== accountId) return null
    }
    if (context.agentId) {
      const { data: agent, error } = await db.from('agents').select('id, account_id, action_policy').eq('id', context.agentId).eq('account_id', accountId).maybeSingle()
      if (error || !agent || agent.id !== context.agentId || agent.account_id !== accountId) return null
      return agent.action_policy === 'read_only' || agent.action_policy === 'approval_required' ? agent.action_policy : null
    }
    return context.accountToolTester && context.actorUserId ? 'approval_required' : null
  } catch { return null }
}

// Same schema, expiry and owner-decision queue previously local to agent-tool.
// Identity is server supplied and separate from untrusted tool arguments.
export async function queueAgentApproval(db: any, accountId: string, actionType: string, args: unknown, context: AgentActionContext = {}, source: 'agent' | 'browser' = 'agent'): Promise<AgentActionResult> {
  try {
    const now = new Date()
    if (context.requestKey) {
      const { data: existing, error } = await db.from('approval_requests').select('id').eq('account_id', accountId)
        .eq('source', source).eq('action_type', actionType.slice(0, 120)).eq('status', 'pending')
        .contains('evidence', { nemo: { request_key: context.requestKey } }).gt('expires_at', now.toISOString()).limit(1).maybeSingle()
      if (error) return { ok: false, result: 'Не удалось проверить запрос на подтверждение. Действие не выполнено.' }
      if (existing?.id) return { ok: true, result: `Действие не выполнено. Ожидает подтверждения владельца: ${existing.id}.`, pending_approval: true }
    }
    const { data, error } = await db.from('approval_requests').insert({
      account_id: accountId,
      source,
      action_type: actionType.slice(0, 120),
      summary: `Agent requested ${actionType}; no external action was performed.`,
      evidence: { args: redactValue(args), nemo: {
        agent_id: context.agentId ?? null, actor_user_id: context.actorUserId ?? null,
        dialogue_id: context.dialogueId ?? null, channel_id: context.channelId ?? null,
        ...(context.requestKey ? { request_key: context.requestKey } : {}),
      } },
      expires_at: new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString(),
    }).select('id').single()
    return error || !data?.id
      ? { ok: false, result: 'Не удалось создать запрос на подтверждение. Действие не выполнено.' }
      : { ok: true, result: `Действие не выполнено. Создан owner approval request ${data.id}.`, pending_approval: true }
  } catch { return { ok: false, result: 'Не удалось создать запрос на подтверждение. Действие не выполнено.' } }
}

// null authorizes an explicitly read-only executor. Every other result is terminal
// for that action: block or queue it, never execute it even if a prior request was approved.
export async function guardAgentAction(db: any, accountId: string, name: string, args: unknown, context: AgentActionContext = {}, browserValidation?: string | null): Promise<AgentActionResult | null> {
  if (!accountId) return { ok: false, result: 'Аккаунт недоступен. Действие не выполнено.' }
  if (isExplicitAgentRead(name, browserValidation)) return null
  if (name === 'browser_task' && browserValidation && !browserValidation.includes('owner approval')) return { ok: false, result: browserValidation }
  const policy = await resolveAgentActionPolicy(db, accountId, context)
  if (!policy) return { ok: false, result: 'Не удалось проверить аккаунт и политику сотрудника. Действие не выполнено.' }
  if (policy === 'read_only') return { ok: false, result: 'Политика этого агента: read-only. Действие заблокировано.' }
  return await queueAgentApproval(db, accountId, name === 'browser_task' ? 'browser_mutation' : name,
    name === 'browser_task' ? { args, validation: browserValidation } : args, context, name === 'browser_task' ? 'browser' : 'agent')
}
/* eslint-enable @typescript-eslint/no-explicit-any */
