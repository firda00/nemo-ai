// Create a Stripe Checkout Session for a token package (USD). Authenticated.
// Uses the Stripe REST API directly (no SDK). On success Stripe redirects back
// and the `stripe-webhook` function credits the tokens.
//
//   POST /functions/v1/create-checkout   (Authorization: Bearer <user jwt>)
//   body { "package": "starter" | "pro" | "business" }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')!

// keep in sync with src/data/billing.ts
export const PACKAGES: Record<string, { usd: number; tokens: number }> = {
  starter: { usd: 5, tokens: 250_000 },
  pro: { usd: 20, tokens: 1_200_000 },
  business: { usd: 50, tokens: 3_500_000 },
}

function form(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const {
    data: { user },
  } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)

  const { package: pkgId } = await req.json().catch(() => ({}))
  const pkg = PACKAGES[String(pkgId)]
  if (!pkg) return json({ error: 'invalid package' }, 400)

  const { data: prof } = await userDb.from('users').select('account_id').single()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)

  const origin = req.headers.get('origin') || 'http://localhost:5173'
  const body = form({
    mode: 'payment',
    success_url: `${origin}/app/billing?paid=1`,
    cancel_url: `${origin}/app/billing`,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(pkg.usd * 100),
    'line_items[0][price_data][product_data][name]': `Nemo AI — ${pkg.tokens.toLocaleString('en-US')} tokens`,
    'metadata[account_id]': accountId,
    'metadata[tokens]': String(pkg.tokens),
    'metadata[package]': String(pkgId),
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
