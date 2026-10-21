// Step 2b SQL behavior — ACTUAL PostgreSQL execution via in-process PGlite (no docker, no
// production database, fully offline). The migrations run verbatim (delivery SQL up to its
// cron/vault section, which needs pg_cron/vault and is exercised only in real deploys), then the
// RPCs are driven through the exact adversarial scenarios from review:
//   • two bots delivering the same telegram update id;
//   • concurrent claim issuance (older claim must not verify);
//   • rebinding the recipient and replaying the same chat-local message id;
//   • retry exhaustion and post-dispatch lease expiry becoming terminal states;
//   • ROLE-BASED isolation: owner/operator/cross-tenant/anon visibility and revoked writes.
//
// Honest scope: PGlite is a SINGLE connection — issuance ordering and claim leasing are verified
// as sequential lifecycles; true concurrency (FOR UPDATE blocking, SKIP LOCKED under parallel
// sessions) is NOT provable here and remains a real-deploy property. auth.uid() and
// current_account_id() are settable stubs (the real current_account_id also excludes blocked
// accounts — that path is covered by the in-RPC blocked checks instead).
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

const A1 = '11111111-1111-4111-8111-111111111111'
const A2 = '22222222-2222-4222-8222-222222222222'
const AG1 = 'ccccccc1-cccc-4ccc-8ccc-ccccccccccc1'
const AG2 = 'ccccccc2-cccc-4ccc-8ccc-ccccccccccc2'
const CH1 = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const CH2 = 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const CH3 = 'aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
const USER1 = 'bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1'

let db: PGlite

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await db.query<T>(sql, params)
  return result.rows[0]
}
const rpc = async (call: string, params: unknown[]) => (await one<Record<string, unknown>>(`select ${call} as r`, params)).r

async function saveSettings(account: string, channel: string | null, morning = true, evening = true) {
  // the chat id is deliberately NULL: the pending binding is completed by verification, which
  // discovers the real chat from the /start message
  return await rpc('public.briefing_save_settings($1,$2,$3,$4,$5,$6,$7,$8)',
    [account, morning, evening, null, null, channel, null, USER1]) as Record<string, unknown>
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable
      as $fn$ select nullif(current_setting('test.uid', true), '')::uuid $fn$;
    create function public.current_account_id() returns uuid language sql stable
      as $fn$ select nullif(current_setting('test.account', true), '')::uuid $fn$;
    create table public.accounts (id uuid primary key, blocked boolean not null default false);
    create table public.users (id uuid primary key, account_id uuid, role text, is_admin boolean default false);
    create table public.agents (id uuid primary key, account_id uuid not null references public.accounts(id));
    create table public.channels (id uuid primary key, agent_id uuid not null references public.agents(id), type text, credentials jsonb);
    -- the RLS predicates subquery public.users as the caller's role, like production grants allow
    grant usage on schema public to anon, authenticated;
    grant select on public.users to authenticated;
  `)
  const settingsSql = readFileSync(new URL('../supabase/migrations/20260905190000_daily_briefing_settings.sql', import.meta.url), 'utf8')
  await db.exec(settingsSql)
  const deliverySql = readFileSync(new URL('../supabase/migrations/20260905200000_daily_briefing_delivery.sql', import.meta.url), 'utf8')
  const cronAt = deliverySql.indexOf('-- ── cron:')
  expect(cronAt).toBeGreaterThan(0)
  await db.exec(deliverySql.slice(0, cronAt))
  await db.exec(`
    insert into public.accounts (id) values ('${A1}'), ('${A2}');
    insert into public.users (id, account_id, role) values ('${USER1}', '${A1}', 'owner');
    insert into public.agents (id, account_id) values
      ('${AG1}', '${A1}'), ('${AG2}', '${A2}');
    insert into public.channels (id, agent_id, type) values
      ('${CH1}', '${AG1}', 'telegram'), ('${CH3}', '${AG1}', 'telegram'), ('${CH2}', '${AG2}', 'telegram');
  `)
}, 30_000)

describe('claim lifecycle', () => {
  test('save bumps the revision and clears verification + claim pointer atomically', async () => {
    const first = await saveSettings(A1, CH1)
    expect(first).toMatchObject({ settings_revision: 1, recipient_verified_at: null, current_claim_id: null })
    const second = await saveSettings(A1, CH1)
    expect(second.settings_revision).toBe(2)
  })

  test('issue → consume verifies, binds the chat from /start, and is single-use', async () => {
    // enabled with a PENDING chat: the constraint requires only the bot binding
    const pending = await one(`select notify_chat_id, morning_enabled from public.briefing_settings where account_id = $1`, [A1])
    expect(pending).toMatchObject({ notify_chat_id: null, morning_enabled: true })
    expect(await rpc('public.briefing_issue_claim($1,$2)', [A1, 'hash-a'])).toMatchObject({ ok: true })
    const consumed = await rpc('public.briefing_consume_claim($1,$2,$3)', ['hash-a', '111', CH1]) as Record<string, unknown>
    expect(consumed).toMatchObject({ ok: true, account_id: A1 })
    const settings = await one(`select recipient_verified_at, notify_chat_id, current_claim_id from public.briefing_settings where account_id = $1`, [A1])
    expect(settings.recipient_verified_at).not.toBeNull()
    expect(settings.notify_chat_id).toBe('111')
    expect(settings.current_claim_id).toBeNull()
    expect(await rpc('public.briefing_consume_claim($1,$2,$3)', ['hash-a', '111', CH1])).toMatchObject({ ok: false, reason: 'invalid' })
  })

  test('a save AFTER issuance invalidates the outstanding claim transactionally', async () => {
    await rpc('public.briefing_issue_claim($1,$2)', [A1, 'hash-b'])
    await saveSettings(A1, CH1) // owner edits settings before tapping the link
    expect(await rpc('public.briefing_consume_claim($1,$2,$3)', ['hash-b', '111', CH1])).toMatchObject({ ok: false, reason: 'superseded' })
    const settings = await one(`select recipient_verified_at from public.briefing_settings where account_id = $1`, [A1])
    expect(settings.recipient_verified_at).toBeNull()
  })

  test('sequential re-issuance: only the newest claim can verify — the older is refused', async () => {
    // single-connection lifecycle check: true concurrent FOR UPDATE serialization is a
    // real-deploy property this suite deliberately does not claim to prove
    await rpc('public.briefing_issue_claim($1,$2)', [A1, 'hash-old'])
    await rpc('public.briefing_issue_claim($1,$2)', [A1, 'hash-new'])
    // issuing deletes unconsumed predecessors under the settings lock, so the old hash is gone
    expect(await rpc('public.briefing_consume_claim($1,$2,$3)', ['hash-old', '111', CH1])).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await rpc('public.briefing_consume_claim($1,$2,$3)', ['hash-new', '111', CH1])).toMatchObject({ ok: true })
  })

  test('the wrong bot cannot consume a claim issued for another channel', async () => {
    await rpc('public.briefing_issue_claim($1,$2)', [A1, 'hash-c'])
    expect(await rpc('public.briefing_consume_claim($1,$2,$3)', ['hash-c', '111', CH2])).toMatchObject({ ok: false, reason: 'wrong_channel' })
  })

  test('a blocked account can neither issue nor consume', async () => {
    await db.exec(`update public.accounts set blocked = true where id = '${A1}'`)
    expect(await rpc('public.briefing_issue_claim($1,$2)', [A1, 'hash-d'])).toMatchObject({ ok: false, reason: 'blocked' })
    await db.exec(`update public.accounts set blocked = false where id = '${A1}'`)
  })
})

describe('delivery runs', () => {
  test('prepare is set-based, verified-only and idempotent; claim leases with bounds', async () => {
    // A1 verified via hash-new above; A2 not verified yet → only A1 gets a row
    const today = (await one<{ d: string }>(`select (((now() + interval '5 hours') at time zone 'UTC')::date)::text as d`)).d
    expect(await rpc(`public.briefing_prepare_runs('morning', $1::date)`, [today])).toBe(1)
    expect(await rpc(`public.briefing_prepare_runs('morning', $1::date)`, [today])).toBe(0)
    const claimed = await db.query<{ id: string; lease_token: string; attempt_count: number }>(
      `select * from public.briefing_claim_runs('morning', $1::date, 99, 99999)`, [today])
    expect(claimed.rows).toHaveLength(1)
    expect(claimed.rows[0].attempt_count).toBe(1)
    const again = await db.query(`select * from public.briefing_claim_runs('morning', $1::date, 10, 120)`, [today])
    expect(again.rows).toHaveLength(0) // leased — SKIP LOCKED + status filter hold it

    // the marker atomically validates CURRENT consent and snapshots the recipient
    const run = claimed.rows[0]
    const marked = await rpc('public.briefing_mark_dispatch($1,$2)', [run.id, run.lease_token]) as Record<string, unknown>
    expect(marked).toMatchObject({ ok: true, channel_id: CH1, chat_id: '111' })
    expect(await rpc('public.briefing_mark_dispatch($1,$2)', [run.id, run.lease_token])).toMatchObject({ ok: false, reason: 'lease_lost' })
    expect(await rpc(`public.briefing_finish_run($1,$2,'sent',500,null)`, [run.id, run.lease_token])).toBe(true)
    const row = await one(`select status, telegram_message_id, dispatch_channel_id, dispatch_chat_id from public.briefing_runs where id = $1`, [run.id])
    expect(row).toMatchObject({ status: 'sent', dispatch_channel_id: CH1, dispatch_chat_id: '111' })
  })

  test('recovery: exhausted attempts fail, expired dispatched leases become unknown, stale dates close', async () => {
    const today = (await one<{ d: string }>(`select (((now() + interval '5 hours') at time zone 'UTC')::date)::text as d`)).d
    await db.exec(`
      insert into public.briefing_runs (account_id, kind, run_date, status, attempt_count, lease_token, lease_until, dispatched_at)
      values
        ('${A1}', 'evening', '${today}'::date, 'sending', 2, gen_random_uuid(), now() - interval '1 minute', null),
        ('${A2}', 'evening', '${today}'::date, 'sending', 1, gen_random_uuid(), now() - interval '1 minute', now() - interval '2 minutes'),
        ('${A1}', 'morning', '${today}'::date - 1, 'prepared', 0, null, null, null);
    `)
    expect(await rpc(`public.briefing_recover_runs('evening', $1::date)`, [today])).toBe(2)
    expect(await rpc(`public.briefing_recover_runs('morning', $1::date)`, [today])).toBe(1)
    const rows = await db.query<{ status: string; error: string }>(`select status, error from public.briefing_runs order by created_at`)
    const statuses = rows.rows.map((r) => `${r.status}:${r.error ?? ''}`)
    expect(statuses).toContain('failed:attempts_exhausted')
    expect(statuses).toContain('unknown:dispatch_lease_expired')
    expect(statuses).toContain('skipped:expired_unsent')
  })
})

describe('outcome capture', () => {
  test('two bots may deliver the SAME update id; each account records its own outcome', async () => {
    const today = (await one<{ d: string }>(`select (((now() + interval '5 hours') at time zone 'UTC')::date)::text as d`)).d
    // verify A2 on its own bot
    await saveSettings(A2, CH2)
    await rpc('public.briefing_issue_claim($1,$2)', [A2, 'hash-a2'])
    expect(await rpc('public.briefing_consume_claim($1,$2,$3)', ['hash-a2', '222', CH2])).toMatchObject({ ok: true })
    // both accounts have a sent evening run with the SAME chat-local message id 600
    await db.exec(`
      insert into public.briefing_runs (account_id, kind, run_date, status, telegram_message_id, dispatch_channel_id, dispatch_chat_id)
      values
        ('${A1}', 'evening', '${today}'::date, 'sent', 600, '${CH1}', '111'),
        ('${A2}', 'evening', '${today}'::date, 'sent', 600, '${CH2}', '222')
      on conflict (account_id, kind, run_date) do update
        set status = 'sent', telegram_message_id = 600,
            dispatch_channel_id = excluded.dispatch_channel_id, dispatch_chat_id = excluded.dispatch_chat_id;
    `)
    expect(await rpc(`public.briefing_capture_outcome($1,$2,600,777,'итог A1','reply')`, [CH1, '111'])).toMatchObject({ ok: true })
    expect(await rpc(`public.briefing_capture_outcome($1,$2,600,777,'итог A2','reply')`, [CH2, '222'])).toMatchObject({ ok: true })
    // a Telegram retry of the SAME (channel, update) is an idempotent duplicate
    expect(await rpc(`public.briefing_capture_outcome($1,$2,600,777,'итог A1 повтор','reply')`, [CH1, '111'])).toMatchObject({ ok: true, duplicate: true })
    const texts = await db.query<{ text: string }>(`select text from public.briefing_outcomes order by channel_id`)
    expect(texts.rows.map((r) => r.text)).toEqual(['итог A1', 'итог A2'])
  })

  test('rebinding the recipient orphans old message ids: no cross-chat attach, ever', async () => {
    // A1 rebinds to a different bot+chat
    await saveSettings(A1, CH3)
    await rpc('public.briefing_issue_claim($1,$2)', [A1, 'hash-rebind'])
    expect(await rpc('public.briefing_consume_claim($1,$2,$3)', ['hash-rebind', '333', CH3])).toMatchObject({ ok: true })
    // the same numeric message id 600 exists in the NEW chat too — but the old run's snapshot
    // is (CH1, '111'), so a reply in (CH3, '333') must not attach to it
    expect(await rpc(`public.briefing_capture_outcome($1,$2,600,801,'не тот ран','reply')`, [CH3, '333'])).toMatchObject({ ok: false, reason: 'no_match' })
    // and the OLD chat is no longer the verified recipient at all
    expect(await rpc(`public.briefing_capture_outcome($1,$2,600,802,'старый чат','reply')`, [CH1, '111'])).toMatchObject({ ok: false, reason: 'not_verified' })
  })

  test('/day_result records for today; unverified chats and oversized text are refused', async () => {
    const captured = await rpc(`public.briefing_capture_outcome($1,$2,null,900,'итог дня командой','command')`, [CH3, '333']) as Record<string, unknown>
    expect(captured).toMatchObject({ ok: true, duplicate: true }) // A1 already recorded today via reply
    expect(await rpc(`public.briefing_capture_outcome($1,$2,null,901,'x','command')`, [CH2, '999'])).toMatchObject({ ok: false, reason: 'not_verified' })
    const big = 'x'.repeat(2001)
    expect(await rpc(`public.briefing_capture_outcome($1,$2,null,902,$3,'command')`, [CH2, '222', big])).toMatchObject({ ok: false, reason: 'bad_text' })
  })
})

describe('role-based isolation (SET ROLE, settable auth stubs)', () => {
  const USER_OPERATOR = 'bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
  const asUser = async (uid: string, account: string) => {
    await db.query(`select set_config('test.uid', $1, false), set_config('test.account', $2, false)`, [uid, account])
  }

  test('owner sees only their own tenant; an operator sees nothing at all', async () => {
    await db.exec(`insert into public.users (id, account_id, role) values ('${USER_OPERATOR}', '${A1}', 'operator')`)
    try {
      await db.exec('set role authenticated')
      await asUser(USER1, A1)
      const own = await db.query<{ account_id: string }>('select account_id from public.briefing_settings')
      expect(own.rows.length).toBeGreaterThan(0)
      expect(own.rows.every((r) => r.account_id === A1)).toBe(true)
      const runs = await db.query<{ account_id: string }>('select account_id from public.briefing_runs')
      expect(runs.rows.length).toBeGreaterThan(0) // vacuous .every proves nothing
      expect(runs.rows.every((r) => r.account_id === A1)).toBe(true)
      const outcomes = await db.query<{ account_id: string }>('select account_id from public.briefing_outcomes')
      expect(outcomes.rows.length).toBeGreaterThan(0)
      expect(outcomes.rows.every((r) => r.account_id === A1)).toBe(true)
      // same account, operator role: the owner's chat id and coordinates are not their business
      await asUser(USER_OPERATOR, A1)
      expect((await db.query('select 1 from public.briefing_settings')).rows).toHaveLength(0)
      expect((await db.query('select 1 from public.briefing_outcomes')).rows).toHaveLength(0)
      // cross-tenant, forged pairing: production current_account_id derives the account from the
      // uid, so (USER1, A2) may be impossible there — the defense-in-depth u.account_id binding
      // makes it structurally EMPTY regardless, which is what this asserts (not a live exploit)
      await asUser(USER1, A2)
      expect((await db.query('select 1 from public.briefing_settings')).rows).toHaveLength(0)
      expect((await db.query('select 1 from public.briefing_runs')).rows).toHaveLength(0)
      expect((await db.query('select 1 from public.briefing_outcomes')).rows).toHaveLength(0)
    } finally {
      await db.exec('reset role')
    }
  })

  test('browser roles cannot write tables, execute the RPCs, or read claims; anon reads nothing', async () => {
    try {
      await db.exec('set role authenticated')
      await asUser(USER1, A1)
      await expect(db.query(`update public.briefing_settings set morning_enabled = true`)).rejects.toThrow(/permission denied/)
      await expect(db.query(`insert into public.briefing_outcomes (account_id, run_date, channel_id, chat_id, text, telegram_update_id, via) values ('${A1}', now()::date, '${CH1}', '1', 'x', 1, 'command')`)).rejects.toThrow(/permission denied/)
      await expect(db.query(`select public.briefing_issue_claim('${A1}', 'hash-evil')`)).rejects.toThrow(/permission denied/)
      await expect(db.query(`select public.briefing_claim_runs('morning', now()::date, 10, 60)`)).rejects.toThrow(/permission denied/)
      await expect(db.query('select 1 from public.briefing_recipient_claims')).rejects.toThrow(/permission denied/)
      await db.exec('reset role')
      await db.exec('set role anon')
      await expect(db.query('select 1 from public.briefing_settings')).rejects.toThrow(/permission denied/)
      await expect(db.query('select 1 from public.briefing_runs')).rejects.toThrow(/permission denied/)
    } finally {
      await db.exec('reset role')
    }
  })
})
