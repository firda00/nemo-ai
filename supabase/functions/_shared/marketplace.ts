// Marketplace seller-API helpers. Turns a stored seller key into agent-usable reads (catalog,
// orders) so a "marketplace" agent can answer about the store. Wildberries first (single-token API).
// NOTE: endpoints reflect WB's current public API; verify with a real seller token.

// List product cards (needs a token with the "Контент" scope).
export async function wbProducts(key: string, limit = 30): Promise<{ ok: boolean; result: string }> {
  try {
    const r = await fetch('https://content-api.wildberries.ru/content/v2/get/cards/list', {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { cursor: { limit: Math.min(Math.max(limit, 1), 100) }, filter: { withPhoto: -1 } } }),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d: any = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, result: `Wildberries отклонил (${d?.errorText ?? d?.detail ?? r.status}). Проверьте токен (нужен доступ «Контент»).` }
    const cards = d?.cards ?? []
    if (!cards.length) return { ok: true, result: 'В магазине Wildberries нет карточек товаров (или все скрыты).' }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lines = cards.slice(0, limit).map((c: any) => `• ${c?.title ?? c?.subjectName ?? 'без названия'} — арт. ${c?.vendorCode ?? c?.nmID ?? ''}${c?.brand ? ` (${c.brand})` : ''}`)
    return { ok: true, result: `Товары Wildberries (всего ${cards.length}):\n${lines.join('\n')}` }
  } catch (e) { return { ok: false, result: String(e).slice(0, 150) } }
}

// Count + list new FBS orders (needs a token with the "Маркетплейс" scope).
export async function wbOrders(key: string): Promise<{ ok: boolean; result: string }> {
  try {
    const r = await fetch('https://marketplace-api.wildberries.ru/api/v3/orders/new', { headers: { Authorization: key } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d: any = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, result: `Wildberries отклонил (${d?.errorText ?? d?.detail ?? r.status}). Проверьте токен (нужен доступ «Маркетплейс»).` }
    const orders = d?.orders ?? []
    if (!orders.length) return { ok: true, result: 'Новых заказов на Wildberries нет.' }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lines = orders.slice(0, 15).map((o: any) => `• заказ ${o?.id ?? ''} · арт. ${o?.article ?? ''}${o?.salePrice ? ` · ${Math.round(o.salePrice / 100)}₽` : ''}`)
    return { ok: true, result: `Новых заказов Wildberries: ${orders.length}.\n${lines.join('\n')}` }
  } catch (e) { return { ok: false, result: String(e).slice(0, 150) } }
}

// ---- Ozon (needs two values: Client-Id + Api-Key; stored as "clientId|apiKey") ----
export async function ozonProducts(clientId: string, apiKey: string, limit = 30): Promise<{ ok: boolean; result: string }> {
  try {
    const H = { 'Client-Id': clientId, 'Api-Key': apiKey, 'Content-Type': 'application/json' }
    const r = await fetch('https://api-seller.ozon.ru/v3/product/list', { method: 'POST', headers: H, body: JSON.stringify({ filter: {}, last_id: '', limit: Math.min(Math.max(limit, 1), 100) }) })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d: any = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, result: `Ozon отклонил (${d?.message ?? r.status}). Проверьте Client-Id и Api-Key.` }
    const items = d?.result?.items ?? []
    if (!items.length) return { ok: true, result: 'В магазине Ozon нет товаров.' }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lines = items.slice(0, limit).map((it: any) => `• арт. ${it?.offer_id ?? ''} (id ${it?.product_id ?? ''})`)
    return { ok: true, result: `Товары Ozon (всего ${d?.result?.total ?? items.length}):\n${lines.join('\n')}` }
  } catch (e) { return { ok: false, result: String(e).slice(0, 150) } }
}

export async function ozonOrders(clientId: string, apiKey: string): Promise<{ ok: boolean; result: string }> {
  try {
    const H = { 'Client-Id': clientId, 'Api-Key': apiKey, 'Content-Type': 'application/json' }
    const r = await fetch('https://api-seller.ozon.ru/v3/posting/fbs/unfulfilled/list', {
      method: 'POST', headers: H,
      body: JSON.stringify({ dir: 'ASC', filter: { cutoff_from: '2020-01-01T00:00:00Z', cutoff_to: '2035-01-01T00:00:00Z' }, limit: 50, offset: 0, with: {} }),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d: any = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, result: `Ozon отклонил (${d?.message ?? r.status}). Проверьте Client-Id и Api-Key.` }
    const postings = d?.result?.postings ?? []
    const count = d?.result?.count ?? postings.length
    if (!count) return { ok: true, result: 'Необработанных заказов на Ozon нет.' }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lines = postings.slice(0, 10).map((p: any) => `• отправление ${p?.posting_number ?? ''}`)
    return { ok: true, result: `Необработанных заказов Ozon: ${count}.\n${lines.join('\n')}` }
  } catch (e) { return { ok: false, result: String(e).slice(0, 150) } }
}

