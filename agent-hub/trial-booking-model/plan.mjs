// Public catalogue lookup only. Never reads a provider key or calls a model.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function verifyModelEndpoint() {
  const response = await fetch('https://openrouter.ai/api/v1/models/openai/gpt-4o-mini/endpoints', { redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('MODEL_CATALOG_UNAVAILABLE');
  const payload = await response.json();
  const endpoint = payload.data?.endpoints?.find(row => row.tag === 'openai');
  const prices = endpoint?.pricing;
  if (prices && ['input_cache_read', 'input_cache_write'].some(k => prices[k] != null && (!Number.isFinite(Number(prices[k])) || Number(prices[k]) < 0 || Number(prices[k]) > 0.00000015))) throw new Error('MODEL_CACHE_PRICE_NOT_VERIFIED');
  if (!prices || !['prompt', 'completion'].every(k => prices[k] !== null && prices[k] !== undefined && Number.isFinite(Number(prices[k])) && Number(prices[k]) >= 0)
    || Object.entries(prices).some(([key, value]) => !['prompt', 'completion', 'input_cache_read', 'input_cache_write', 'discount'].includes(key) && Number(value) !== 0)) throw new Error('MODEL_PRICING_NOT_VERIFIED');
  if (!endpoint || endpoint.model_id !== 'openai/gpt-4o-mini' || !['tools', 'tool_choice', 'max_tokens'].every(p => endpoint.supported_parameters?.includes(p)) || Number(endpoint.pricing?.prompt) > 0.00000015 || Number(endpoint.pricing?.completion) > 0.00000060 || !Number.isFinite(Number(endpoint.pricing?.prompt)) || !Number.isFinite(Number(endpoint.pricing?.completion))) throw new Error('MODEL_PRICE_OR_TOOLS_NOT_VERIFIED');
  return { checkedAt: new Date().toISOString(), requestedModel: endpoint.model_id, provider: endpoint.tag, inputUsdPerMillion: Number(endpoint.pricing.prompt) * 1e6, outputUsdPerMillion: Number(endpoint.pricing.completion) * 1e6, toolsSupported: true, maximumRequests: 40, maximumInputTokensPerRequest: 20000, maximumOutputTokensPerRequest: 512, maximumTokenCostUsd: 0.132288, liveAcceptance: 'NOT_EXECUTED_OWNER_APPROVAL_REQUIRED', source: 'https://openrouter.ai/api/v1/models/openai/gpt-4o-mini/endpoints' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await verifyModelEndpoint(), null, 2));
