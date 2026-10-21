import { describe, expect, test, vi } from 'vitest'
import { guardAgentAction, isExplicitAgentRead, resolveAgentActionPolicy } from '../supabase/functions/_shared/agentActionPolicy'

const context = { agentId: 'agent-a', actorUserId: 'user-a', dialogueId: 'dialogue-a' }
function fixture(options: { policy?: unknown; account?: unknown; actor?: unknown; agent?: unknown; fail?: string; throws?: string; existing?: unknown } = {}) {
  const rows: Record<string, unknown> = {
    accounts: options.account === undefined ? { id: 'tenant-a', blocked: false, is_production_e2e: false } : options.account,
    users: options.actor === undefined ? { id: 'user-a', account_id: 'tenant-a' } : options.actor,
    agents: options.agent === undefined ? { id: 'agent-a', account_id: 'tenant-a', action_policy: 'policy' in options ? options.policy : 'approval_required' } : options.agent,
    approval_requests: options.existing ?? null,
  }
  const inserted: Array<Record<string, unknown>> = []
  const filters: Array<[string, string, unknown]> = []
  const from = vi.fn((table: string) => {
    let writing = false
    const result = async () => {
      if (options.throws === table) throw new Error('synthetic failure')
      return { data: writing ? { id: 'approval-a' } : rows[table], error: options.fail === table ? { code: 'offline' } : null }
    }
    const query = { select: () => query, eq: (key: string, value: unknown) => { filters.push([table, key, value]); return query },
      contains: () => query, gt: () => query, limit: () => query,
      insert: (row: Record<string, unknown>) => { writing = true; inserted.push(row); return query }, maybeSingle: result, single: result }
    return query
  })
  return { db: { from }, from, inserted, filters }
}

describe('shared action policy applies at execution time', () => {
  test.each(['github_list_repos', 'read_webpage', 'web_search', 'run_code', 'notion_search', 'notion_read_page', 'wb_products', 'wb_orders', 'ozon_products', 'ozon_orders', 'uzum_shops', 'uzum_products'])('%s is a verified read and does not depend on a saved write policy', async name => {
    const f = fixture({ agent: null, fail: 'agents' })
    expect(await guardAgentAction(f.db, 'tenant-a', name, {}, {})).toBeNull()
    expect(f.from).not.toHaveBeenCalled()
  })

  test.each(['gmail_send', 'calendar_create_event', 'sheets_append', 'sheets_create', 'docs_create', 'add_task', 'book_appointment', 'github_create_issue', 'slack_send_message', 'hubspot_create_contact', 'bitrix24_create_lead', 'amocrm_create_lead', 'notion_create_page', 'airtable_create_record', 'stripe_create_customer', 'ct_get_webhook', 'mcp_server_reader', 'lead_crm_push', 'escalation_notify'])('%s cannot execute for either saved policy', async name => {
    for (const policy of ['read_only', 'approval_required']) {
      const f = fixture({ policy })
      const result = await guardAgentAction(f.db, 'tenant-a', name, { title: 'Test', password: 'hidden' }, context)
      expect(result).not.toBeNull()
      expect(result?.pending_approval ?? false).toBe(policy === 'approval_required')
      expect(f.inserted).toHaveLength(policy === 'approval_required' ? 1 : 0)
      if (f.inserted.length) {
        expect(f.inserted[0]).toMatchObject({ account_id: 'tenant-a', source: 'agent', action_type: name,
          evidence: { args: { title: 'Test', password: '[REDACTED]' }, nemo: { agent_id: 'agent-a', actor_user_id: 'user-a' } } })
      }
    }
  })

  test.each([
    { policy: null }, { policy: 'allow_all' }, { agent: null }, { fail: 'agents' }, { throws: 'agents' },
    { agent: { id: 'agent-a', account_id: 'tenant-b', action_policy: 'approval_required' } },
    { account: null }, { fail: 'accounts' }, { account: { id: 'tenant-b' } },
    { account: { id: 'tenant-a', blocked: true } }, { account: { id: 'tenant-a', is_production_e2e: true } },
    { actor: null }, { fail: 'users' }, { actor: { id: 'user-b', account_id: 'tenant-a' } },
    { actor: { id: 'user-a', account_id: 'tenant-b' } },
  ])('missing/unreadable/wrong-tenant policy fails closed: %j', async options => {
    const f = fixture(options)
    expect(await guardAgentAction(f.db, 'tenant-a', 'book_appointment', {}, context)).toMatchObject({ ok: false })
    expect(f.inserted).toHaveLength(0)
  })

  test('saved agent and actor reads are scoped to both identity and tenant', async () => {
    const f = fixture()
    expect(await resolveAgentActionPolicy(f.db, 'tenant-a', context)).toBe('approval_required')
    expect(f.filters).toEqual(expect.arrayContaining([
      ['agents', 'id', 'agent-a'], ['agents', 'account_id', 'tenant-a'],
      ['users', 'id', 'user-a'], ['users', 'account_id', 'tenant-a'], ['accounts', 'id', 'tenant-a'],
    ]))
  })

  test('draft cannot manufacture a policy; authenticated account tool tester retains queue-only default', async () => {
    const f = fixture()
    expect(await guardAgentAction(f.db, 'tenant-a', 'sheets_create', {}, { actorUserId: 'user-a' })).toMatchObject({ ok: false })
    expect(f.inserted).toHaveLength(0)
    expect(await guardAgentAction(f.db, 'tenant-a', 'sheets_create', {}, { actorUserId: 'user-a', accountToolTester: true })).toMatchObject({ pending_approval: true })
    expect(f.inserted).toHaveLength(1)
    const missingProfile = fixture({ actor: null })
    expect(await guardAgentAction(missingProfile.db, 'tenant-a', 'sheets_create', {}, { actorUserId: 'user-a', accountToolTester: true })).toMatchObject({ ok: false })
    expect(missingProfile.inserted).toHaveLength(0)
  })

  test('browser is read-only only after validation, invalid/abusive inputs cannot be queued', async () => {
    const f = fixture()
    expect(isExplicitAgentRead('browser_task')).toBe(false)
    expect(await guardAgentAction(f.db, 'tenant-a', 'browser_task', {}, context, null)).toBeNull()
    expect(await guardAgentAction(f.db, 'tenant-a', 'browser_task', {}, context, 'Invalid URL')).toEqual({ ok: false, result: 'Invalid URL' })
    expect(f.inserted).toHaveLength(0)
    expect(await guardAgentAction(f.db, 'tenant-a', 'browser_task', {}, context, 'Requires owner approval')).toMatchObject({ pending_approval: true })
    expect(f.inserted[0]).toMatchObject({ source: 'browser', action_type: 'browser_mutation' })
  })

  test('approval failure never reports pending/completed, repeated automatic request reuses pending id', async () => {
    for (const options of [{ fail: 'approval_requests' }, { throws: 'approval_requests' }]) {
      const f = fixture(options)
      expect(await guardAgentAction(f.db, 'tenant-a', 'gmail_send', {}, context)).toMatchObject({ ok: false })
    }
    const f = fixture({ existing: { id: 'already-pending' } })
    expect(await guardAgentAction(f.db, 'tenant-a', 'lead_crm_push', {}, { ...context, requestKey: 'lead:1' })).toMatchObject({ pending_approval: true, result: expect.stringContaining('already-pending') })
    expect(f.inserted).toHaveLength(0)
    const noTenant = fixture()
    expect(await guardAgentAction(noTenant.db, '', 'read_webpage', {}, context)).toMatchObject({ ok: false })
    expect(noTenant.from).not.toHaveBeenCalled()
  })
})
