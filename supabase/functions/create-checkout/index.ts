// Create a Stripe Checkout Session for a token package (USD). Authenticated.
// Uses the Stripe REST API directly (no SDK). On success Stripe redirects back
// and the `stripe-webhook` function credits the tokens.
//
//   POST /functions/v1/create-checkout   (Authorization: Bearer <user jwt>)
//   body { "package": "starter" | "pro" | "business" }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { PLAN_LIMITS } from '../_shared/plans.ts'
import { corsPreflight, json, trustedAppOrigin } from '../_shared/cors.ts'
import { blocksExternalActions, PRODUCTION_E2E_EXTERNAL_BLOCK } from '../_shared/productionE2E.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')!

// Credits (1 credit = 1000 LLM tokens). keep in sync with src/data/billing.ts
export const PACKAGES: Record<string, { usd: number; tokens: number }> = {
  dabbler: { usd: 10, tokens: 2_500 },
  starter: { usd: 25, tokens: 7_000 },
  popular: { usd: 50, tokens: 15_000 },
  pro: { usd: 100, tokens: 32_000 },
  business: { usd: 250, tokens: 87_500 },
}
// custom top-up base rate ($1 = 250 credits) + bounds — keep in sync with src/data/billing.ts
const USD_TO_TOKENS = 250
const CUSTOM_MIN_USD = 5
const CUSTOM_MAX_USD = 1000

function form(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const {
    data: { user },
  } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)

  const { package: pkgId, usd: customUsd, plan: planId } = await req.json().catch(() => ({}))

  const { data: prof0 } = await userDb.from('users').select('account_id').maybeSingle()
  const accountId0 = prof0?.account_id
  if (!accountId0) return json({ error: 'no account' }, 403)
  if (await blocksExternalActions(userDb, accountId0)) return json(PRODUCTION_E2E_EXTERNAL_BLOCK, 403)
  const origin0 = trustedAppOrigin(req)

  // SUBSCRIPTION — a Nemo plan. Recurring payment to Nemo's Stripe; the webhook sets the
  // account's plan. Inline price_data (recurring) means no pre-created Price IDs needed.
  if (planId != null && planId !== '') {
    const plan = PLAN_LIMITS[String(planId)]
    if (!plan || plan.price <= 0) return json({ error: 'invalid plan' }, 400)
    const subBody = form({
      mode: 'subscription',
      success_url: `${origin0}/app/billing?upgraded=${planId}`,
      cancel_url: `${origin0}/app/billing`,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(plan.price * 100),
      'line_items[0][price_data][recurring][interval]': 'month',
      'line_items[0][price_data][product_data][name]': `Nemo AI — ${plan.label}`,
      'metadata[account_id]': accountId0,
      'metadata[plan]': String(planId),
      'subscription_data[metadata][account_id]': accountId0,
      'subscription_data[metadata][plan]': String(planId),
      client_reference_id: accountId0,
    })
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: subBody })
    const d = await r.json()
    if (!r.ok) { console.error('stripe error:', d); return json({ error: 'stripe_error', detail: d?.error?.message }, 502) }
    return json({ ok: true, url: d.url })
  }

  // Resolve amount + tokens SERVER-SIDE (never trust a client-supplied token count).
  let usd: number
  let tokens: number
  let productName: string
  if (pkgId != null && pkgId !== '') {
    const pkg = PACKAGES[String(pkgId)]
    if (!pkg) return json({ error: 'invalid package' }, 400)
    usd = pkg.usd
    tokens = pkg.tokens
    productName = `Nemo AI — ${pkg.tokens.toLocaleString('en-US')} tokens`
  } else {
    const n = Math.round(Number(customUsd))
    if (!Number.isFinite(n) || n < CUSTOM_MIN_USD || n > CUSTOM_MAX_USD) return json({ error: 'invalid amount' }, 400)
    usd = n
    tokens = n * USD_TO_TOKENS
    productName = `Nemo AI — $${n} top up (${tokens.toLocaleString('en-US')} tokens)`
  }

  const { data: prof } = await userDb.from('users').select('account_id').maybeSingle()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)

  const origin = trustedAppOrigin(req)
  const body = form({
    mode: 'payment',
    success_url: `${origin}/app/billing?paid=1`,
    cancel_url: `${origin}/app/billing`,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(usd * 100),
    'line_items[0][price_data][product_data][name]': productName,
    'metadata[account_id]': accountId,
    'metadata[tokens]': String(tokens),
    'metadata[package]': String(pkgId ?? 'custom'),
    client_reference_id: accountId,
  })

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })
  const data = await res.json()
  if (!res.ok) {
    console.error('stripe error:', data)
    return json({ error: 'stripe_error', detail: data?.error?.message }, 502)
  }
  return json({ ok: true, url: data.url })
})
