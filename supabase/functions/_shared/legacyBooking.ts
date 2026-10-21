// Legacy free-form bookings must never bypass the capacity/approval-backed trial workflow.
// Scope comes from server account context and canonical configuration, not model text or flags.
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface LegacyBookingOutcome { ok: boolean; result: string }

export async function guardLegacyBooking(db: any, accountId: string): Promise<LegacyBookingOutcome | null> {
  if (!accountId) return { ok: false, result: 'Аккаунт недоступен. Запись не создана.' }
  try {
    // A session has a same-account course FK, so a configured course covers both cases.
    // Check every course, including courses whose sessions are full/cancelled or not yet published.
    const { data, error } = await db.from('trial_courses').select('id, account_id')
      .eq('account_id', accountId).limit(1).maybeSingle()
    if (error || (data !== null && (!data || typeof data.id !== 'string' || data.account_id !== accountId))) {
      return { ok: false, result: 'Не удалось проверить правила записи. Запись не создана; повторите проверку расписания.' }
    }
    if (data) return { ok: false, result: 'Запись не создана. Для этой организации используйте расписание пробных занятий: выберите занятие, получите согласование владельца и прочитайте сохранённый результат записи.' }
    return null
  } catch {
    return { ok: false, result: 'Не удалось проверить правила записи. Запись не создана; повторите проверку расписания.' }
  }
}

export async function executeLegacyBooking(args: any, db: any, accountId: string, dialogueId?: string): Promise<LegacyBookingOutcome> {
  const blocked = await guardLegacyBooking(db, accountId)
  if (blocked) return blocked
  const iso = String(args?.datetime_iso ?? '')
  const at = iso && !isNaN(Date.parse(iso)) ? new Date(iso).toISOString() : null
  if (!at) return { ok: false, result: `Уточните, пожалуйста, точную дату и время${args?.datetime_text ? ` («${String(args.datetime_text).slice(0, 60)}» не удалось распознать)` : ''}, и я оформлю запись.` }
  const { error } = await db.from('bookings').insert({
    account_id: accountId, dialogue_id: dialogueId ?? null,
    customer_name: String(args?.name ?? '') || null, phone: String(args?.phone ?? '') || null,
    service: String(args?.service ?? '') || null, scheduled_at: at, scheduled_text: String(args?.datetime_text ?? '') || null,
    notes: String(args?.notes ?? '') || null,
  })
  if (error) return { ok: false, result: 'Не удалось сохранить запись. Подтверждения записи нет.' }
  return { ok: true, result: `Запись создана: ${[args?.service, args?.datetime_text].filter(Boolean).join(' — ')}${args?.name ? ' для ' + args.name : ''}.` }
}
