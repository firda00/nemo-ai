// Stripe webhook — credits tokens after a successful payment. PUBLIC endpoint
// (Stripe can't send a Supabase JWT); authenticity is enforced by verifying the
// Stripe-Signature header against STRIPE_WEBHOOK_SECRET. Uses service_role to
// credit the account.
//
//   POST /functions/v1/stripe-webhook   (Stripe-Signature header)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? ''

const TOLERANCE_SECONDS = 300 // reject events whose timestamp is older/newer than 5 min (replay guard)

// Verify Stripe's `t=...,v1=...` signature: HMAC-SHA256 of `${t}.${payload}`,
// and enforce a timestamp tolerance so a captured signed payload cannot be replayed forever.
async function verify(payload: string, header: string, secret: string): Promise<boolean> {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')))
  const t = parts['t']
  const sig = parts['v1']
  if (!t || !sig) return false
  const ts = Number(t)
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SECONDS) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`))
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  // constant-ish time compare
  if (expected.length !== sig.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i)
  return diff === 0
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
  const sig = req.headers.get('Stripe-Signature')
  const payload = await req.text()
  if (!sig || !WEBHOOK_SECRET || !(await verify(payload, sig, WEBHOOK_SECRET))) {
    return new Response('invalid signature', { status: 400 })
  }

  let event: { id?: string; type?: string; data?: { object?: Record<string, unknown> } }
  try {
    event = JSON.parse(payload)
  } catch {
    return new Response('bad json', { status: 400 })
  }

  // Credit on a completed session OR a later async payment success (delayed methods).
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE)

    // Idempotency: record the event id first. add_token_balance is additive, so a
    // Stripe retry (or a replay within the tolerance window) must not credit twice.
    const eventId = String(event.id ?? '')
    if (eventId) {
      const { error: dupErr } = await admin.from('webhook_events').insert({ id: eventId, type: event.type })
      // Only a genuine unique-violation (already processed) skips crediting. Any
      // other error (e.g. table missing before migration) must NOT drop a
      // signature-verified payment, so we log and fall through to credit.
      if (dupErr?.code === '23505') {
        return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (dupErr) console.error('stripe-webhook idempotency insert failed:', dupErr)
    }

    const session = event.data?.object ?? {}
    // Only credit a session Stripe has actually collected money for. Delayed/async
    // payment methods can complete the session while still 'unpaid'; crediting then
    // would hand out tokens for a payment that may still fail. When the async payment
    // later succeeds, its own event ('async_payment_succeeded') arrives 'paid' and
    // credits then (a distinct event id, so idempotency stays correct).
    const paymentStatus = String((session as { payment_status?: string }).payment_status ?? 'paid')
    if (paymentStatus !== 'paid') {
      return new Response(JSON.stringify({ received: true, pending: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const meta = (session as { metadata?: Record<string, string | number | undefined> }).metadata ?? {}
    const accountId = meta.account_id
    const tokens = Number(meta.tokens ?? 0)
    if (accountId && tokens > 0) {
      await admin.rpc('add_token_balance', { p_account: accountId, p_amount: tokens })
    }
    // SUBSCRIPTION — activate the paid plan on the account
    const plan = meta.plan ? String(meta.plan) : ''
    if (accountId && ['starter', 'pro', 'business', 'agency', 'enterprise'].includes(plan)) {
      await admin.from('accounts').update({ plan }).eq('id', accountId)
    }
  }

  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
})
