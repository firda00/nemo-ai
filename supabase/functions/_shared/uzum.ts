// Official Uzum Seller API, read-only executor.
// The token is supplied by the account's encrypted provider_keys row and is
// deliberately never returned, logged, or placed in an LLM prompt.

const BASE_URL = 'https://api-seller.uzum.uz/api/seller-openapi'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

async function request(path: string, token: string): Promise<{ ok: boolean; data: Json; status: number }> {
  try {
    // Uzum's official OpenAPI specifies a raw token in Authorization — no Bearer prefix.
    const response = await fetch(`${BASE_URL}${path}`, {
      headers: { Authorization: token, Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    })
    const data = await response.json().catch(() => ({}))
    return { ok: response.ok, data, status: response.status }
  } catch {
    return { ok: false, data: {}, status: 0 }
  }
}

function errorMessage(data: Json, status: number): string {
  const detail = String(data?.message ?? data?.error?.message ?? data?.error ?? '').replace(/[\r\n]/g, ' ').slice(0, 140)
  return detail || (status ? `HTTP ${status}` : 'сеть недоступна')
}

function listOf(data: Json): Json[] {
  const candidate = data?.data ?? data?.result ?? data?.items ?? data?.content ?? data
  if (Array.isArray(candidate)) return candidate
  for (const key of ['shops', 'products', 'rows', 'list']) if (Array.isArray(candidate?.[key])) return candidate[key]
  return []
}

/** Minimal read-only smoke: lists the stores visible to the supplied seller token. */
export async function uzumShops(token: string): Promise<{ ok: boolean; result: string }> {
  const response = await request('/v1/shops', token)
  if (!response.ok) return { ok: false, result: `Uzum не принял ключ (${errorMessage(response.data, response.status)}).` }
  const shops = listOf(response.data)
  const names = shops.slice(0, 20).map((shop: Json) => String(shop?.name ?? shop?.title ?? shop?.shopName ?? shop?.id ?? 'магазин')).filter(Boolean)
  return { ok: true, result: names.length ? `Uzum подключён. Магазины: ${names.join(', ')}` : 'Uzum подключён. Доступ к магазину подтверждён.' }
}

/** Read product/SKU metadata for an explicitly selected seller shop. No mutations. */
export async function uzumProducts(token: string, shopId: string, limit = 30): Promise<{ ok: boolean; result: string }> {
  const id = String(shopId).trim()
  if (!/^\d{1,18}$/.test(id)) return { ok: false, result: 'Укажите числовой ID магазина Uzum.' }
  const response = await request(`/v1/product/shop/${encodeURIComponent(id)}`, token)
  if (!response.ok) return { ok: false, result: `Uzum не вернул товары (${errorMessage(response.data, response.status)}).` }
  const products = listOf(response.data).slice(0, Math.min(Math.max(limit, 1), 50))
  if (!products.length) return { ok: true, result: 'Uzum подключён, но товары для этого магазина не найдены.' }
  const lines = products.map((product: Json) => {
    const name = String(product?.name ?? product?.title ?? product?.productName ?? 'без названия').slice(0, 120)
    const sku = String(product?.sku ?? product?.sellerSku ?? product?.id ?? '').slice(0, 60)
    return `• ${name}${sku ? ` — SKU ${sku}` : ''}`
  })
  return { ok: true, result: `Товары Uzum (показано ${products.length}):\n${lines.join('\n')}` }
}
