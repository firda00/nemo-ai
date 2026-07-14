// amoCRM lead creation via the API v4 (BYO long-lived token). The key is stored as
// "subdomain|token" (e.g. "mycompany|eyJ0eXAi..."). Creates a lead + a contact in one call.
export async function amoCreateLead(subdomain: string, token: string, lead: { name?: string; phone?: string; email?: string; note?: string }): Promise<{ ok: boolean; id?: number; error?: string }> {
  try {
    const sub = String(subdomain).replace(/^https?:\/\//, '').replace(/\.amocrm\.(ru|com)$/i, '').replace(/\/.*$/, '').trim()
    if (!sub) return { ok: false, error: 'Не указан поддомен amoCRM.' }
    const name = String(lead.name ?? '').slice(0, 120), phone = String(lead.phone ?? ''), email = String(lead.email ?? '')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfv: any[] = []
    if (phone) cfv.push({ field_code: 'PHONE', values: [{ value: phone, enum_code: 'WORK' }] })
    if (email) cfv.push({ field_code: 'EMAIL', values: [{ value: email, enum_code: 'WORK' }] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contact: any = { name: name || phone || 'Клиент' }
    if (cfv.length) contact.custom_fields_values = cfv
    const payload = [{ name: `Nemo: ${name || phone || 'лид'}`, _embedded: { contacts: [contact] } }]
    const r = await fetch(`https://${sub}.amocrm.ru/api/v4/leads/complex`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      // hard timeout well below the 10-minute CRM-push claim lease
      signal: AbortSignal.timeout(10_000),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d: any = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, error: `amoCRM отклонил (${d?.[0]?.detail ?? d?.detail ?? d?.title ?? r.status}). Проверьте поддомен и токен.` }
    const id = Array.isArray(d) ? d?.[0]?.id : d?.id
    return id ? { ok: true, id } : { ok: false, error: 'amoCRM: лид не создан.' }
  } catch (e) { return { ok: false, error: String(e).slice(0, 150) } }
}
