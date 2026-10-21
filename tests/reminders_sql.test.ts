// Monthly reminders (Plan B foundation) — ACTUAL PostgreSQL execution via in-process PGlite
// (no docker, offline). The briefing migrations load first (the verified recipient is REUSED),
// then the reminders migration runs verbatim. Scenarios from two review rounds, including the
// two root-REPRODUCED regressions:
//   • the planner must never backfill a date before the CURRENT consent: due_at is gated on
//     GREATEST(enabled_at of the current revision, recipient_verified_at) — root reproduced a
//     pre-verification occurrence on the date-only version;
//   • a schedule edit must never erase the user's task — root reproduced a title-edited
//     'todo' task being deleted; now the occurrence is RESCHEDULED in place and tasks survive;
//   • atomic occurrence→task creation, idempotent re-planning (immutable month key);
//   • day clamping (31st in June, 30th in February); enable-after-send-time creates nothing;
//   • disable makes planned occurrences terminal (skipped:schedule_disabled), tasks preserved,
//     and the month stays consumed — re-enabling the same month sends nothing (documented);
//   • lease-CAS claim lifecycle, retry exhaustion, post-dispatch lease expiry → terminal unknown;
//   • INDEPENDENCE both ways: morning/evening OFF must not stop an enabled monthly reminder,
//     and re-saving the briefing recipient (verification reset) must stop it until reverified;
//   • RLS: owner reads own rows; forged cross-tenant identity reads nothing; writes revoked.
//
// Honest scope: PGlite is a SINGLE connection — lifecycles are verified sequentially. True
// two-connection races (FOR UPDATE blocking, SKIP LOCKED, the schedule-first lock ordering that
// prevents the save↔dispatch deadlock) are NOT provable here: the ordering is a source-level
// invariant, and this suite is written in plain SQL so it can run against a real PostgreSQL
// later. auth.uid()/current_account_id() are settable stubs, as in the briefing suite.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { createHash } from 'node:crypto'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { runReminderDeliveryTick, type ReminderDeliveryDeps } from '../supabase/functions/_shared/reminderDelivery'
import { buildProductReportDocument } from '../supabase/functions/_shared/reminderWorker'
import { MONTHLY_XLSX_LIMITS, parseSourceXlsx } from '../supabase/functions/_shared/xlsxSource'
import { periodXlsx } from './fixtures/document-source-fixtures'

const A1 = '11111111-1111-4111-8111-111111111111'
const A2 = '22222222-2222-4222-8222-222222222222'
const AG1 = 'ccccccc1-cccc-4ccc-8ccc-ccccccccccc1'
const AG2 = 'ccccccc2-cccc-4ccc-8ccc-ccccccccccc2'
const CH1 = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const USER1 = 'bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const USER2 = 'bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
const OLD = '2026-01-01T00:00:00Z' // consent floor far before every planner date in this suite

let db: PGlite

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await db.query<T>(sql, params)
  return result.rows[0]
}
const all = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows
const rpc = async (call: string, params: unknown[]) => (await one<Record<string, unknown>>(`select ${call} as r`, params)).r

const saveSchedule = (
  account: string, id: string | null, title: string, day: number, minute: number, enabled: boolean, now: string,
) => rpc('public.reminder_save_schedule($1,$2,$3,$4,$5,$6,$7)', [account, id, title, day, minute, enabled, now]) as Promise<Record<string, unknown>>
const plan = async (today: string) => Number(await rpc('public.reminder_plan_occurrences($1,$2)', [today, 3]))
const shiftDay = (isoDate: string, days: number) => {
  const base = new Date(`${isoDate}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() + days)
  return base.toISOString().slice(0, 10)
}
// the tick passes p_min_due_date = today - 3 (the catch-up window); the default mirrors that
const claim = (now: string, minDue?: string, limit = 10) =>
  all<Record<string, unknown>>('select * from public.reminder_claim_due($1,$2,$3,$4)',
    [now, minDue ?? shiftDay(now.slice(0, 10), -3), limit, 120])
const setVerifiedAt = (account: string, at: string | null) =>
  db.query(`update public.briefing_settings set recipient_verified_at = $2 where account_id = $1`, [account, at])

async function verifyRecipient(account: string, hash: string, chat: string) {
  expect(await rpc('public.briefing_issue_claim($1,$2)', [account, hash])).toMatchObject({ ok: true })
  expect(await rpc('public.briefing_consume_claim($1,$2,$3)', [hash, chat, CH1])).toMatchObject({ ok: true })
}

const scheduleIdOf = (saved: Record<string, unknown>) => String((saved.schedule as Record<string, unknown>).id)
// cleanup through the PRODUCT path: disabling terminates the schedule's planned occurrences,
// so later claim() calls cannot pick up this test's leftovers
const disable = async (scheduleId: string) => {
  expect(await saveSchedule(A1, scheduleId, 'закрыто', 1, 0, false, OLD)).toMatchObject({ ok: true })
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
    create table public.tasks (
      id uuid primary key default gen_random_uuid(),
      account_id uuid not null,
      title text not null,
      owner text, deadline date,
      priority text not null default 'medium',
      status text not null default 'todo',
      source text not null default 'meeting',
      details text,
      created_at timestamptz not null default now()
    );
    grant usage on schema public to anon, authenticated;
    grant select on public.users to authenticated;
  `)
  const settingsSql = readFileSync(new URL('../supabase/migrations/20260905190000_daily_briefing_settings.sql', import.meta.url), 'utf8')
  await db.exec(settingsSql)
  const deliverySql = readFileSync(new URL('../supabase/migrations/20260905200000_daily_briefing_delivery.sql', import.meta.url), 'utf8')
  const cronAt = deliverySql.indexOf('-- ── cron:')
  expect(cronAt).toBeGreaterThan(0)
  await db.exec(deliverySql.slice(0, cronAt))
  const remindersSql = readFileSync(new URL('../supabase/migrations/20260905220000_monthly_reminders.sql', import.meta.url), 'utf8')
  await db.exec(remindersSql)
  // the product-report migration runs IN ORDER on top — the whole chain is what deploys
  const filesSql = readFileSync(new URL('../supabase/migrations/20260905233000_product_report_files.sql', import.meta.url), 'utf8')
  await db.exec(filesSql)
  await db.exec(`
    -- production grants PostgREST roles table access by default; RLS is what restricts
    grant select on public.reminder_schedules, public.reminder_occurrences, public.margin_upload_registry to authenticated;
    insert into public.accounts (id) values ('${A1}'), ('${A2}');
    insert into public.users (id, account_id, role) values
      ('${USER1}', '${A1}', 'owner'), ('${USER2}', '${A2}', 'owner'),
      ('bbbbbbb3-bbbb-4bbb-8bbb-bbbbbbbbbbb3', '${A1}', 'operator');
    insert into public.agents (id, account_id) values ('${AG1}', '${A1}'), ('${AG2}', '${A2}');
    insert into public.channels (id, agent_id, type) values ('${CH1}', '${AG1}', 'telegram');
  `)
  // recipient binding for A1: the SAME verification flow the briefing uses (save, then /start),
  // then the verification timestamp is pinned to a controlled value for deterministic floors
  await rpc('public.briefing_save_settings($1,$2,$3,$4,$5,$6,$7,$8)', [A1, true, true, null, null, CH1, null, USER1])
  await verifyRecipient(A1, 'hash-r1', '555')
  await setVerifiedAt(A1, OLD)
}, 30_000)

describe('schedule save', () => {
  test('enabling requires the VERIFIED recipient; A2 has none → refused', async () => {
    expect(await saveSchedule(A2, null, 'Отчёт', 10, 540, true, OLD))
      .toMatchObject({ ok: false, reason: 'recipient_not_verified' })
    expect(await saveSchedule(A2, null, 'Черновик', 10, 540, false, OLD)).toMatchObject({ ok: true })
  })

  test('bad inputs are typed refusals; cross-tenant edit is invisible', async () => {
    expect(await saveSchedule(A1, null, '', 10, 540, false, OLD)).toMatchObject({ ok: false, reason: 'bad_title' })
    expect(await saveSchedule(A1, null, 'X', 0, 540, false, OLD)).toMatchObject({ ok: false, reason: 'bad_day' })
    expect(await saveSchedule(A1, null, 'X', 10, 1500, false, OLD)).toMatchObject({ ok: false, reason: 'bad_minute' })
    const saved = await saveSchedule(A1, null, 'Своё', 5, 540, false, OLD)
    expect(await saveSchedule(A2, scheduleIdOf(saved), 'Чужое', 6, 540, false, OLD))
      .toMatchObject({ ok: false, reason: 'not_found' })
  })

  test('the creation cap is atomic in SQL: the 31st create refuses, edits at the cap still work', async () => {
    // A2 needs no verified recipient for disabled drafts — fill to the cap of 30
    const ids: string[] = []
    while (ids.length < 30) {
      const saved = await saveSchedule(A2, null, `Черновик ${ids.length}`, 10, 540, false, OLD)
      if (saved.ok !== true) break
      ids.push(scheduleIdOf(saved))
    }
    const { count } = await one<{ count: number }>(`select count(*)::int as count from public.reminder_schedules where account_id = $1`, [A2])
    expect(count).toBe(30)
    expect(await saveSchedule(A2, null, 'Тридцать первый', 10, 540, false, OLD))
      .toMatchObject({ ok: false, reason: 'schedule_limit' })
    // at the cap everything stays manageable: edits (and disables) are not blocked
    expect(await saveSchedule(A2, ids[0], 'Правка на лимите', 11, 540, false, OLD)).toMatchObject({ ok: true })
    await db.query(`delete from public.reminder_schedules where account_id = $1`, [A2])
  })
})

describe('planner: clamp, consent floors, atomic task link', () => {
  test('day 31 in June clamps to the 30th; occurrence + task arrive atomically and idempotently', async () => {
    const saved = await saveSchedule(A1, null, 'Сдать отчёт поставщику', 31, 540, true, OLD)
    const scheduleId = scheduleIdOf(saved)
    expect(await plan('2026-06-29')).toBe(0) // not the clamped day yet
    expect(await plan('2026-06-30')).toBe(1)
    expect(await plan('2026-06-30')).toBe(0) // month key: planning is idempotent
    const occ = await one(`select * from public.reminder_occurrences where schedule_id = $1`, [scheduleId])
    expect(occ).toMatchObject({ month_key: '2026-06', status: 'planned', schedule_revision: 1 })
    // 09:00 Tashkent = 04:00 UTC (fixed +5, no DST)
    expect(new Date(String(occ.due_at)).toISOString()).toBe('2026-06-30T04:00:00.000Z')
    const tasks = await all(`select title, status, source from public.tasks where reminder_occurrence_id = $1`, [occ.id as string])
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ title: 'Сдать отчёт поставщику', status: 'todo', source: 'reminder' })
    await disable(scheduleId)
  })

  test('day 30 in February clamps to the last day of February', async () => {
    const saved = await saveSchedule(A1, null, 'Февральский отчёт', 30, 600, true, OLD)
    const scheduleId = scheduleIdOf(saved)
    expect(await plan('2027-02-27')).toBe(0)
    expect(await plan('2027-02-28')).toBe(1) // 2027: February has 28 days
    expect(await one(`select month_key from public.reminder_occurrences where schedule_id = $1`, [scheduleId]))
      .toMatchObject({ month_key: '2027-02' })
    await disable(scheduleId)
  })

  test('REGRESSION (root-reproduced): verification AFTER the missed date blocks the backfill', async () => {
    // schedule enabled Sep 1, reminder day is the 3rd, recipient verified only Sep 5:
    // the missed 3rd is BEFORE the recipient consent — nothing may be created
    const saved = await saveSchedule(A1, null, 'До верификации', 3, 540, true, '2026-09-01T00:00:00Z')
    const scheduleId = scheduleIdOf(saved)
    await setVerifiedAt(A1, '2026-09-05T00:00:00Z')
    expect(await plan('2026-09-05')).toBe(0)
    // with consent OLDER than the date, the same catch-up creates it
    await setVerifiedAt(A1, '2026-09-01T00:00:00Z')
    expect(await plan('2026-09-05')).toBe(1)
    await setVerifiedAt(A1, OLD)
    await disable(scheduleId)
  })

  test('enabling AFTER today’s send time creates nothing today; enabling before it does', async () => {
    // due today at 04:00Z (09:00 Tashkent); enabled only at 10:00Z → consent began after the moment
    const late = await saveSchedule(A1, null, 'Поздно включили', 14, 540, true, '2026-10-14T10:00:00Z')
    expect(await plan('2026-10-14')).toBe(0)
    // an edit that RE-enables earlier the day before moves the floor before the send moment
    await saveSchedule(A1, scheduleIdOf(late), 'Поздно включили', 14, 540, true, '2026-10-13T00:00:00Z')
    expect(await plan('2026-10-14')).toBe(1)
    await disable(scheduleIdOf(late))
  })
})

describe('editing: reschedule in place, tasks never erased, month consumed once', () => {
  test('REGRESSION (root-reproduced): a user-edited todo task SURVIVES a schedule edit; the occurrence moves in place', async () => {
    const saved = await saveSchedule(A1, null, 'Аренда', 20, 540, true, OLD)
    const scheduleId = scheduleIdOf(saved)
    expect(await plan('2026-08-20')).toBe(1)
    const occ = await one(`select id from public.reminder_occurrences where schedule_id = $1`, [scheduleId])
    // the user edits the generated task (still 'todo') — this is THEIR row now
    await db.query(`update public.tasks set title = 'Оплатить аренду и сверить счёт' where reminder_occurrence_id = $1`, [occ.id as string])
    const edited = await saveSchedule(A1, scheduleId, 'Аренда', 21, 600, true, OLD)
    expect((edited.schedule as Record<string, unknown>).schedule_revision).toBe(2)
    // SAME occurrence, new day/time/revision — the month key never moved
    const moved = await one(`select id, due_date::text as due_date, due_at, schedule_revision, month_key from public.reminder_occurrences where schedule_id = $1`, [scheduleId])
    expect(moved).toMatchObject({ id: occ.id, due_date: '2026-08-21', schedule_revision: 2, month_key: '2026-08' })
    expect(new Date(String(moved.due_at)).toISOString()).toBe('2026-08-21T05:00:00.000Z') // 10:00 Tashkent
    // the task is still there, with the USER'S title; only the deadline followed the move
    const tasks = await all(`select title, deadline::text as deadline from public.tasks where reminder_occurrence_id = $1`, [occ.id as string])
    expect(tasks).toEqual([{ title: 'Оплатить аренду и сверить счёт', deadline: '2026-08-21' }])
    // and the planner does NOT mint a duplicate for the same month
    expect(await plan('2026-08-21')).toBe(0)
    await disable(scheduleId)
  })

  test('OWNERSHIP: a user-moved deadline and a completed task are never rewritten by an edit', async () => {
    const movedDeadline = await saveSchedule(A1, null, 'Свой срок', 10, 540, true, OLD)
    expect(await plan('2027-07-10')).toBe(1)
    const occA = await one(`select id from public.reminder_occurrences where schedule_id = $1`, [scheduleIdOf(movedDeadline)])
    // the user moved the deadline themselves — still 'todo', but the value is THEIRS now
    await db.query(`update public.tasks set deadline = '2027-07-25' where reminder_occurrence_id = $1`, [occA.id as string])
    await saveSchedule(A1, scheduleIdOf(movedDeadline), 'Свой срок', 12, 540, true, OLD)
    expect(await one(`select deadline::text as deadline from public.tasks where reminder_occurrence_id = $1`, [occA.id as string]))
      .toMatchObject({ deadline: '2027-07-25' })

    const completed = await saveSchedule(A1, null, 'Сделано досрочно', 10, 540, true, OLD)
    expect(await plan('2027-08-10')).toBe(1)
    const occB = await one(`select id from public.reminder_occurrences where schedule_id = $1`, [scheduleIdOf(completed)])
    await db.query(`update public.tasks set status = 'done' where reminder_occurrence_id = $1`, [occB.id as string])
    await saveSchedule(A1, scheduleIdOf(completed), 'Сделано досрочно', 12, 540, true, OLD)
    expect(await one(`select deadline::text as deadline, status from public.tasks where reminder_occurrence_id = $1`, [occB.id as string]))
      .toMatchObject({ deadline: '2027-08-10', status: 'done' }) // untouched
    await disable(scheduleIdOf(movedDeadline))
    await disable(scheduleIdOf(completed))
  })

  test('disable makes planned occurrences terminal, keeps the task, and the month stays consumed', async () => {
    const saved = await saveSchedule(A1, null, 'Налог', 10, 540, true, OLD)
    const scheduleId = scheduleIdOf(saved)
    expect(await plan('2026-07-10')).toBe(1)
    const occ = await one(`select id from public.reminder_occurrences where schedule_id = $1`, [scheduleId])
    await saveSchedule(A1, scheduleId, 'Налог', 10, 540, false, '2026-07-10T02:00:00Z')
    expect(await one(`select status, error from public.reminder_occurrences where id = $1`, [occ.id as string]))
      .toMatchObject({ status: 'skipped', error: 'schedule_disabled' })
    expect(await all(`select 1 from public.tasks where reminder_occurrence_id = $1`, [occ.id as string])).toHaveLength(1)
    // re-enabling the same month sends nothing more — documented month-consumed behavior
    await saveSchedule(A1, scheduleId, 'Налог', 10, 540, true, OLD)
    expect(await plan('2026-07-10')).toBe(0)
    await disable(scheduleId)
  })

  test('the month identity is frozen at the database level', async () => {
    const saved = await saveSchedule(A1, null, 'Заморозка', 12, 540, true, OLD)
    const scheduleId = scheduleIdOf(saved)
    expect(await plan('2026-10-12')).toBe(1)
    await expect(db.query(`update public.reminder_occurrences set month_key = '2026-11' where schedule_id = $1`, [scheduleId]))
      .rejects.toThrow(/REMINDER_IDENTITY_IMMUTABLE/)
    await disable(scheduleId)
  })
})

describe('outbox lifecycle', () => {
  test('the due gate holds in SQL; claim is lease-fenced; exhaustion and post-dispatch expiry are terminal', async () => {
    const saved = await saveSchedule(A1, null, 'Outbox', 15, 540, true, OLD)
    const scheduleId = scheduleIdOf(saved)
    expect(await plan('2026-11-15')).toBe(1)
    // 09:00 Tashkent is 04:00Z — an 03:00Z drain must not claim it
    expect(await claim('2026-11-15T03:00:00Z')).toHaveLength(0)
    const [first] = await claim('2026-11-15T05:00:00Z')
    expect(first.title).toBe('Outbox')
    expect(await claim('2026-11-15T05:00:00Z')).toHaveLength(0) // leased — no second claim
    // lease expiry WITHOUT dispatch and attempts < 2 → reclaimable
    await db.query(`update public.reminder_occurrences set lease_until = now() - interval '1 minute' where id = $1`, [first.id])
    const [second] = await claim('2026-11-15T05:00:00Z')
    expect(second.attempt_count).toBe(2)
    // attempts exhausted → recover closes it as failed, never eternal 'sending'
    await db.query(`update public.reminder_occurrences set lease_until = now() - interval '1 minute' where id = $1`, [second.id])
    expect(await claim('2026-11-15T05:00:00Z')).toHaveLength(0) // attempt cap in the claim filter
    await rpc('public.reminder_recover($1,$2)', [new Date().toISOString(), '2026-11-01'])
    expect(await one(`select status, error from public.reminder_occurrences where id = $1`, [first.id]))
      .toMatchObject({ status: 'failed', error: 'attempts_exhausted' })

    // post-dispatch lease expiry → UNKNOWN, never resent
    const saved2 = await saveSchedule(A1, null, 'Outbox-2', 16, 540, true, OLD)
    expect(await plan('2026-11-16')).toBe(1)
    const [third] = await claim('2026-11-16T05:00:00Z')
    expect(await rpc('public.reminder_mark_dispatch($1,$2)', [third.id, third.lease_token])).toMatchObject({ ok: true })
    await db.query(`update public.reminder_occurrences set lease_until = now() - interval '1 minute' where id = $1`, [third.id])
    await rpc('public.reminder_recover($1,$2)', [new Date().toISOString(), '2026-11-01'])
    expect(await one(`select status from public.reminder_occurrences where id = $1`, [third.id])).toMatchObject({ status: 'unknown' })
    expect(await claim('2026-11-16T05:00:00Z')).toHaveLength(0)
    await disable(scheduleId)
    await disable(scheduleIdOf(saved2))
  })

  test('an occurrence older than the catch-up window is closed as expired_unsent, never sent late', async () => {
    const saved = await saveSchedule(A1, null, 'Просрочка', 2, 540, true, OLD)
    const scheduleId = scheduleIdOf(saved)
    expect(await plan('2026-12-02')).toBe(1)
    // even BEFORE recovery ran, the claim's own lower bound refuses the stale row —
    // a failed recovery pass cannot leak expired reminders into a send
    expect(await claim('2026-12-06T05:00:00Z', '2026-12-03')).toHaveLength(0)
    await rpc('public.reminder_recover($1,$2)', ['2026-12-06T00:00:00Z', '2026-12-06'])
    expect(await one(`select status, error from public.reminder_occurrences where schedule_id = $1`, [scheduleId]))
      .toMatchObject({ status: 'skipped', error: 'expired_unsent' })
    await disable(scheduleId)
  })

  test('CONSENT AT DISPATCH: an edit moving the day backward cannot send a pre-consent occurrence', async () => {
    const saved = await saveSchedule(A1, null, 'Назад по дню', 20, 540, true, OLD)
    const scheduleId = scheduleIdOf(saved)
    expect(await plan('2028-01-20')).toBe(1)
    // the owner edits the day BACK to the 5th on the 18th: the rescheduled due_at (Jan 5) now
    // lies before this revision's enabled_at (Jan 18) — claimable, but never dispatchable
    await saveSchedule(A1, scheduleId, 'Назад по дню', 5, 540, true, '2028-01-18T00:00:00Z')
    const [claimed] = await claim('2028-01-18T05:00:00Z', '2028-01-02')
    expect(claimed).toBeTruthy()
    expect(await rpc('public.reminder_mark_dispatch($1,$2)', [claimed.id, claimed.lease_token]))
      .toMatchObject({ ok: false, reason: 'pre_consent' })
    await disable(scheduleId)
  })

  test('CONSENT AT DISPATCH: reverifying a recipient AFTER the due moment blocks the old occurrence', async () => {
    const saved = await saveSchedule(A1, null, 'Новый получатель', 9, 540, true, OLD)
    const scheduleId = scheduleIdOf(saved)
    expect(await plan('2028-02-09')).toBe(1)
    const [claimed] = await claim('2028-02-09T05:00:00Z')
    // the recipient is re-verified AFTER the due moment (a new person may now own the chat):
    // the occurrence predates the current consent and must not be delivered to them
    await setVerifiedAt(A1, '2028-02-09T08:00:00Z')
    expect(await rpc('public.reminder_mark_dispatch($1,$2)', [claimed.id, claimed.lease_token]))
      .toMatchObject({ ok: false, reason: 'pre_consent' })
    await setVerifiedAt(A1, OLD)
    await disable(scheduleId)
  })
})

describe('recipient independence — both directions', () => {
  test('morning/evening OFF does not stop an enabled monthly reminder; dispatch snapshots the CURRENT binding revision', async () => {
    // turn both briefing kinds OFF (this clears verification) and re-verify the recipient
    await rpc('public.briefing_save_settings($1,$2,$3,$4,$5,$6,$7,$8)', [A1, false, false, null, null, CH1, null, USER1])
    await verifyRecipient(A1, 'hash-r2', '555')
    await setVerifiedAt(A1, OLD)
    const settings = await one(`select morning_enabled, evening_enabled, settings_revision from public.briefing_settings where account_id = $1`, [A1])
    expect(settings).toMatchObject({ morning_enabled: false, evening_enabled: false })

    const saved = await saveSchedule(A1, null, 'Независимость', 7, 540, true, OLD)
    const scheduleId = scheduleIdOf(saved)
    expect(await plan('2027-03-07')).toBe(1)
    const [claimed] = await claim('2027-03-07T05:00:00Z')
    const marked = await rpc('public.reminder_mark_dispatch($1,$2)', [claimed.id, claimed.lease_token]) as Record<string, unknown>
    expect(marked).toMatchObject({ ok: true, chat_id: '555' }) // flags off, monthly still sends
    const occ = await one(`select dispatch_settings_revision from public.reminder_occurrences where id = $1`, [claimed.id])
    expect(occ.dispatch_settings_revision).toBe(settings.settings_revision) // the CURRENT binding revision
    expect(await rpc('public.reminder_finish($1,$2,$3,$4,$5)', [claimed.id, claimed.lease_token, 'sent', 900, null])).toBe(true)
    await disable(scheduleId)
  })

  test('re-saving the briefing recipient resets verification — monthly dispatch fails closed until reverified', async () => {
    const saved = await saveSchedule(A1, null, 'Закрыто до верификации', 8, 540, true, OLD)
    const scheduleId = scheduleIdOf(saved)
    expect(await plan('2027-04-08')).toBe(1)
    const [claimed] = await claim('2027-04-08T05:00:00Z')
    // the owner re-saves the recipient binding — verification is cleared transactionally
    await rpc('public.briefing_save_settings($1,$2,$3,$4,$5,$6,$7,$8)', [A1, false, false, null, null, CH1, null, USER1])
    expect(await rpc('public.reminder_mark_dispatch($1,$2)', [claimed.id, claimed.lease_token]))
      .toMatchObject({ ok: false, reason: 'recipient_not_verified' })
    await verifyRecipient(A1, 'hash-r3', '555')
    await setVerifiedAt(A1, OLD)
    expect(await rpc('public.reminder_finish($1,$2,$3,$4,$5)', [claimed.id, claimed.lease_token, 'skipped', null, 'recipient_not_verified'])).toBe(true)
    await disable(scheduleId)
  })

  test('a schedule edit mid-flight supersedes the older occurrence at dispatch time', async () => {
    const saved = await saveSchedule(A1, null, 'Ревизия', 9, 540, true, OLD)
    const scheduleId = scheduleIdOf(saved)
    expect(await plan('2027-05-09')).toBe(1)
    const [claimed] = await claim('2027-05-09T05:00:00Z')
    // edit while 'sending': the in-place move touches only planned rows, but the revision moves on
    await saveSchedule(A1, scheduleId, 'Ревизия', 9, 600, true, OLD)
    expect(await rpc('public.reminder_mark_dispatch($1,$2)', [claimed.id, claimed.lease_token]))
      .toMatchObject({ ok: false, reason: 'superseded' })
    await disable(scheduleId)
  })
})

describe('product report files', () => {
  const saveReport = (account: string, id: string | null, title: string, day: number, enabled: boolean, now: string, currency: string | null) =>
    rpc('public.reminder_save_schedule($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [account, id, title, day, 540, enabled, now, 'product_report', currency]) as Promise<Record<string, unknown>>
  const seedSource = (account: string, sha: string, name: string, uploadedAt: string, period: string | null) =>
    db.query(`insert into public.margin_upload_registry (account_id, file_sha256, file_name, uploaded_at, period_month)
              values ($1, $2, $3, $4, $5) on conflict (account_id, file_sha256) do nothing`,
      [account, sha, name, uploadedAt, period])
  const SHA_A = 'a'.repeat(64)
  const SHA_B = 'b'.repeat(64)
  const SHA_C = 'c'.repeat(64)

  test('real SQL → frozen XLSX → filtered document → fake delivery: catch-up cutoff and invalid-date refusal', async () => {
    for (const invalidDate of [false, true]) {
      const parts = unzipSync(periodXlsx({ invalidDate }))
      const bytes = zipSync(Object.fromEntries(Object.entries(parts).map(([name, value]) => [name, strToU8(strFromU8(value).replaceAll('2026', '2030'))])))
      const sha = createHash('sha256').update(bytes).digest('hex')
      await seedSource(A1, sha, 'july.xlsx', '2030-07-20T10:00:00Z', '2030-07')
      const saved = await saveReport(A1, null, 'Июль 30', 30, true, OLD, 'USD')
      const scheduleId = scheduleIdOf(saved)
      expect(await plan('2030-07-30')).toBe(1)
      // PGlite's lease clock is real pg_catalog.now(); the explicit SQL due gate is
      // simulated separately. Monetary/source logic and the lifecycle SQL are unchanged.
      let clock = Date.now()
      const calls: string[] = [], delivered: Uint8Array[] = [], captions: string[] = []
      const argsByName: Record<string, string[]> = {
        reminder_recover: ['p_now', 'p_expire_before'], reminder_claim_due: ['p_now', 'p_min_due_date', 'p_limit', 'p_lease_seconds'],
        reminder_freeze_source: ['p_occurrence_id', 'p_lease_token'], reminder_mark_dispatch: ['p_occurrence_id', 'p_lease_token'],
        reminder_finish: ['p_occurrence_id', 'p_lease_token', 'p_status', 'p_message_id', 'p_error'],
      }
      const deps: ReminderDeliveryDeps = {
        now: () => clock, blocksExternal: async () => false,
        rpc: async (name, args) => {
          calls.push(name)
          const values = argsByName[name].map((key) => args[key])
          if (name === 'reminder_recover' || name === 'reminder_claim_due') values[0] = '2030-08-01T05:00:00Z'
          const call = `public.${name}(${values.map((_, i) => `$${i + 1}`).join(',')})`
          const raw = name === 'reminder_claim_due' ? await all(`select * from ${call}`, values) : await rpc(call, values)
          // PostgREST serializes DATE as YYYY-MM-DD; PGlite's JS driver returns Date.
          const data = name === 'reminder_claim_due' ? (raw as Record<string, unknown>[]).map((row) => ({ ...row, due_date: row.due_date instanceof Date ? row.due_date.toISOString().slice(0, 10) : row.due_date })) : raw
          if (name === 'reminder_freeze_source') {
            // Concurrent registry edit after freezing must not rewrite this occurrence/file.
            expect(data).toMatchObject({ ok: true, file_sha256: sha, period_month: '2030-07' })
            await db.query(`update public.margin_upload_registry set period_month = '2030-08', file_name = 'renamed.xlsx' where account_id = $1 and file_sha256 = $2`, [A1, sha])
          }
          return { data }
        },
        getSourceFile: async (account, requestedSha) => { expect(account).toBe(A1); expect(requestedSha).toBe(sha); return { bytes } },
        buildReport: buildProductReportDocument,
        getChannelToken: async () => 'synthetic-token', send: async () => { throw new Error('must send a document') },
        sendDocument: async (_token, chatId, caption, _name, document) => { expect(chatId).toBe('555'); delivered.push(document); captions.push(caption); return { ok: true, messageId: 918 } },
      }
      const options = { budgetMs: 100000, killSwitch: 'on', todayTashkent: '2030-08-01' }
      const tick = await runReminderDeliveryTick(deps, options)
      const occurrence = await one(`select status, error, source_file_sha256, source_period_month from public.reminder_occurrences where schedule_id = $1 and month_key = '2030-07'`, [scheduleId])
      expect(tick, JSON.stringify({ occurrence, calls })).toMatchObject({ claimed: 1, sent: invalidDate ? 0 : 1, failed: invalidDate ? 1 : 0 })
      expect(occurrence).toMatchObject({ status: invalidDate ? 'failed' : 'sent', source_file_sha256: sha, source_period_month: '2030-07' })
      if (invalidDate) {
        expect(calls).not.toContain('reminder_mark_dispatch')
        expect(delivered).toHaveLength(0)
        expect(occurrence.error).toBe('engine_needs_source_dates')
      } else {
        expect(captions[0]).toContain('2030-07-01 — 2030-07-30')
        expect(captions[0]).toContain('july.xlsx')
        const workbook = parseSourceXlsx(delivered[0], MONTHLY_XLSX_LIMITS)
        const total = workbook.sheets[0].rows.find((r) => r.cells.A?.value === 'totals')!
        expect(total.cells.G.value).toBe('80')
        expect(workbook.sheets.find((s) => s.name === 'Date audit')!.rows.some((r) => r.cells.E?.value === '2030-07-31' && r.cells.F?.value === 'outside_period')).toBe(true)
      }
      clock += 1000
      expect(await runReminderDeliveryTick(deps, options)).toMatchObject({ claimed: 0, sent: 0 })
      expect(delivered).toHaveLength(invalidDate ? 0 : 1)
      await saveReport(A1, scheduleId, 'Июль 30', 30, false, OLD, 'USD')
    }
  })

  test('kind and currency are validated; the OLD 7-argument call still creates plain reminders', async () => {
    expect(await rpc('public.reminder_save_schedule($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [A1, null, 'X', 5, 540, false, OLD, 'weird', null])).toMatchObject({ ok: false, reason: 'bad_kind' })
    expect(await saveReport(A1, null, 'Без валюты', 5, false, OLD, null)).toMatchObject({ ok: false, reason: 'bad_currency' })
    expect(await saveReport(A1, null, 'Не та валюта', 5, false, OLD, 'GBP')).toMatchObject({ ok: false, reason: 'bad_currency' })
    // exact old-call compatibility: defaults make it a plain reminder
    const legacy = await saveSchedule(A1, null, 'Старый вызов', 5, 540, false, OLD)
    expect((legacy.schedule as Record<string, unknown>).kind).toBe('reminder')
    await disable(scheduleIdOf(legacy))
  })

  test('the kind is immutable: a legacy edit of a report schedule refuses instead of mutating it', async () => {
    const saved = await saveReport(A1, null, 'Отчёт по продукту', 15, true, OLD, 'USD')
    const scheduleId = scheduleIdOf(saved)
    expect(await saveSchedule(A1, scheduleId, 'Отчёт по продукту', 15, 540, true, OLD))
      .toMatchObject({ ok: false, reason: 'kind_immutable' })
    expect(await saveReport(A1, scheduleId, 'Отчёт по продукту', 16, true, OLD, 'USD')).toMatchObject({ ok: true })
    await saveReport(A1, scheduleId, 'Отчёт по продукту', 16, false, OLD, 'USD')
  })

  test('freeze picks the latest declared file DETERMINISTICALLY and stamps the FULL snapshot', async () => {
    await seedSource(A1, SHA_C, 'старый.xlsx', '2028-03-01T10:00:00Z', '2028-03')
    // two uploads share a timestamp — the sha tie-break keeps the choice deterministic
    await seedSource(A1, SHA_B, 'поздний-b.xlsx', '2028-03-10T10:00:00Z', '2028-03')
    await seedSource(A1, SHA_A, 'поздний-a.xlsx', '2028-03-10T10:00:00Z', '2028-03')
    const saved = await saveReport(A1, null, 'Мартовский отчёт', 15, true, OLD, 'USD')
    const scheduleId = scheduleIdOf(saved)
    expect(await plan('2028-03-15')).toBe(1)
    const [claimed] = await claim('2028-03-15T05:00:00Z')
    expect(claimed).toMatchObject({ kind: 'product_report', report_currency: 'USD' })
    expect(claimed.lease_until).toBeTruthy()
    const frozen = await rpc('public.reminder_freeze_source($1,$2)', [claimed.id, claimed.lease_token]) as Record<string, unknown>
    expect(frozen).toMatchObject({ ok: true, file_sha256: SHA_A, file_name: 'поздний-a.xlsx', period_month: '2028-03', currency: 'USD' })
    const occ = await one(`select source_file_sha256, source_file_name, source_period_month, source_currency, source_uploaded_at
                             from public.reminder_occurrences where id = $1`, [claimed.id])
    expect(occ).toMatchObject({ source_file_sha256: SHA_A, source_file_name: 'поздний-a.xlsx', source_period_month: '2028-03', source_currency: 'USD' })
    expect(occ.source_uploaded_at).toBeTruthy()

    // idempotence + redeclaration immunity: a newer upload and a period redeclaration arrive
    // AFTER the freeze — the prepared occurrence keeps answering with ITS OWN snapshot
    await seedSource(A1, SHA_C.replace(/c/g, 'd'), 'новее.xlsx', '2028-03-20T10:00:00Z', '2028-03')
    expect(await rpc('public.margin_registry_set_period($1,$2,$3)', [A1, SHA_A, '2028-04'])).toMatchObject({ ok: true })
    const again = await rpc('public.reminder_freeze_source($1,$2)', [claimed.id, claimed.lease_token]) as Record<string, unknown>
    expect(again).toMatchObject({ ok: true, file_sha256: SHA_A, file_name: 'поздний-a.xlsx', period_month: '2028-03' })
    expect(await rpc('public.reminder_finish($1,$2,$3,$4,$5)', [claimed.id, claimed.lease_token, 'skipped', null, 'test_done'])).toBe(true)
    await saveReport(A1, scheduleId, 'Мартовский отчёт', 15, false, OLD, 'USD')
  })

  test('a month with no DECLARED file refuses visibly; other months’ files never leak in', async () => {
    const saved = await saveReport(A1, null, 'Апрельский отчёт', 9, true, OLD, 'UZS')
    const scheduleId = scheduleIdOf(saved)
    expect(await plan('2028-04-09')).toBe(1)
    const [claimed] = await claim('2028-04-09T05:00:00Z')
    // SHA_A was redeclared to 2028-04 in the previous test — remove it to make April empty
    await db.query(`update public.margin_upload_registry set period_month = '2028-03' where account_id = $1 and file_sha256 = $2`, [A1, SHA_A])
    expect(await rpc('public.reminder_freeze_source($1,$2)', [claimed.id, claimed.lease_token]))
      .toMatchObject({ ok: false, reason: 'source_missing_period' })
    expect(await rpc('public.reminder_finish($1,$2,$3,$4,$5)', [claimed.id, claimed.lease_token, 'failed', null, 'source_missing_period'])).toBe(true)
    await saveReport(A1, scheduleId, 'Апрельский отчёт', 9, false, OLD, 'UZS')
  })

  test('disable-during-prepare and a stale lease both refuse the fence', async () => {
    await seedSource(A1, SHA_B.replace(/b/g, 'e'), 'май.xlsx', '2028-05-01T10:00:00Z', '2028-05')
    const saved = await saveReport(A1, null, 'Майский отчёт', 12, true, OLD, 'EUR')
    const scheduleId = scheduleIdOf(saved)
    expect(await plan('2028-05-12')).toBe(1)
    const [claimed] = await claim('2028-05-12T05:00:00Z')
    expect(await rpc('public.reminder_freeze_source($1,$2)', [claimed.id, claimed.lease_token])).toMatchObject({ ok: true })
    // the owner disables while prepare is in flight: the marker refuses, nothing sends
    await saveReport(A1, scheduleId, 'Майский отчёт', 12, false, OLD, 'EUR')
    expect(await rpc('public.reminder_mark_dispatch($1,$2)', [claimed.id, claimed.lease_token]))
      .toMatchObject({ ok: false, reason: 'schedule_disabled' })
    // a lease that expired during prepare loses the fence entirely
    await saveReport(A1, scheduleId, 'Майский отчёт', 12, true, OLD, 'EUR')
    expect(await plan('2028-06-12')).toBe(1)
    const [june] = await claim('2028-06-12T05:00:00Z')
    await db.query(`update public.reminder_occurrences set lease_until = now() - interval '1 minute' where id = $1`, [june.id])
    expect(await rpc('public.reminder_freeze_source($1,$2)', [june.id, june.lease_token]))
      .toMatchObject({ ok: false, reason: 'lease_lost' })
    await saveReport(A1, scheduleId, 'Майский отчёт', 12, false, OLD, 'EUR')
  })

  test('set-period validates the CALENDAR month and stays tenant-scoped', async () => {
    expect(await rpc('public.margin_registry_set_period($1,$2,$3)', [A1, SHA_A, '2026-13']))
      .toMatchObject({ ok: false, reason: 'bad_period' })
    expect(await rpc('public.margin_registry_set_period($1,$2,$3)', [A1, 'nope', '2026-04']))
      .toMatchObject({ ok: false, reason: 'bad_sha' })
    expect(await rpc('public.margin_registry_set_period($1,$2,$3)', [A2, SHA_A, '2026-04']))
      .toMatchObject({ ok: false, reason: 'not_found' }) // A1's file is invisible to A2
  })

  test('freeze NEVER crosses tenants: another account’s newer matching-period file is invisible', async () => {
    const shaMineOld = 'a1'.repeat(32)
    const shaTheirsNew = 'a2'.repeat(32)
    await seedSource(A1, shaMineOld, 'мой-старый.xlsx', '2028-07-01T10:00:00Z', '2028-07')
    await seedSource(A2, shaTheirsNew, 'чужой-новый.xlsx', '2028-07-25T10:00:00Z', '2028-07')
    const saved = await saveReport(A1, null, 'Июльский отчёт', 3, true, OLD, 'UZS')
    const scheduleId = scheduleIdOf(saved)
    expect(await plan('2028-07-03')).toBe(1)
    const [claimed] = await claim('2028-07-03T05:00:00Z')
    // A2's newer file matches the period — and must lose to A1's own OLDER file
    expect(await rpc('public.reminder_freeze_source($1,$2)', [claimed.id, claimed.lease_token]))
      .toMatchObject({ ok: true, file_sha256: shaMineOld, file_name: 'мой-старый.xlsx' })
    expect(await rpc('public.reminder_finish($1,$2,$3,$4,$5)', [claimed.id, claimed.lease_token, 'skipped', null, 'test_done'])).toBe(true)
    await saveReport(A1, scheduleId, 'Июльский отчёт', 3, false, OLD, 'UZS') // out of the way for August
    // a month where ONLY the other tenant has files is an EMPTY month here
    const saved2 = await saveReport(A1, null, 'Августовский отчёт', 4, true, OLD, 'UZS')
    await seedSource(A2, 'a3'.repeat(32), 'чужой-август.xlsx', '2028-08-01T10:00:00Z', '2028-08')
    expect(await plan('2028-08-04')).toBe(1)
    const [aug] = await claim('2028-08-04T05:00:00Z')
    expect(await rpc('public.reminder_freeze_source($1,$2)', [aug.id, aug.lease_token]))
      .toMatchObject({ ok: false, reason: 'source_missing_period' })
    expect(await rpc('public.reminder_finish($1,$2,$3,$4,$5)', [aug.id, aug.lease_token, 'failed', null, 'source_missing_period'])).toBe(true)
    await saveReport(A1, scheduleIdOf(saved2), 'Августовский отчёт', 4, false, OLD, 'UZS')
  })

  test('registry RLS: the owner reads own rows; operator, forged identity and other tenants read none; writes refused', async () => {
    try {
      await db.exec(`select set_config('test.uid', '${USER1}', false); select set_config('test.account', '${A1}', false); set role authenticated;`)
      expect((await all(`select file_sha256 from public.margin_upload_registry`)).length).toBeGreaterThan(0)
      // an operator of the SAME account is not an owner/admin — the policy refuses
      await db.exec(`reset role; select set_config('test.uid', 'bbbbbbb3-bbbb-4bbb-8bbb-bbbbbbbbbbb3', false); select set_config('test.account', '${A1}', false); set role authenticated;`)
      expect(await all(`select file_sha256 from public.margin_upload_registry`)).toHaveLength(0)
      // a forged identity claiming A1's context is closed by the users-row check
      await db.exec(`reset role; select set_config('test.uid', '${USER2}', false); select set_config('test.account', '${A1}', false); set role authenticated;`)
      expect(await all(`select file_sha256 from public.margin_upload_registry`)).toHaveLength(0)
      await expect(db.query(`insert into public.margin_upload_registry (account_id, file_sha256, file_name) values ('${A1}', '${'9'.repeat(64)}', 'x')`))
        .rejects.toThrow(/permission denied/)
    } finally {
      await db.exec(`reset role;`)
    }
  })

  test('recreated and new functions are service-role only — for EVERY current signature', async () => {
    try {
      await db.exec(`select set_config('test.uid', '${USER1}', false); select set_config('test.account', '${A1}', false); set role authenticated;`)
      await expect(db.query(`select public.reminder_save_schedule('${A1}', null, 'x', 1, 0, false, now(), 'reminder', null)`))
        .rejects.toThrow(/permission denied/)
      await expect(db.query(`select * from public.reminder_claim_due(now(), '2026-01-01', 1, 60)`))
        .rejects.toThrow(/permission denied/)
      await expect(db.query(`select public.reminder_freeze_source('${A1}', '${A1}')`))
        .rejects.toThrow(/permission denied/)
      await expect(db.query(`select public.margin_registry_set_period('${A1}', '${SHA_A}', '2026-04')`))
        .rejects.toThrow(/permission denied/)
    } finally {
      await db.exec(`reset role;`)
    }
  })
})

describe('RLS', () => {
  test('owner reads own rows; forged cross-tenant identity reads nothing; direct writes are revoked', async () => {
    const saved = await saveSchedule(A1, null, 'RLS-строка', 11, 540, true, OLD)
    const scheduleId = scheduleIdOf(saved)
    try {
      await db.exec(`select set_config('test.uid', '${USER1}', false); select set_config('test.account', '${A1}', false); set role authenticated;`)
      expect((await all(`select id from public.reminder_schedules`)).length).toBeGreaterThan(0)
      // USER2 belongs to A2; even claiming A1's context, the users-row check closes the door
      await db.exec(`reset role; select set_config('test.uid', '${USER2}', false); select set_config('test.account', '${A1}', false); set role authenticated;`)
      expect(await all(`select id from public.reminder_schedules`)).toHaveLength(0)
      expect(await all(`select id from public.reminder_occurrences`)).toHaveLength(0)
      await expect(db.query(`insert into public.reminder_schedules (account_id, title, day_of_month) values ('${A1}', 'x', 1)`))
        .rejects.toThrow(/permission denied/)
    } finally {
      await db.exec(`reset role;`)
    }
    await disable(scheduleId)
  })
})
