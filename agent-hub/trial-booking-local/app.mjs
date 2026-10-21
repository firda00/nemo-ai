import { createServer } from 'vite';
import { localStatus, root, apiUrl } from './setup.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTrialChatMiddleware } from '../trial-booking-model/chat-server.mjs';
import { existingOpenRouterKey } from '../trial-booking-model/existing-key.mjs';

export async function startTrialApp({ modelChat = false, modelCall, dataDir = resolve(root, 'agent-hub/trial-booking-local/.data/model-chat'), approved = false, providerKey = '' } = {}) {
  const local = localStatus();
  for (const name of Object.keys(process.env)) if (name.startsWith('VITE_')) delete process.env[name];
  process.env.VITE_SUPABASE_URL = apiUrl;
  process.env.VITE_SUPABASE_ANON_KEY = local.ANON_KEY;
  process.env.VITE_API_GATEWAY_URL = `${apiUrl}/functions/v1`;
  if (modelChat) process.env.VITE_TRIAL_MODEL_CHAT = '1';
  const middleware = createTrialChatMiddleware({ local, dataDir, approved, providerKey, modelCall });
  const server = await createServer({ root, envFile: false, envDir: false,
    plugins: [{ name: 'isolated-trial-model-chat', configureServer: server => { server.middlewares.use(middleware); } }],
    server: { host: '127.0.0.1', port: 55439, strictPort: true, open: false,
      // Evidence and disposable database files are not app source. On Windows,
      // writing receipts can otherwise crash the watcher with EBUSY.
      watch: { ignored: ['**/agent-hub/artifacts/**', '**/agent-hub/trial-booking-local/.data/**', '**/agent-hub/trial-booking-local/*results.json', '**/agent-hub/trial-booking-local/local-login.json'] },
      fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/agent-hub/**', '**/.secrets*', '**/credentials*'] },
    },
  });
  await server.listen();
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const approved = process.argv.includes('--owner-approved-model-package') && process.env.NEMO_TRIAL_MODEL_APPROVAL === 'owner-approved-trial-chat-40-requests';
  const server = await startTrialApp({ modelChat: process.argv.includes('--model-chat'), approved, providerKey: approved ? existingOpenRouterKey(root) : '' });
  console.log('Local NEMO ready: http://127.0.0.1:55439/auth — synthetic logins remain in the protected local fixture file.');
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, async () => { await server.close(); process.exit(0); });
}
