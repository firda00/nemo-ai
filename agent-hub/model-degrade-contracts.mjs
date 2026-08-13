// Model degrade chain.
//
// A live Telegram request died with:
//   OpenRouter 429: google/gemma-4-31b-it:free is temporarily rate-limited upstream.
//                   Please retry shortly, or add your own key
//
// The chain was [requested, FALLBACK_MODEL] and FALLBACK_MODEL is a `:free` tier — so the safety
// net was the least reliable component in the system, and there was no retry at all even though
// the provider's own error says to retry. One upstream hiccup became total silence for the owner.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const llm = read('supabase/functions/_shared/llm.ts')
const tgProcess = read('supabase/functions/_shared/tgProcess.ts')

// A paid, reliable model must sit between the request and the free tier.
assert.match(llm, /if \(PRIMARY_MODEL !== opts\.model\) chain\.push\(PRIMARY_MODEL\)/,
  'the reliable primary must be in the chain before the free fallback')
assert.match(llm, /if \(opts\.fallbackModel && !chain\.includes\(opts\.fallbackModel\)\) chain\.push\(opts\.fallbackModel\)/,
  'the free fallback must be last, not second')
assert.match(llm, /export const FALLBACK_MODEL = .*:free/, 'the free tier is still the last resort — that is fine, as long as it is last')

// A transient upstream error must be retried, not turned into silence.
assert.match(llm, /isTransientModelError/, 'transient errors must be classified')
const classifier = llm.match(/export function isTransientModelError[\s\S]*?\n\}/)
assert.ok(classifier, 'the transient-error classifier must be a named, reviewable function')
for (const code of ['429', '503', '504']) {
  assert.ok(new RegExp(code).test(classifier[0]), `${code} must count as retryable`)
}
assert.match(llm, /attempt === 0 && isTransientModelError\(e\)/, 'one retry per model on transient failures')
assert.match(llm, /RETRY_DELAY_MS/, 'the retry must wait, not hammer the provider')
assert.match(llm, /const breakerUntil = new Map<string, number>\(\)/, 'circuit state must not be global across models')
assert.match(llm, /breakerKey = `\$\{opts\.apiKey\}:\$\{opts\.model\}`/, 'circuit state must be isolated by credential and model')
assert.match(llm, /breakerUntil\.delete\(breakerKey\)/, 'a successful model call must reset only its own circuit')
assert.doesNotMatch(llm, /let breakerUntil = 0/, 'one failed model must not open a global circuit that blocks fallbacks')

// Every model in the chain gets its own attempt; a single throw must not end the request.
const loop = llm.match(/for \(const model of chain\)[\s\S]*?throw lastError/)
assert.ok(loop, 'the chain must be walked in a loop')
assert.match(loop[0], /for \(let attempt = 0; attempt < 2; attempt\+\+\)/)

// And when everything really fails, the owner must be told what happened.
assert.match(tgProcess, /diag\.ownerContext \? ownerReason\(diag\) : WAIT_LINE/,
  'the owner sees the cause; customers still get the graceful handoff')
assert.match(tgProcess, /message_type: 'system_trace'/, 'the cause must be persisted, not only sent to Telegram')

console.log('Model degrade contracts passed.')
