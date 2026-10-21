// Reuse the project's existing server key without copying other environment settings.
import { loadLocalEnv } from '../load-local-env.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function existingOpenRouterKey(root) {
  if (process.env.OPENROUTER_API_KEY?.trim()) return process.env.OPENROUTER_API_KEY.trim();
  const values = {};
  loadLocalEnv(root, values);
  return String(values.OPENROUTER_API_KEY ?? '').trim();
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify({ existingOpenRouterKeyPresent: Boolean(existingOpenRouterKey(process.cwd())), paidCalls: 0 }));
