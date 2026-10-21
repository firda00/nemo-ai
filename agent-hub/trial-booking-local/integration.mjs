import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { writeFileSync, chmodSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTrialBookingClient } from '../../src/lib/trialBookingClient.ts';
import { localStatus, directory, apiUrl } from './setup.mjs';
import { snapshot } from './source-version.mjs';

const evidence = { environment: 'isolated-local-supabase', api: apiUrl, timezone: 'Asia/Tashkent', modelCalls: 0, mocks: false, startedAt: new Date().toISOString(), tests: [] };
const source = snapshot();
const receiptDir = resolve(directory, process.argv.includes('--model-stage') ? '../artifacts/trial-booking-model-loop' : '../artifacts/trial-booking-acceptance');
mkdirSync(receiptDir, { recursive: true });
writeFileSync(resolve(receiptDir, `source-${source.sourceSha256}.json`), JSON.stringify(source, null, 2));
evidence.sourceSha256 = source.sourceSha256;
evidence.git = source.git;
let config;
function save() {
  evidence.counts = { planned: 21, executed: evidence.tests.length, passed: evidence.tests.filter(t => t.status === 'passed').length, failed: evidence.tests.filter(t => t.status === 'failed').length, skipped: 21 - evidence.tests.length };
  writeFileSync(resolve(directory, 'results.json'), JSON.stringify(evidence, null, 2) + '\n');
}
async function http(path, method, body, key = config.SERVICE_ROLE_KEY, bearer = key) {
  const response = await fetch(`${apiUrl}${path}`, { method, redirect: 'error', headers: { apikey: key, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`LOCAL_HTTP_${response.status}_${path.split('?')[0]}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
async function test(name, fn) {
  try { await fn(); evidence.tests.push({ name, status: 'passed' }); }
  catch (error) { evidence.tests.push({ name, status: 'failed', error: String(error.message).slice(0, 240) }); }
  save();
}
function localSql(sql) {
  localStatus();
  const result = spawnSync('docker', ['exec', '-i', 'supabase_db_nemo-trial-booking-local', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], { input: sql, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('LOCAL_FIXTURE_SQL_FAILED');
  return result.stdout.trim();
}
function saveLocalLogins(users, password) {
  const path = resolve(directory, 'local-login.json');
  writeFileSync(path, JSON.stringify({ environment: 'synthetic-local-only', url: 'http://127.0.0.1:55439/auth', users: Object.keys(users).map(role => ({ role, email: `${role.toLowerCase()}@trial-booking.test`, password })) }, null, 2) + '\n', { mode: 0o600 });
  try {
    if (process.platform === 'win32') {
      const identity = spawnSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
      const sid = identity.stdout?.match(/S-1-\d+(?:-\d+)+/)?.[0];
      if (identity.status !== 0 || !sid) throw new Error('LOCAL_CREDENTIAL_FILE_ACL_FAILED');
      const acl = spawnSync('icacls', [path, '/inheritance:r', '/grant:r', `*${sid}:(F)`], { encoding: 'utf8', windowsHide: true });
      if (acl.status !== 0) throw new Error('LOCAL_CREDENTIAL_FILE_ACL_FAILED');
    } else chmodSync(path, 0o600);
  } catch { unlinkSync(path); throw new Error('LOCAL_CREDENTIAL_FILE_ACL_FAILED'); }
}
try {
  config = localStatus();
  const authSettings = await http('/auth/v1/settings', 'GET', undefined, config.ANON_KEY);
  evidence.authSettings = { emailProviderEnabled: authSettings.external?.email, disableSignup: authSettings.disable_signup };
  assert.equal(authSettings.external?.email, true, 'local email/password provider must be enabled');
  assert.equal(authSettings.disable_signup, true, 'public signup must remain disabled');
  const password = `Local-only-${randomUUID()}!`;
  const auth = {};
  for (const role of ['ownerA', 'operatorA', 'viewerA', 'ownerB']) {
    const email = `${role.toLowerCase()}@trial-booking.test`;
    // Synthetic organizations are already configured; retain the actual app's onboarding guard.
    const user = await http('/auth/v1/admin/users', 'POST', { email, password, email_confirm: true, user_metadata: { onboarding_completed: true, lang: 'en' } });
    const login = await http('/auth/v1/token?grant_type=password', 'POST', { email, password }, config.ANON_KEY);
    const rows = await http(`/rest/v1/users?id=eq.${user.id}&select=account_id`, 'GET');
    auth[role] = { id: user.id, token: login.access_token, originalAccount: rows[0].account_id };
  }
  const accountA = auth.ownerA.originalAccount, accountB = auth.ownerB.originalAccount;
  for (const [name, role] of [['operatorA', 'operator'], ['viewerA', 'viewer']]) {
    await http(`/rest/v1/users?id=eq.${auth[name].id}`, 'PATCH', { account_id: accountA, role });
    await http(`/rest/v1/accounts?id=eq.${auth[name].originalAccount}`, 'DELETE');
  }
  for (const [account, label] of [[accountA, 'Synthetic school A'], [accountB, 'Synthetic school B']]) await http(`/rest/v1/accounts?id=eq.${account}`, 'PATCH', { name: label });
  saveLocalLogins(auth, password);
  const courseA = randomUUID(), courseB = randomUUID();
  await http('/rest/v1/trial_courses', 'POST', [{ id: courseA, account_id: accountA, name: 'Synthetic English' }, { id: courseB, account_id: accountB, name: 'Synthetic Mathematics' }]);
  const sessions = {};
  const tomorrow = new Date(); tomorrow.setUTCDate(tomorrow.getUTCDate() + 7); tomorrow.setUTCHours(10, 0, 0, 0);
  const rows = ['free', 'last', 'full', 'cancelled', 'foreign', 'duplicates'].map((name, index) => {
    const id = randomUUID(); sessions[name] = id;
    return { id, account_id: name === 'foreign' ? accountB : accountA, course_id: name === 'foreign' ? courseB : courseA, starts_at: new Date(tomorrow.getTime() + index * 3600000).toISOString(), timezone: 'Asia/Tashkent', capacity: name === 'free' || name === 'duplicates' ? 8 : 1, status: name === 'cancelled' ? 'cancelled' : 'scheduled' };
  });
  await http('/rest/v1/trial_sessions', 'POST', rows);
  const client = (who, accountId = accountA) => createTrialBookingClient({ url: apiUrl, apiKey: config.ANON_KEY, accessToken: auth[who].token, accountId });
  const owner = client('ownerA'), operator = client('operatorA'), viewer = client('viewerA'), other = client('ownerB', accountB);
  const request = (session, key = randomUUID()) => operator.request(sessions[session], key, 'Synthetic learner');
  async function approved(session) { const op = await request(session); await owner.decide(op.operation_id, 'approve'); return op; }
  const full = await approved('full'); await operator.execute(full.operation_id);
  evidence.seed = { organizations: 2, users: 4, courses: 2, sessions: 6, states: ['free', 'last-seat', 'full', 'cancelled', 'foreign'], relativeSchedule: 'seven days after seed, 15:00 Asia/Tashkent onward', preparation: 'real GoTrue admin + password login and service-role REST fixture writes; application requests use user JWTs' };
  await test('schedule is tenant scoped', async () => { const schedule = await operator.schedule(); assert.ok(JSON.stringify(schedule).includes(sessions.free)); assert.ok(!JSON.stringify(schedule).includes(sessions.foreign)); });
  await test('successful approval, booking and persisted readback', async () => { const op = await approved('free'); await operator.execute(op.operation_id); const stored = await operator.result(op.operation_id); assert.ok(stored.booking_id); assert.equal(stored.status, 'completed'); });
  await test('execution before approval is denied', async () => { const op = await request('free'); await assert.rejects(() => operator.execute(op.operation_id)); assert.ok(!(await operator.result(op.operation_id)).booking_id); });
  await test('generic outbox consumer cannot claim internal trial booking', async () => { const op = await approved('free'); const claimed = await http('/rest/v1/rpc/runtime_claim_outbox_actions', 'POST', { p_worker_id: 'synthetic-local-probe', p_lease_duration_seconds: 30, p_limit: 100, p_connector_id: null }); assert.ok(!claimed.some(item => item.workflow_id === op.operation_id)); assert.ok(!(await operator.result(op.operation_id)).booking_id); });
  await test('rejected approval cannot execute', async () => { const op = await request('free'); await owner.decide(op.operation_id, 'reject'); await assert.rejects(() => operator.execute(op.operation_id)); assert.equal((await operator.result(op.operation_id)).booking_id, null); });
  await test('viewer cannot request or approve', async () => { await assert.rejects(() => viewer.request(sessions.free, randomUUID(), 'Synthetic learner')); const op = await request('free'); await assert.rejects(() => viewer.decide(op.operation_id, 'approve')); });
  await test('operator cannot approve', async () => { const op = await request('free'); await assert.rejects(() => operator.decide(op.operation_id, 'approve')); });
  await test('foreign account and session denied', async () => { await assert.rejects(() => client('operatorA', accountB).schedule()); await assert.rejects(() => operator.request(sessions.foreign, randomUUID(), 'Synthetic learner')); const op = await request('free'); await assert.rejects(() => other.result(op.operation_id)); });
  await test('cancelled request and full execution rejected', async () => { await assert.rejects(() => request('cancelled')); const op = await approved('full'); await assert.rejects(() => operator.execute(op.operation_id)); assert.ok(!(await operator.result(op.operation_id)).booking_id); });
  await test('immutable request parameters on retry', async () => { const key = randomUUID(); await request('free', key); await assert.rejects(() => operator.request(sessions.last, key, 'Changed learner')); });
  await test('repeat execution preserves identical persisted booking', async () => { const op = await approved('free'); await operator.execute(op.operation_id); const first = await operator.result(op.operation_id); await operator.execute(op.operation_id); const second = await operator.result(op.operation_id); assert.ok(first.booking_id); assert.equal(first.booking_id, second.booking_id); });
  await test('response discarded after commit recovers existing operation', async () => { const key = randomUUID(); const op = await request('free', key); await owner.decide(op.operation_id, 'approve'); await operator.execute(op.operation_id); /* Intentionally discard successful HTTP response. */ const recovered = await client('operatorA').recover(key); assert.equal(recovered.operation_id, op.operation_id); assert.ok(recovered.booking_id); const again = await request('free', key); assert.equal(again.operation_id, op.operation_id); assert.equal((await operator.result(op.operation_id)).booking_id, recovered.booking_id); });
  await test('two distinct concurrent operations last seat exactly one booking', async () => { const [a, b] = await Promise.all([approved('last'), approved('last')]); const attempts = await Promise.allSettled([operator.execute(a.operation_id), operator.execute(b.operation_id)]); const saved = await Promise.all([operator.result(a.operation_id), operator.result(b.operation_id)]); assert.equal(saved.filter(row => row.booking_id).length, 1); assert.equal(attempts.filter(row => row.status === 'fulfilled').length, 1); });
  await test('eight concurrent retries of same operation one booking', async () => { const op = await approved('duplicates'); await Promise.all(Array.from({ length: 8 }, () => operator.execute(op.operation_id))); const saved = await operator.result(op.operation_id); assert.ok(saved.booking_id); const stored = await http(`/rest/v1/bookings?trial_operation_id=eq.${op.operation_id}&select=id`, 'GET'); assert.equal(stored.length, 1); assert.equal(stored[0].id, saved.booking_id); });
  await test('mandatory audit failure rolls back booking and completion atomically', async () => {
    const op = await approved('free');
    localSql("create function runtime.local_trial_audit_failure() returns trigger language plpgsql as $$ begin if new.event_type='trial.booking_created' then raise exception 'SYNTHETIC_AUDIT_UNAVAILABLE'; end if; return new; end $$; create trigger local_trial_audit_failure before insert on runtime.audit_events for each row execute function runtime.local_trial_audit_failure();");
    try { await assert.rejects(() => operator.execute(op.operation_id)); const stored = await operator.result(op.operation_id); assert.ok(!stored.booking_id); assert.notEqual(stored.status, 'completed'); assert.equal((await http(`/rest/v1/bookings?trial_operation_id=eq.${op.operation_id}&select=id`, 'GET')).length, 0); }
    finally { localSql('drop trigger local_trial_audit_failure on runtime.audit_events; drop function runtime.local_trial_audit_failure();'); }
    await operator.execute(op.operation_id); assert.ok((await operator.result(op.operation_id)).booking_id);
  });
  await test('mandatory action audit exists exactly once for completed operation', async () => { const op = await approved('free'); await operator.execute(op.operation_id); await operator.execute(op.operation_id); assert.equal(localSql(`select count(*) from runtime.audit_events where workflow_id='${op.operation_id}' and event_type='trial.booking_created';`), '1'); });
  await test('changed session after approval prevents stale booking', async () => { const op = await approved('free'); await http(`/rest/v1/trial_sessions?id=eq.${sessions.free}`, 'PATCH', { status: 'cancelled' }); try { await assert.rejects(() => operator.execute(op.operation_id)); assert.ok(!(await operator.result(op.operation_id)).booking_id); } finally { await http(`/rest/v1/trial_sessions?id=eq.${sessions.free}`, 'PATCH', { status: 'scheduled' }); } });
  await test('unavailable local transport produces no confirmation and recovery finds same operation', async () => {
    const key = randomUUID(), op = await request('free', key);
    const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve));
    const disconnected = createTrialBookingClient({ url: `http://127.0.0.1:${port}`, apiKey: config.ANON_KEY, accessToken: auth.operatorA.token, accountId: accountA });
    await assert.rejects(() => disconnected.execute(op.operation_id)); assert.equal((await operator.recover(key)).operation_id, op.operation_id); assert.ok(!(await operator.result(op.operation_id)).booking_id);
  });
  await test('revoked requester rights checked again before execution', async () => { const op = await approved('free'); await http(`/rest/v1/users?id=eq.${auth.operatorA.id}`, 'PATCH', { role: 'viewer' }); try { await assert.rejects(() => operator.execute(op.operation_id)); } finally { await http(`/rest/v1/users?id=eq.${auth.operatorA.id}`, 'PATCH', { role: 'operator' }); } });
  await test('unauthenticated JWT rejected', async () => { const invalid = createTrialBookingClient({ url: apiUrl, apiKey: config.ANON_KEY, accessToken: 'invalid', accountId: accountA }); await assert.rejects(() => invalid.schedule()); });
  await test('blocked account and production-e2e guard remain enforced', async () => {
    await http(`/rest/v1/accounts?id=eq.${accountA}`, 'PATCH', { blocked: true });
    try { await assert.rejects(() => operator.schedule()); } finally { await http(`/rest/v1/accounts?id=eq.${accountA}`, 'PATCH', { blocked: false }); }
    await http(`/rest/v1/accounts?id=eq.${accountA}`, 'PATCH', { is_production_e2e: true });
    try { await assert.rejects(() => request('free')); } finally { await http(`/rest/v1/accounts?id=eq.${accountA}`, 'PATCH', { is_production_e2e: false }); }
  });
  evidence.status = evidence.tests.every(item => item.status === 'passed') ? 'passed' : 'failed';
} catch (error) {
  evidence.status = config ? 'failed' : 'blocked';
  evidence.blocker = String(error.message).slice(0, 240);
}
evidence.finishedAt = new Date().toISOString();
try {
  evidence.sourceUnchanged = snapshot().sourceSha256 === evidence.sourceSha256;
  if (!evidence.sourceUnchanged) { evidence.status = 'failed'; evidence.sourceError = 'SOURCE_CHANGED_DURING_RUN'; }
} catch {
  evidence.sourceUnchanged = false; evidence.status = 'failed'; evidence.sourceError = 'SOURCE_SNAPSHOT_FAILED';
}
save();
console.log(JSON.stringify(evidence, null, 2));
if (evidence.status !== 'passed') process.exitCode = 1;
