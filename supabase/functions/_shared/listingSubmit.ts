// Отправка карточки на модерацию: решение и объяснение.
//
// Самой отправки здесь нет — она в commerce-control, где есть сеть и ключ. Здесь то, что решает,
// стоит ли пытаться, и то, что владелец прочитает про исход. Обе части чистые и проверяются
// построчно, потому что именно они врут заметнее всего: отказ, объяснённый неверно, отправляет
// продавца чинить не то.
//
// ПОЧЕМУ ЭТО НАПИСАНО РАНЬШЕ ОТПРАВКИ. Внешние адреса создания товара Uzum закрывает 403 для
// ключа продавца — проверено на боевом ключе: 200 на маршрутах чтения, 403 на девяти адресах
// создания. Контур вокруг отправки заведён заранее, чтобы первые же попытки — когда доступ
// появится — уже попадали в журнал. Журнал, дописанный после, не помнит первых попыток, а
// разбирают обычно именно их.

export type SubmitMode = 'auto' | 'manual'
export type SubmitTransport = 'uzum_api' | 'extension'
export type SubmitStatus = 'refused' | 'failed' | 'sent'

/** Причина машинным словом. По ней считается статистика, не разбирая текст сообщения. */
export type RefusalReason =
  | 'not_owner'
  | 'not_ready'
  | 'incomplete'
  | 'already_submitted'
  | 'subscription_locked'
  | 'no_key'
  | 'no_write_access'
  | 'provider_rejected'
  | 'provider_unavailable'

export interface DraftForSubmit {
  status: string
  title_ru: string | null
  title_uz: string | null
  uzum_category: string | null
  missing: unknown[]
}

export type SubmitDecision =
  | { attempt: true }
  | { attempt: false; reason: RefusalReason }

/**
 * Стоит ли вообще пытаться отправить.
 *
 * Порядок проверок — не вкусовщина. Сначала то, что владелец не может исправить в карточке
 * (права, подписка), потом то, что может (готовность, пропуски). Иначе он услышит «заполните
 * категорию», исправит её и упрётся в замок подписки, о котором ему не сказали сразу.
 */
export function decideSubmit(input: {
  draft: DraftForSubmit | null
  isOwner: boolean
  entitled: boolean
}): SubmitDecision {
  if (!input.isOwner) return { attempt: false, reason: 'not_owner' }
  if (!input.entitled) return { attempt: false, reason: 'subscription_locked' }
  if (!input.draft) return { attempt: false, reason: 'not_ready' }
  // Уже отправленную карточку второй раз не отправляем: на площадке появился бы дубль, и
  // разбирать его пришлось бы вручную в чужом кабинете.
  if (input.draft.status === 'submitted') return { attempt: false, reason: 'already_submitted' }
  // Отправлять можно только то, что владелец одобрил. 'draft' — это ещё черновик, даже в
  // «Полной автономии»: автономия решает, КОГДА отправить одобренное, а не отменяет одобрение.
  if (input.draft.status !== 'ready') return { attempt: false, reason: 'not_ready' }
  // Карточка без названия или категории не пройдёт модерацию, и отправлять её значит потратить
  // сутки ожидания на предсказуемый отказ.
  const hasTitle = Boolean((input.draft.title_ru ?? '').trim() || (input.draft.title_uz ?? '').trim())
  if (!hasTitle || !(input.draft.uzum_category ?? '').trim()) return { attempt: false, reason: 'incomplete' }
  if (Array.isArray(input.draft.missing) && input.draft.missing.length) return { attempt: false, reason: 'incomplete' }
  return { attempt: true }
}

/**
 * Что ответ площадки означает для нас.
 *
 * 403 отделён от прочих отказов намеренно. Это не поломка и не ошибка владельца: площадка не
 * даёт ключу права создавать товары. Владелец, которому показали «ошибка 403», идёт проверять
 * свой интернет; владелец, которому назвали причину, идёт в поддержку Uzum за правами.
 */
export function classifyProviderResponse(httpStatus: number): { status: SubmitStatus; reason: RefusalReason } {
  if (httpStatus >= 200 && httpStatus < 300) return { status: 'sent', reason: 'provider_rejected' }
  if (httpStatus === 401 || httpStatus === 403) return { status: 'refused', reason: 'no_write_access' }
  // Сеть отвалилась или площадка легла — повторить имеет смысл, и это надо сказать иначе, чем
  // «отказано»: отказ владелец воспринимает как приговор карточке.
  if (httpStatus === 0 || httpStatus === 429 || httpStatus >= 500) return { status: 'failed', reason: 'provider_unavailable' }
  return { status: 'failed', reason: 'provider_rejected' }
}

/**
 * Объяснение для владельца. Три языка: он читает по-русски, по-узбекски или по-английски.
 *
 * Каждая строка обязана называть СЛЕДУЮЩИЙ ШАГ. «Не удалось отправить» — это не сообщение, а
 * извинение: прочитав его, продавец не знает, чинить ему карточку, подписку или ничего.
 */
export const SUBMIT_MESSAGES: Record<RefusalReason, { ru: string; uz: string; en: string }> = {
  not_owner: {
    ru: 'Отправлять карточки на модерацию может только владелец аккаунта.',
    uz: 'Kartochkalarni moderatsiyaga faqat hisob egasi yubora oladi.',
    en: 'Only the account owner can send listings to moderation.',
  },
  not_ready: {
    ru: 'Черновик ещё не одобрен. Проверьте карточку и нажмите «Готово» — после этого её можно отправлять.',
    uz: 'Qoralama hali tasdiqlanmagan. Kartochkani tekshiring va «Tayyor» tugmasini bosing.',
    en: 'The draft is not approved yet. Check the listing and mark it ready first.',
  },
  incomplete: {
    ru: 'В карточке не хватает названия, категории или обязательных характеристик — Uzum отклонит её на модерации.',
    uz: 'Kartochkada nom, turkum yoki majburiy xususiyatlar yetishmaydi — Uzum uni moderatsiyada rad etadi.',
    en: 'The listing is missing a title, a category, or required attributes — Uzum would reject it in moderation.',
  },
  already_submitted: {
    ru: 'Эта карточка уже отправлена на модерацию. Повторная отправка создала бы дубль в кабинете.',
    uz: 'Bu kartochka allaqachon moderatsiyaga yuborilgan. Qayta yuborish kabinetda dublikat yaratadi.',
    en: 'This listing is already in moderation. Sending it again would create a duplicate.',
  },
  subscription_locked: {
    ru: 'Подписка неактивна, поэтому новые действия ИИ приостановлены. Данные и карточки остаются доступными.',
    uz: 'Obuna faol emas, shuning uchun sun’iy intellektning yangi amallari to‘xtatilgan. Ma’lumotlar ochiq qoladi.',
    en: 'The subscription is inactive, so new AI actions are paused. Your data and listings stay available.',
  },
  no_key: {
    ru: 'Ключ Uzum не подключён. Добавьте его в разделе интеграций — без него отправлять некуда.',
    uz: 'Uzum kaliti ulanmagan. Uni integratsiyalar bo‘limida qo‘shing.',
    en: 'The Uzum key is not connected. Add it in integrations first.',
  },
  // Самое важное сообщение здесь. Оно объясняет ровно то, что мы проверили на боевом ключе, и
  // отправляет владельца туда, где это решается, — а решается это не у нас.
  no_write_access: {
    ru: 'Uzum не даёт вашему ключу продавца создавать товары: адреса создания закрыты на стороне площадки (403), хотя чтение каталога работает. Запросите в поддержке Uzum доступ на запись товаров для API-ключа — до этого карточку придётся переносить в кабинет вручную, кнопками копирования.',
    uz: 'Uzum sizning sotuvchi kalitingizga tovar yaratishga ruxsat bermayapti: yaratish manzillari platforma tomonidan yopiq (403), katalogni o‘qish esa ishlaydi. Uzum qo‘llab-quvvatlash xizmatidan API kalit uchun yozish huquqini so‘rang.',
    en: 'Uzum does not let your seller key create products: the creation endpoints are closed on their side (403), while catalogue reads work. Ask Uzum support to grant product-write access for your API key.',
  },
  provider_rejected: {
    ru: 'Uzum отклонил карточку. Точный ответ площадки сохранён в журнале отправок — по нему видно, какое поле её не устроило.',
    uz: 'Uzum kartochkani rad etdi. Platformaning aniq javobi yuborishlar jurnalida saqlangan.',
    en: 'Uzum rejected the listing. Their exact response is stored in the submission log.',
  },
  provider_unavailable: {
    ru: 'Uzum сейчас не отвечает. Карточка цела, отправку можно повторить — это не отказ, а недоступность площадки.',
    uz: 'Uzum hozir javob bermayapti. Kartochka joyida, yuborishni qayta urinib ko‘rish mumkin.',
    en: 'Uzum is not responding right now. The listing is intact — this is downtime, not a rejection.',
  },
}

export function ownerMessage(reason: RefusalReason, lang: string): string {
  const block = SUBMIT_MESSAGES[reason] ?? SUBMIT_MESSAGES.provider_rejected
  return block[(lang === 'uz' || lang === 'en' ? lang : 'ru') as 'ru' | 'uz' | 'en']
}

/** Можно ли пробовать ещё раз. Недоступность площадки — да; отсутствие прав — нет. */
export function retryable(reason: RefusalReason): boolean {
  return reason === 'provider_unavailable'
}
