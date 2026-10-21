// Genuine local Auth/PostgREST acceptance. No response mocks, model calls or resets.
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { createTrialBookingClient, createTrialSessionTokenProvider } from '../../src/lib/trialBookingClient.ts';
import { localStatus, apiUrl, directory } from './setup.mjs';
import { snapshot } from './source-version.mjs';
const report = { kind: 'real-local-auth-token-expiry', mocks: false, modelCalls: 0, checks: [], refreshRequests: 0 };
report.sourceSha256 = snapshot().sourceSha256;
let authClient;
try {
  const config = localStatus();
  const fixture = JSON.parse(readFileSync(resolve(directory, 'local-login.json'), 'utf8'));
  if (fixture.environment !== 'synthetic-local-only' || fixture.url !== 'http://127.0.0.1:55439/auth') throw new Error('FIXTURE_SCOPE_MISMATCH');
  if (!config.JWT_SECRET) throw new Error('LOCAL_SIGNING_KEY_UNAVAILABLE');
  // This observer passes every request to the real network. It never supplies a response.
  const observedFetch = (url, options) => {
    const target = new URL(String(url));
    if (target.origin !== apiUrl) throw new Error('NONLOCAL_AUTH_REQUEST');
    if (target.pathname.endsWith('/token') && target.searchParams.get('grant_type') === 'refresh_token') report.refreshRequests++;
    return fetch(url, { ...options, redirect: 'error' });
  };
  authClient = createClient(apiUrl, config.ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }, global: { fetch: observedFetch } });
  const credential = role => { const user = fixture.users.find(row => row.role === role); if (!user) throw new Error('FIXTURE_USER_MISSING'); return { email: user.email, password: user.password }; };
  const login = await authClient.auth.signInWithPassword(credential('operatorA'));
  if (login.error || !login.data.session) throw new Error('LOCAL_LOGIN_FAILED');
  const initial = login.data.session;
  const profile = await authClient.from('users').select('account_id').eq('id', initial.user.id).single();
  if (profile.error) throw new Error('LOCAL_PROFILE_FAILED');
  const getToken = createTrialSessionTokenProvider(authClient.auth, initial.user.id);
  const client = createTrialBookingClient({ url: apiUrl, apiKey: config.ANON_KEY, accountId: profile.data.account_id, getAccessToken: getToken });
  const slots = await client.schedule();
  const slot = slots.find(row => row.status === 'scheduled' && row.available > 1 && Date.parse(row.starts_at) > Date.now());
  if (!slot) throw new Error('NO_SYNTHETIC_FREE_SESSION');
  const operationKey = randomUUID();
  const operation = await client.request(slot.id, operationKey, 'Synthetic expiry acceptance');
  assert.equal(operation.status, 'waiting_for_approval');
  const claims = JSON.parse(Buffer.from(initial.access_token.split('.')[1], 'base64url').toString());
  const sign = exp => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ ...claims, iat: Math.floor(Date.now() / 1000) - 60, exp })).toString('base64url');
    return `${header}.${body}.${createHmac('sha256', config.JWT_SECRET).update(`${header}.${body}`).digest('base64url')}`;
  };
  // The same signed short-TTL fixture is valid first and expires during the wait.
  // We do not change server auth settings, the clock, or the GoTrue refresh token.
  const shortTtl = 5;
  const expiresAt = Math.floor(Date.now() / 1000) + shortTtl;
  const expiring = sign(expiresAt);
  const startedWaiting = Date.now();
  const verified = await fetch(`${apiUrl}/auth/v1/user`, { redirect: 'error', signal: AbortSignal.timeout(10000), headers: { apikey: config.ANON_KEY, Authorization: `Bearer ${expiring}` } });
  assert.equal(verified.status, 200);
  const readPending = (timeoutMs = 10000) => fetch(`${apiUrl}/rest/v1/rpc/trial_booking_result`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { apikey: config.ANON_KEY, Authorization: `Bearer ${expiring}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_account_id: profile.data.account_id, p_operation_id: operation.operation_id }) });
  const firstRead = await readPending();
  assert.equal(firstRead.status, 200);
  assert.equal((await firstRead.json()).status, 'waiting_for_approval');
  let finalStatus = 200, pollCount = 0, nextProgress = 30000;
  console.log('Token expiry acceptance: valid local JWT read pending operation; waiting for real server expiry.');
  while (Date.now() - startedWaiting < 120000) {
    await new Promise(resolveWait => setTimeout(resolveWait, Math.min(2000, 120000 - (Date.now() - startedWaiting))));
    const remaining = 120000 - (Date.now() - startedWaiting);
    if (remaining <= 0) break;
    const response = await readPending(Math.min(10000, remaining)); pollCount++;
    finalStatus = response.status;
    await response.arrayBuffer();
    if (finalStatus === 401) break;
    assert.equal(finalStatus, 200);
    const elapsed = Date.now() - startedWaiting;
    if (elapsed >= nextProgress) { console.log(`Token expiry acceptance: ${Math.floor(elapsed / 1000)} seconds elapsed; still waiting for server expiry tolerance.`); nextProgress += 30000; }
  }
  assert.equal(finalStatus, 401, 'SERVER_EXPIRY_NOT_OBSERVED_WITHIN_120_SECONDS');
  report.expiryObservation = { fixture: 'synthetic locally signed JWT preserving real session/user claims', configuredServerExpiryUnchanged: true, fixtureTtlSeconds: shortTtl, elapsedSeconds: Math.round((Date.now() - startedWaiting) / 1000), pollCount, initialAuthStatus: verified.status, initialPostgrestStatus: firstRead.status, finalPostgrestStatus: finalStatus, sameTokenThroughoutWait: true, operationStayedPending: true };
  report.checks.push('one short-TTL signed local JWT was accepted by Auth/PostgREST, then actually expired while awaiting approval and became 401');
  const refreshed = await authClient.auth.setSession({ access_token: expiring, refresh_token: initial.refresh_token });
  if (refreshed.error) throw new Error('REAL_REFRESH_FAILED');
  const recovered = await client.recover(operationKey);
  assert.equal(recovered.operation_id, operation.operation_id);
  assert.ok(!recovered.booking_id);
  assert.ok(report.refreshRequests > 0);
  const current = await authClient.auth.getSession();
  assert.equal(current.data.session.user.id, initial.user.id);
  assert.notEqual(current.data.session.access_token, expiring);
  report.checks.push('real refresh grant restores same user and existing operation without creating a booking');
  await authClient.auth.signOut({ scope: 'local' });
  await assert.rejects(() => client.result(operation.operation_id), /TRIAL_AUTH_REQUIRED/);
  const relogin = await authClient.auth.signInWithPassword(credential('operatorA'));
  if (relogin.error) throw new Error('LOCAL_RELOGIN_FAILED');
  assert.equal((await client.recover(operationKey)).operation_id, operation.operation_id);
  report.checks.push('missing session fails closed; same-user sign-in recovers persisted operation');
  const changed = await authClient.auth.signInWithPassword(credential('ownerB'));
  if (changed.error) throw new Error('LOCAL_USER_SWITCH_FAILED');
  await assert.rejects(() => client.result(operation.operation_id), /TRIAL_SESSION_CHANGED/);
  const foreign = createTrialBookingClient({ url: apiUrl, apiKey: config.ANON_KEY, accountId: profile.data.account_id, getAccessToken: createTrialSessionTokenProvider(authClient.auth, changed.data.user.id) });
  await assert.rejects(() => foreign.result(operation.operation_id), /TRIAL_REQUEST_FAILED_403/);
  report.checks.push('different signed-in user refused by pinned identity; real server independently denies foreign organization');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error.message).slice(0, 160); process.exitCode = 1; }
finally { await authClient?.auth.signOut({ scope: 'local' }); }
report.sourceSha256After = snapshot().sourceSha256;
if (report.sourceSha256 !== report.sourceSha256After) { report.status = 'failed'; report.error = 'SOURCE_CHANGED_DURING_RUN'; process.exitCode = 1; }
const evidenceDirectory = resolve(directory, '../artifacts/trial-booking-model-loop');
mkdirSync(evidenceDirectory, { recursive: true });
writeFileSync(resolve(evidenceDirectory, 'token-expiry-results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));

