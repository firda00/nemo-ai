import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const directory = dirname(fileURLToPath(import.meta.url));
export const root = resolve(directory, '../..');
export const projectId = 'nemo-trial-booking-local';
export const apiUrl = 'http://127.0.0.1:55431';
export function cli(args) {
  const entry = resolve(root, 'node_modules/supabase/dist/supabase.js');
  return spawnSync(process.execPath, [entry, ...args, '--workdir', directory], { encoding: 'utf8', timeout: 600000, windowsHide: true });
}
export function localStatus() {
  const result = cli(['status', '-o', 'json']);
  if (result.status !== 0) throw new Error('LOCAL_ENVIRONMENT_UNAVAILABLE: start the isolated Supabase project first.');
  const status = JSON.parse(result.stdout);
  if (status.API_URL !== apiUrl) throw new Error('LOCAL_URL_MISMATCH');
  if (!status.ANON_KEY || !status.SERVICE_ROLE_KEY) throw new Error('LOCAL_AUTH_KEYS_UNAVAILABLE');
  return status; // Never write this object to logs: keys stay in process memory.
}
export function prepare() {
  const names = [
    '20260624090000_init.sql',
    '20260627160000_account_blocked.sql',
    '20260709040000_bookings.sql',
    '20260803110000_owner_approval_queue.sql',
    '20260803160000_production_test_account.sql',
    '20260824120000_durable_runtime_phase1.sql',
    '20260824140000_durable_runtime_phase2_rpc.sql',
    '20260908120000_trial_booking.sql',
  ];
  mkdirSync(resolve(directory, 'supabase/migrations'), { recursive: true });
  for (const name of names) {
    const source = resolve(root, 'supabase/migrations', name);
    if (!existsSync(source)) throw new Error(`MIGRATION_UNAVAILABLE: ${name}`);
    copyFileSync(source, resolve(directory, 'supabase/migrations', name));
  }
  writeFileSync(resolve(directory, 'migration-manifest.json'), JSON.stringify({ source: 'existing repository migrations plus trial booking migration; exact copies', migrations: names }, null, 2) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2] || 'prepare';
  if (!['prepare', 'start', 'reset', 'stop'].includes(action)) throw new Error('Use prepare|start|reset|stop');
  if (action !== 'stop') prepare();
  if (action === 'prepare') console.log('Isolated project prepared; no database was contacted.');
  else {
    if (action === 'reset') localStatus();
    const args = action === 'start' ? ['start', '-x', 'studio,imgproxy,edge-runtime,logflare,vector,supavisor'] : action === 'reset' ? ['db', 'reset', '--local', '--no-seed'] : ['stop', '--no-backup'];
    const result = cli(args);
    if (result.status === 0 && ['reset', 'stop'].includes(action)) {
      const localLogin = resolve(directory, 'local-login.json');
      if (existsSync(localLogin)) unlinkSync(localLogin);
    }
    // CLI can print local keys and database URLs. Do not relay raw output.
    console.log(JSON.stringify({ action, projectId, success: result.status === 0, exitCode: result.status, error: result.error?.code || null }));
    if (result.status !== 0) {
      const diagnostic = String(result.stderr || result.stdout);
      if (/docker|daemon|pipe/i.test(diagnostic)) console.error('LOCAL_ENVIRONMENT_UNAVAILABLE: Docker engine or required containers unavailable.');
      else console.error('LOCAL_SETUP_FAILED: inspect via npm run safe:exec -- supabase ... using this workdir.');
      process.exitCode = 1;
    }
  }
}
