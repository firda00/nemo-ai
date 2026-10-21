// Preparation only by default. Run ONLY after a separately recorded owner approval.
import { openSync, writeFileSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createTrialBookingClient } from '../src/lib/trialBookingClient.ts';

const plan = {
  provider: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions',
  requestedModel: 'openai/gpt-4o-mini', upstream: 'openai', maxRequests: 2,
  maxSerializedPromptBytes: 16000, conservativeInputTokensPerRequest: 20000,
  maxOutputTokensPerRequest: 512, inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.60,
  conservativeTokenCostUsd: 0.0066144, proposedOwnerCeilingUsd: 5,
  automaticRetries: 0, modelFallbacks: false, providerFallbacks: false,
  scope: 'real model response + local authenticated schedule read only; not full LLM booking E2E',
};
if (!process.argv.includes('--execute-approved')) {
  console.log(JSON.stringify({ status: 'NOT_EXECUTED_REQUIRES_OWNER_APPROVAL', ...plan }, null, 2));
} else {
  // Never set these on the owner's behalf during preparation. No env-file loading.
  if (process.env.NEMO_TRIAL_MODEL_APPROVAL !== 'owner-approved-one-probe-up-to-5-usd') throw new Error('OWNER_APPROVAL_REQUIRED');
  if (!process.env.OPENROUTER_API_KEY) throw new Error('EXISTING_OPENROUTER_KEY_REQUIRED');
  const client = createTrialBookingClient({
    url: process.env.NEMO_TRIAL_LOCAL_URL ?? '', apiKey: process.env.NEMO_TRIAL_LOCAL_ANON ?? '',
    accessToken: process.env.NEMO_TRIAL_LOCAL_JWT ?? '', accountId: process.env.NEMO_TRIAL_LOCAL_ACCOUNT ?? '',
    signal: AbortSignal.timeout(120000),
  });
  // Refuse repeated runs, including after a timeout/unknown billing outcome.
  const evidencePath = new URL('./trial-booking-model-probe-result.json', import.meta.url);
  const fd = openSync(evidencePath, 'wx');
  const evidence = { ...plan, status: 'started', calls: [], scheduleRows: 0 };
  const save = () => writeFileSync(fd, JSON.stringify(evidence, null, 2));
  // A fixed descriptor would append unless explicitly rewritten; use path after exclusive creation.
  const persist = () => writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  save(); closeSync(fd);
  const tools = [{ type: 'function', function: { name: 'read_trial_schedule', description: 'Read authorized synthetic local lesson availability', parameters: { type: 'object', properties: {}, additionalProperties: false } } }];
  const messages = [{ role: 'user', content: 'Read the trial lesson schedule using the tool. Summarize available lessons. Do not create a booking or claim approval.' }];
  try {
    // Local auth readiness before spending. The later tool invocation still executes a fresh read.
    await client.schedule();
    for (let index = 0; index < plan.maxRequests; index++) {
      if (Buffer.byteLength(JSON.stringify({ messages, tools })) > plan.maxSerializedPromptBytes) throw new Error('PROMPT_LIMIT');
      const record = { requestedModel: plan.requestedModel, actualModel: null, upstream: null, status: 'sent_or_unknown', maxReservedUsd: 0.0033072 };
      evidence.calls.push(record); persist();
      const response = await fetch(plan.endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: plan.requestedModel, messages, tools, max_tokens: 512, temperature: 0,
          tool_choice: index === 0 ? { type: 'function', function: { name: 'read_trial_schedule' } } : 'none',
          provider: { only: ['openai'], allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0.15, completion: 0.60 } },
        }),
      });
      if (!response.ok) { record.status = `http_${response.status}`; throw new Error('PROVIDER_REJECTED'); }
      const body = await response.json();
      record.actualModel = typeof body.model === 'string' ? body.model : null;
      record.upstream = typeof body.provider === 'string' ? body.provider : null;
      record.status = 'received';
      record.usage = { prompt_tokens: body.usage?.prompt_tokens, completion_tokens: body.usage?.completion_tokens, cost: body.usage?.cost };
      persist();
      if (record.actualModel !== plan.requestedModel || record.upstream?.toLowerCase() !== 'openai') throw new Error('MODEL_OR_PROVIDER_NOT_VERIFIED');
      const message = body.choices?.[0]?.message;
      if (index === 0) {
        const calls = message?.tool_calls;
        if (calls?.length !== 1 || calls[0].function?.name !== 'read_trial_schedule' || JSON.stringify(JSON.parse(calls[0].function.arguments)) !== '{}') throw new Error('UNEXPECTED_TOOL_CALL');
        record.tool = { name: 'read_trial_schedule', count: 1 };
        const rows = await client.schedule(); evidence.scheduleRows = rows.length;
        // Only allowlisted synthetic lesson metadata, no user/customer fields.
        const safeRows = rows.slice(0, 10).map(({ id, starts_at, timezone, available, status }) => ({ id, starts_at, timezone, available, status }));
        record.tool.resultSha256 = createHash('sha256').update(JSON.stringify(safeRows)).digest('hex');
        messages.push(message, { role: 'tool', tool_call_id: calls[0].id, content: JSON.stringify(safeRows) });
      } else {
        if (typeof message?.content !== 'string' || !message.content.trim() || message.tool_calls?.length) throw new Error('NO_FINAL_TEXT');
        record.answer = { characters: message.content.length, sha256: createHash('sha256').update(message.content).digest('hex') };
      }
    }
    evidence.status = 'model_and_local_read_verified';
  } catch (error) { evidence.status = 'failed_or_unknown'; evidence.error = error instanceof Error ? error.message : 'FAILED'; process.exitCode = 1; }
  finally { persist(); console.log(JSON.stringify({ status: evidence.status, requests: evidence.calls.length })); }
}
