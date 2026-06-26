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

// Verify Stripe's `t=...,v1=...` signature: HMAC-SHA256 of `${t}.${payload}`.
async function verify(payload: string, header: string, secret: string): Promise<boolean> {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')))
  const t = parts['t']
  const sig = parts['v1']
  if (!t || !sig) return false
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

  let event: { type?: string; data?: { object?: Record<string, unknown> } }
  try {
    event = JSON.parse(payload)
  } catch {
    return new Response('bad json', { status: 400 })
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data?.object ?? {}
    // deno-lint-ignore no-explicit-any
    const meta = (session as any).metadata ?? {}
    const accountId = meta.account_id
    const tokens = Number(meta.tokens ?? 0)
    if (accountId && tokens > 0) {
      const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
      await admin.rpc('add_token_balance', { p_account: accountId, p_amount: tokens })
    }
  }

  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
})
