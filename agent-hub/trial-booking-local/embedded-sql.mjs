// Supplemental embedded PostgreSQL only. Auth infrastructure is substituted here;
// this NEVER qualifies as real Supabase Auth/PostgREST integration or concurrency.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { root, directory, prepare } from './setup.mjs';
const db = new PGlite();
const report = { kind: 'embedded-postgresql-supplemental', substituted: ['Supabase auth.users/auth.uid infrastructure', 'pgcrypto digest wrapper uses PostgreSQL built-in sha256', 'realtime publication unavailable'], realAuthIntegration: false, concurrencyVerified: false, modelCalls: 0, tests: [] };
try {
  prepare();
  await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create schema extensions;
    create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
    create function extensions.digest(bytea,text) returns bytea language sql immutable as $$ select pg_catalog.sha256($1) $$;`);
  const manifest = JSON.parse(readFileSync(resolve(directory, 'migration-manifest.json'), 'utf8'));
  for (const name of manifest.migrations) {
    let sql = readFileSync(resolve(root, 'supabase/migrations', name), 'utf8');
    if (name === '20260624090000_init.sql') sql = sql.replace('create extension if not exists pgcrypto;', '').replace(/alter publication supabase_realtime add table public\.(messages|dialogues);/g, '');
    await db.exec(sql); report.tests.push({ name: `migration:${name}`, status: 'passed' });
  }
  const owner = '11111111-1111-4111-8111-111111111111', operator = '22222222-2222-4222-8222-222222222222';
  await db.query('insert into auth.users(id,email) values($1,$2),($3,$4)', [owner, 'owner@synthetic.test', operator, 'operator@synthetic.test']);
  const account = (await db.query('select account_id from public.users where id=$1', [owner])).rows[0].account_id;
  await db.query("update public.users set account_id=$1,role='operator' where id=$2", [account, operator]);
  const course = (await db.query("insert into public.trial_courses(account_id,name) values($1,'Synthetic') returning id", [account])).rows[0].id;
  const slot = (await db.query("insert into public.trial_sessions(account_id,course_id,starts_at,capacity) values($1,$2,now()+interval '7 days',1) returning id", [account, course])).rows[0].id;
  async function asUser(id, sql, args) { await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]); await db.exec('set role authenticated'); try { return (await db.query(sql, args)).rows[0]?.value; } finally { await db.exec('reset role'); } }
  const op = await asUser(operator, 'select public.trial_booking_request($1,$2,$3,$4) value', [account, slot, 'embedded-op-001', 'Synthetic learner']);
  assert.equal(op.status, 'waiting_for_approval');
  await assert.rejects(() => asUser(operator, 'select public.trial_booking_execute($1,$2) value', [account, op.operation_id]));
  await asUser(owner, 'select public.trial_booking_decide($1,$2,$3) value', [account, op.operation_id, 'approve']);
  assert.equal((await db.query("select * from public.runtime_claim_outbox_actions('embedded-worker',30,100,null)")).rows.length, 0);
  await asUser(operator, 'select public.trial_booking_execute($1,$2) value', [account, op.operation_id]);
  const saved = await asUser(operator, 'select public.trial_booking_result($1,$2) value', [account, op.operation_id]);
  assert.equal(saved.status, 'completed'); assert.ok(saved.booking_id);
  await asUser(operator, 'select public.trial_booking_execute($1,$2) value', [account, op.operation_id]);
  assert.equal((await db.query('select count(*)::int n from public.bookings where trial_operation_id=$1', [op.operation_id])).rows[0].n, 1);
  assert.equal((await db.query("select count(*)::int n from runtime.audit_events where workflow_id=$1 and event_type='trial.booking_created'", [op.operation_id])).rows[0].n, 1);
  report.tests.push({ name: 'request/approval/execution/readback/retry and mandatory audit (embedded SQL)', status: 'passed' });
  const second = await asUser(operator, 'select public.trial_booking_request($1,$2,$3,$4) value', [account, slot, 'embedded-op-002', 'Synthetic learner']);
  await asUser(owner, 'select public.trial_booking_decide($1,$2,$3) value', [account, second.operation_id, 'approve']);
  await assert.rejects(() => asUser(operator, 'select public.trial_booking_execute($1,$2) value', [account, second.operation_id]));
  assert.ok(!(await asUser(operator, 'select public.trial_booking_result($1,$2) value', [account, second.operation_id])).booking_id);
  report.tests.push({ name: 'full session refuses second booking (sequential, not concurrency)', status: 'passed' });
  await assert.rejects(() => asUser(operator, 'select public.trial_booking_request($1,$2,$3,$4) value', [account, slot, 'embedded-op-001', 'Changed learner']));
  await assert.rejects(() => asUser(operator, 'select public.trial_booking_decide($1,$2,$3) value', [account, second.operation_id, 'approve']));
  const denied = await asUser(operator, 'select public.trial_booking_request($1,$2,$3,$4) value', [account, slot, 'embedded-op-003', 'Synthetic learner']);
  await asUser(owner, 'select public.trial_booking_decide($1,$2,$3) value', [account, denied.operation_id, 'reject']);
  await assert.rejects(() => asUser(operator, 'select public.trial_booking_execute($1,$2) value', [account, denied.operation_id]));
  report.tests.push({ name: 'changed intent, unauthorized approval, rejected execution refused', status: 'passed' });
  await db.query('update public.trial_sessions set capacity=4 where id=$1', [slot]);
  await db.exec("create function runtime.embedded_audit_failure() returns trigger language plpgsql as $$ begin if new.event_type='trial.booking_created' then raise exception 'SYNTHETIC_AUDIT_FAILURE'; end if; return new; end $$; create trigger embedded_audit_failure before insert on runtime.audit_events for each row execute function runtime.embedded_audit_failure();");
  await assert.rejects(() => asUser(operator, 'select public.trial_booking_execute($1,$2) value', [account, second.operation_id]));
  assert.equal((await db.query('select count(*)::int n from public.bookings where trial_operation_id=$1', [second.operation_id])).rows[0].n, 0);
  assert.ok(!(await asUser(operator, 'select public.trial_booking_result($1,$2) value', [account, second.operation_id])).booking_id);
  await db.exec('drop trigger embedded_audit_failure on runtime.audit_events; drop function runtime.embedded_audit_failure();');
  report.tests.push({ name: 'mandatory audit insert failure rolls back booking and operation result', status: 'passed' });
  for (const flag of ['blocked', 'is_production_e2e']) {
    await db.query(`update public.accounts set ${flag}=true where id=$1`, [account]);
    await assert.rejects(() => asUser(operator, 'select public.trial_booking_schedule($1) value', [account]));
    await db.query(`update public.accounts set ${flag}=false where id=$1`, [account]);
  }
  report.tests.push({ name: 'blocked and production-e2e guards enforced', status: 'passed' });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, code: error.code, detail: error.detail, where: error.where, position: error.position, internalPosition: error.internalPosition, internalQuery: error.internalQuery }; }
await db.close();
writeFileSync(resolve(directory, 'embedded-results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'passed') process.exitCode = 1;

