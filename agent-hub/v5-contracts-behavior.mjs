// Контракты V5 и карточка лида в Telegram.
//
// ГЛАВНОЕ, что здесь защищается, — ЭКРАНИРОВАНИЕ. Всё содержимое карточки чужое: имя компании из
// справочника, боли и резюме от модели, расшифровавшей звонок. Отправляется оно с parse_mode: 'HTML',
// то есть Telegram разбирает его как разметку. Компания «Мебель < 5 дней» без экранирования даёт
// незакрытый тег и ответ 400 — карточка о горячем лиде не приходит ВООБЩЕ. Хуже другое: текст от модели
// может содержать <a href="...">, и в сообщении менеджеру появится ссылка, которую туда никто не ставил.
//
// Второе по важности — ГРАНИЦЫ ШКАЛ в CallAnalyticsSchema. Эти данные приходят от модели, то есть самые
// ненадёжные в системе: она охотно возвращает 240 из 100 и текст там, где ждали число.

import assert from 'node:assert/strict'
import {
  CRMOutboundPushPayloadSchema, CallAnalyticsSchema, E164, LeadCardNotificationSchema,
  SIPTrunkConfigSchema, UnifiedCRMEventSchema, crmIdempotencyKey, leadCardOutcome, parseContract,
} from './contracts/v5.ts'
import {
  CALLBACK_MANUAL_CALL, CALLBACK_SEND_OFFER, OUTCOME_LABELS, TelegramNotificationService,
  buildLeadCardButtons, escapeHtml, escapeMarkdownV2, parseCallbackData, renderLeadCard,
} from './telegram/bot-service.ts'
import {
  FOUND_LEAD_STYLE, deterministicUuid, isHotLead, leadToCardNotification, resolveLeadCardConfig,
  sendLeadCards,
} from './telegram/lead-card-bridge.ts'

let checks = 0
const check = (fn) => { fn(); checks++ }
const checkAsync = async (fn) => { await fn(); checks++ }

const UUID = '11111111-2222-3333-4444-555555555555'

// --- SIPTrunkConfigSchema -------------------------------------------------------------------------

const trunk = {
  id: UUID, tenant_id: UUID, trunk_type: 'CUSTOM_SIP', name: 'Основной',
  sip_host: 'sip.example.uz', auth_username: 'u', auth_password: 'p',
  outbound_caller_id: '+998712000000',
}

check(() => {
  const parsed = SIPTrunkConfigSchema.parse(trunk)
  // Значения по умолчанию из §3.1 должны появляться сами: транк без них не зарегистрируется у оператора.
  assert.equal(parsed.sip_port, 5060)
  assert.deepEqual(parsed.codecs, ['PCMU', 'PCMA', 'OPUS'])
  assert.equal(parsed.max_concurrent_channels, 5)
  assert.equal(parsed.status, 'ACTIVE')
})

// Номер вне E.164 не примет ни один оператор, и узнать об этом на первом исходящем звонке дороже, чем
// на проверке схемы.
check(() => assert.equal(SIPTrunkConfigSchema.safeParse({ ...trunk, outbound_caller_id: '8 (712) 200-00-00' }).success, false))
check(() => assert.equal(SIPTrunkConfigSchema.safeParse({ ...trunk, outbound_caller_id: '+0712000000' }).success, false, 'E.164 не допускает ведущий ноль'))
check(() => assert.equal(SIPTrunkConfigSchema.safeParse({ ...trunk, outbound_caller_id: '998712000000' }).success, true, 'плюс необязателен'))
check(() => assert.equal(E164.test('+998901112233'), true))
check(() => assert.equal(E164.test('+9989011122334455667788'), false, 'больше 15 цифр — не E.164'))

// Имя транка выбирают из списка при звонке: слишком короткое неотличимо от соседнего.
check(() => assert.equal(SIPTrunkConfigSchema.safeParse({ ...trunk, name: 'A' }).success, false))
check(() => assert.equal(SIPTrunkConfigSchema.safeParse({ ...trunk, name: 'я'.repeat(65) }).success, false))
// Неизвестный кодек означал бы тишину в трубке вместо голоса.
check(() => assert.equal(SIPTrunkConfigSchema.safeParse({ ...trunk, codecs: ['MP3'] }).success, false))
check(() => assert.equal(SIPTrunkConfigSchema.safeParse({ ...trunk, trunk_type: 'SIP' }).success, false))
// Ноль каналов = транк, по которому нельзя позвонить. Это не настройка, а ошибка.
check(() => assert.equal(SIPTrunkConfigSchema.safeParse({ ...trunk, max_concurrent_channels: 0 }).success, false))
check(() => assert.equal(SIPTrunkConfigSchema.safeParse({ ...trunk, max_concurrent_channels: 2.5 }).success, false))
check(() => assert.equal(SIPTrunkConfigSchema.safeParse({ ...trunk, id: 'не-uuid' }).success, false))

// --- CallAnalyticsSchema: границы шкал ------------------------------------------------------------

const analytics = {
  call_id: UUID, caller_phone: '+998901112233', duration_seconds: 245,
  call_outcome: 'INTERESTED_DEMO', overall_sentiment: 'VERY_POSITIVE',
  relationship_health_score: 82, lead_pain_points: ['теряют заявки вечером'],
  manager_coaching_feedback: { talk_to_listen_ratio: 0.8, objection_handling_score: 7, actionable_advice: 'Меньше говорить' },
  next_step: { action: 'SEND_TELEGRAM_NOTIFICATION', scheduled_at: null, notification_payload: 'карточка' },
}

check(() => assert.equal(CallAnalyticsSchema.safeParse(analytics).success, true))
// 240 из 100 доехало бы до экрана менеджера, если бы предел можно было пропустить.
check(() => assert.equal(CallAnalyticsSchema.safeParse({ ...analytics, relationship_health_score: 240 }).success, false))
check(() => assert.equal(CallAnalyticsSchema.safeParse({ ...analytics, relationship_health_score: -1 }).success, false))
check(() => assert.equal(CallAnalyticsSchema.safeParse({ ...analytics, relationship_health_score: 0 }).success, true, 'ноль — законная оценка'))
check(() => assert.equal(CallAnalyticsSchema.safeParse({ ...analytics, relationship_health_score: 100 }).success, true))
// Работа с возражениями по шкале 0–10, а не 0–100: модель регулярно путает шкалы между собой.
check(() => assert.equal(CallAnalyticsSchema.safeParse({
  ...analytics, manager_coaching_feedback: { ...analytics.manager_coaching_feedback, objection_handling_score: 85 },
}).success, false))
// Выдуманное моделью значение перечисления отсеивается: иначе оно доедет до отчётности как новая
// категория и испортит статистику.
check(() => assert.equal(CallAnalyticsSchema.safeParse({ ...analytics, call_outcome: 'ОЧЕНЬ_ЗАИНТЕРЕСОВАН' }).success, false))
check(() => assert.equal(CallAnalyticsSchema.safeParse({ ...analytics, overall_sentiment: 'СРЕДНЕ' }).success, false))
check(() => assert.equal(CallAnalyticsSchema.safeParse({ ...analytics, next_step: { ...analytics.next_step, action: 'ПОЗВОНИТЬ' } }).success, false))

// scheduled_at: nullable, а НЕ optional. «Перезвонить, но время не назначено» и «поле забыли» — разные
// случаи, и первый законен, второй должен быть отвергнут.
check(() => assert.equal(CallAnalyticsSchema.safeParse({
  ...analytics, next_step: { action: 'SCHEDULE_CALL', notification_payload: 'x' },
}).success, false, 'пропущенное поле — не то же, что null'))
check(() => assert.equal(CallAnalyticsSchema.safeParse({
  ...analytics, next_step: { ...analytics.next_step, scheduled_at: '2026-08-20T10:00:00Z' },
}).success, true))
check(() => assert.equal(CallAnalyticsSchema.safeParse({
  ...analytics, next_step: { ...analytics.next_step, scheduled_at: '20 августа' },
}).success, false, 'дата обязана быть машинной — по ней ставят напоминание'))
// Длительность в секундах целым числом: 245.7 означает, что кто-то отдал миллисекунды как секунды.
check(() => assert.equal(CallAnalyticsSchema.safeParse({ ...analytics, duration_seconds: 245.7 }).success, false))

// --- LeadCardNotificationSchema -------------------------------------------------------------------

const card = {
  callId: UUID, customerPhone: '+998901112233', leadName: 'Дента Люкс',
  outcome: 'INTERESTED_DEMO', rapportScore: 88, keyPains: ['нет онлайн-записи'],
  summaryText: 'Готовы к демо.', recordingUrl: 'https://rec.nemo.ai/a.mp3',
  recommendedAction: 'Отправить оффер',
}

check(() => assert.equal(LeadCardNotificationSchema.safeParse(card).success, true))
check(() => assert.equal(LeadCardNotificationSchema.safeParse({ ...card, leadName: undefined }).success, true, 'имени может не быть — холодный звонок по справочнику'))
check(() => assert.equal(LeadCardNotificationSchema.safeParse({ ...card, recordingUrl: undefined }).success, true, 'записи может не быть'))
check(() => assert.equal(LeadCardNotificationSchema.safeParse({ ...card, recordingUrl: 'не-адрес' }).success, false))
check(() => assert.equal(LeadCardNotificationSchema.safeParse({ ...card, rapportScore: 101 }).success, false))
// В карточке ЧЕТЫРЕ итога, в аналитике ПЯТЬ. WRONG_NUMBER сюда попасть не должен.
check(() => assert.equal(LeadCardNotificationSchema.safeParse({ ...card, outcome: 'WRONG_NUMBER' }).success, false))

// Карточка по ошибочному номеру — шум, который менеджер приучится пролистывать, а вместе с ним начнёт
// пролистывать и настоящие. Подставить сюда REJECTED было бы ложью в отчётности.
check(() => assert.equal(leadCardOutcome('WRONG_NUMBER'), null))
check(() => assert.equal(leadCardOutcome('REJECTED'), 'REJECTED'))
check(() => assert.equal(leadCardOutcome('INTERESTED_DEMO'), 'INTERESTED_DEMO'))

// --- UnifiedCRMEventSchema и CRMOutboundPushPayloadSchema -----------------------------------------

const event = {
  tenantId: UUID, provider: 'AMOCRM', eventType: 'DEAL_STAGE_CHANGED', externalDealId: '42',
  contactPhone: '+998901112233', pipelineId: '7', statusId: '13', occurredAt: '2026-08-17T10:00:00Z',
}

check(() => assert.deepEqual(UnifiedCRMEventSchema.parse(event).customFields, {}, 'пользовательские поля по умолчанию пусты, а не undefined'))
check(() => assert.equal(UnifiedCRMEventSchema.safeParse({ ...event, contactPhone: '8-901-111-22-33' }).success, false))
check(() => assert.equal(UnifiedCRMEventSchema.safeParse({ ...event, provider: 'BITRIX' }).success, false))
check(() => assert.equal(UnifiedCRMEventSchema.safeParse({ ...event, occurredAt: '17.08.2026' }).success, false))
// customFields — единственное место, где допущено any: их состав задаёт сам владелец CRM и меняет без
// предупреждения. Ограничение здесь дало бы отказ приёма вебхука из-за поля, до которого нам нет дела.
check(() => assert.equal(UnifiedCRMEventSchema.safeParse({ ...event, customFields: { что_угодно: [1, { a: null }] } }).success, true))

const push = { tenantId: UUID, provider: 'HUBSPOT', leadPhone: '+998901112233', dealTitle: 'Дента Люкс' }
check(() => assert.deepEqual(CRMOutboundPushPayloadSchema.parse(push).tagsToAdd, []))
// callData необязателен: сделку создают и по лиду из SDR-прогона, до первого контакта. Обязательным его
// сделать нельзя — иначе выгрузка найденных лидов потребовала бы выдумать звонок.
check(() => assert.equal(CRMOutboundPushPayloadSchema.safeParse(push).success, true))
check(() => assert.equal(CRMOutboundPushPayloadSchema.safeParse({
  ...push, callData: { durationSec: 100, callOutcome: 'REJECTED', transcriptSummary: 'x', rapportScore: 30, detectedPains: [] },
}).success, true))
check(() => assert.equal(CRMOutboundPushPayloadSchema.safeParse({
  ...push, callData: { durationSec: 100, callOutcome: 'WRONG_NUMBER', transcriptSummary: 'x', rapportScore: 30, detectedPains: [] },
}).success, false, 'в CRM уходят четыре итога, как в карточке'))

// --- Ключ идемпотентности ------------------------------------------------------------------------
//
// Собирается ДЕТЕРМИНИРОВАННО: повторная доставка того же вебхука обязана дать ТОТ ЖЕ ключ, иначе
// уникальный индекс в базе её не остановит и по одному звонку появятся две сделки.

const keyArgs = { provider: 'AMOCRM', direction: 'INBOUND', eventType: 'DEAL_STAGE_CHANGED', externalId: '42', occurredAt: '2026-08-17T10:00:00Z' }
check(() => assert.equal(crmIdempotencyKey(keyArgs), crmIdempotencyKey(keyArgs)))
check(() => assert.notEqual(crmIdempotencyKey(keyArgs), crmIdempotencyKey({ ...keyArgs, externalId: '43' })))
check(() => assert.notEqual(crmIdempotencyKey(keyArgs), crmIdempotencyKey({ ...keyArgs, direction: 'OUTBOUND' })))
check(() => assert.ok(crmIdempotencyKey({ ...keyArgs, externalId: 'x'.repeat(200) }).length <= 128, 'предел колонки — 128 знаков'))

// РАЗНЫЕ длинные события обязаны давать РАЗНЫЕ ключи.
//
// Раньше ключ обрезался до 128 знаков, и эта проверка его уронила: приставка занимает 34 знака, от
// внешнего идентификатора оставалось 94, и два разных события длиной больше этого сходились в один
// ключ. Второе, настоящее, база отвергала как дубль — то есть обновление сделки ТЕРЯЛОСЬ. Дубль видно,
// потерю нет, поэтому длинный ключ теперь свёртывается хешем, а не режется.
check(() => assert.notEqual(
  crmIdempotencyKey({ ...keyArgs, externalId: 'a'.repeat(120) }),
  crmIdempotencyKey({ ...keyArgs, externalId: 'a'.repeat(119) + 'b' }),
))
check(() => assert.notEqual(
  crmIdempotencyKey({ ...keyArgs, externalId: 'a'.repeat(200) }),
  crmIdempotencyKey({ ...keyArgs, externalId: 'a'.repeat(201) }),
))
// Разница В КОНЦЕ длинного идентификатора — самый частый случай: внешние id отличаются последними
// цифрами, а не первыми.
check(() => assert.notEqual(
  crmIdempotencyKey({ ...keyArgs, externalId: `${'z'.repeat(150)}1` }),
  crmIdempotencyKey({ ...keyArgs, externalId: `${'z'.repeat(150)}2` }),
))
// Свёрнутый ключ остаётся ДЕТЕРМИНИРОВАННЫМ: иначе повтор вебхука не будет опознан.
check(() => assert.equal(
  crmIdempotencyKey({ ...keyArgs, externalId: 'q'.repeat(300) }),
  crmIdempotencyKey({ ...keyArgs, externalId: 'q'.repeat(300) }),
))
// И читаемым в начале: по журналу должно быть видно провайдера и направление без расшифровки хеша.
check(() => assert.match(crmIdempotencyKey({ ...keyArgs, externalId: 'q'.repeat(300) }), /^AMOCRM:INBOUND:/))
// Короткий ключ НЕ хешируется: в журнале он полезнее как есть.
check(() => assert.equal(crmIdempotencyKey(keyArgs).includes('~'), false))
// Пробелы и двоеточия внутри значений заменяются: иначе внешний id с двоеточием подделал бы разделитель.
check(() => assert.equal(crmIdempotencyKey({ ...keyArgs, externalId: 'a:b' }).includes('a_b'), true))

// --- parseContract: причина отказа читаема --------------------------------------------------------

check(() => {
  const bad = parseContract(LeadCardNotificationSchema, { ...card, rapportScore: 240, customerPhone: 5 })
  assert.equal(bad.ok, false)
  // Отвергнутый вебхук с текстом «rapportScore: …» чинится за минуту, а с текстом «ZodError» — за час.
  assert.match(bad.error, /rapportScore/)
  assert.match(bad.error, /customerPhone/)
  assert.equal(bad.issues.length, 2)
})
check(() => assert.equal(parseContract(LeadCardNotificationSchema, card).ok, true))

// --- ЭКРАНИРОВАНИЕ ------------------------------------------------------------------------------

check(() => assert.equal(escapeHtml('Мебель < 5 дней & Ко'), 'Мебель &lt; 5 дней &amp; Ко'))
// Амперсанд ПЕРВЫМ: иначе &lt;, полученный из <, сам станет &amp;lt; и в сообщении появится видимый
// текст вместо символа.
check(() => assert.equal(escapeHtml('<b>'), '&lt;b&gt;'))
check(() => assert.equal(escapeHtml('a & b < c'), 'a &amp; b &lt; c'))
check(() => assert.equal(escapeHtml(null), ''))
check(() => assert.equal(escapeHtml(undefined), ''))
check(() => assert.equal(escapeHtml(0), '0', 'ноль — значение, а не пустота'))

// MarkdownV2 требует экранировать восемнадцать знаков: забытая точка в конце предложения даёт 400.
check(() => assert.equal(escapeMarkdownV2('Готово.'), 'Готово\\.'))
check(() => assert.equal(escapeMarkdownV2('a_b*c[d]'), 'a\\_b\\*c\\[d\\]'))
// Длинное тире НЕ в списке Bot API (там обычный дефис), а восклицательный знак — в списке.
check(() => assert.equal(escapeMarkdownV2('цена — 100!'), 'цена — 100\\!'))
check(() => assert.equal(escapeMarkdownV2('скидка -20%'), 'скидка \\-20%'))
// Обратная косая экранируется тоже, иначе она съест следующий за ней знак.
check(() => assert.equal(escapeMarkdownV2('путь C:\\tmp'), 'путь C:\\\\tmp'))

// --- Текст карточки -----------------------------------------------------------------------------

check(() => {
  const text = renderLeadCard(card)
  assert.match(text, /⚡ Завершен AI-звонок/)
  assert.match(text, /Дента Люкс/)
  assert.match(text, /88\/100/)
  assert.match(text, /🔥 Горячий \(Демо\)/)
  assert.match(text, /Отправить оффер/)
})

// Внедрённая в чужой текст разметка НЕ становится разметкой. Это главная проверка файла: без неё в
// сообщении менеджеру появится ссылка, которую туда никто не ставил.
check(() => {
  const text = renderLeadCard({
    ...card,
    leadName: '<a href="https://зло.uz">Клик</a>',
    keyPains: ['<b>жирный</b>', 'ссылка <a href="x">тут</a>'],
    summaryText: 'Скажите менеджеру: <i>переведите деньги</i>',
    recommendedAction: '</b><a href="https://зло.uz">жми</a>',
  })
  assert.equal(text.includes('<a href'), false, 'чужая ссылка не должна стать разметкой')
  assert.equal(text.includes('<i>'), false)
  assert.match(text, /&lt;a href/)
  assert.match(text, /&lt;b&gt;жирный&lt;\/b&gt;/)
})

// Имя может отсутствовать — карточка всё равно должна быть читаемой.
check(() => assert.match(renderLeadCard({ ...card, leadName: undefined }), /Не указано/))
// Пустой список болей не должен давать пустой раздел.
check(() => assert.match(renderLeadCard({ ...card, keyPains: [] }), /Не зафиксированы/))

// Предел Telegram — 4096 знаков. Резюме десятиминутного разговора выходит за него, и тогда карточка не
// приходит совсем. Обрезается ИМЕННО резюме: телефон, балл и рекомендация обязаны доехать.
check(() => {
  const text = renderLeadCard({ ...card, summaryText: 'я'.repeat(9_000) })
  assert.ok(text.length <= 4096, `получилось ${text.length}`)
  assert.match(text, /\+998901112233/, 'телефон уцелел')
  assert.match(text, /88\/100/, 'балл уцелел')
  assert.match(text, /Отправить оффер/, 'рекомендация уцелела')
})

// Обрезка не должна РАССЕКАТЬ тег: незакрытый «<b» ломает разбор ВСЕГО сообщения, а не последней строки,
// и Telegram отвечает 400 — карточка не приходит вовсе.
//
// Диапазон длин подобран НЕ на глаз. Точка обрезки стоит на 4076 знаке, и при большинстве длин она
// попадает в обычный текст — проверка тогда проходит сама собой, ничего не проверив. Здесь длина болей
// подобрана так, чтобы срез прошёл сквозь «<b>» открывающего тега раздела «Краткое резюме»: при 3913
// знаках он приходится ровно на середину тега. Проверяется весь диапазон вокруг, чтобы утверждение не
// зависело от точного подсчёта эмодзи в заголовках.
check(() => {
  let sawCutInsideTag = false
  for (let pain = 3_900; pain <= 3_925; pain++) {
    const text = renderLeadCard({
      ...card, recordingUrl: undefined, summaryText: 'резюме', keyPains: ['x'.repeat(pain)],
    })
    assert.ok(text.length <= 4096, `длина ${text.length} при pain=${pain}`)
    // Многоточие — наш признак обрезки, его снимаем перед проверкой: иначе оно само закрывает строку и
    // рассечённый тег «<b» перестаёт быть последним.
    const withoutEllipsis = text.replace(/…$/, '')
    assert.equal(/<[^>]*$/.test(withoutEllipsis), false,
      `тег рассечён при pain=${pain}: …${JSON.stringify(text.slice(-12))}`)
    // Признак того, что срез действительно прошёл по тегу: на его месте остался разрыв строк, за
    // которым тега уже нет. Без этого нельзя утверждать, что опасный случай вообще проверялся.
    if (withoutEllipsis.endsWith('\n\n')) sawCutInsideTag = true
  }
  assert.ok(sawCutInsideTag, 'ни одна длина не дала срез внутри тега — проверка ничего не проверяет')
})


// Заголовок и подпись балла переопределяются — ради карточки лида, по которому ещё не звонили.
check(() => assert.match(renderLeadCard(card, { headline: '🎯 Новый лид' }), /🎯 Новый лид/))
check(() => assert.equal(renderLeadCard(card, { headline: '🎯 Новый лид' }).includes('Завершен AI-звонок'), false))
check(() => assert.match(renderLeadCard(card, { scoreLabel: 'Соответствие ICP' }), /Соответствие ICP:<\/b> 88/))
// Без переопределений — буквально текст §4.1 ТЗ.
check(() => assert.match(renderLeadCard(card), /Trust Score:<\/b> 88/))

check(() => assert.deepEqual(Object.keys(OUTCOME_LABELS), ['INTERESTED_DEMO', 'FRIENDLY_CHAT_FOLLOWUP', 'CALL_LATER', 'REJECTED']))

// --- Кнопки -------------------------------------------------------------------------------------

check(() => {
  const rows = buildLeadCardButtons(card)
  assert.equal(rows[0][0].callback_data, `${CALLBACK_SEND_OFFER}:${UUID}`)
  assert.equal(rows[0][1].callback_data, `${CALLBACK_MANUAL_CALL}:${UUID}`)
  assert.equal(rows[1][0].url, card.recordingUrl)
})

// Кнопки «Слушать запись» БЕЗ записи не будет. В ТЗ на её месте подставлялся адрес главной страницы —
// то есть менеджеру обещали запись и вели не туда. Человек нажимает один раз и перестаёт верить кнопкам.
check(() => {
  const rows = buildLeadCardButtons({ ...card, recordingUrl: undefined })
  assert.equal(rows.length, 1)
  assert.equal(JSON.stringify(rows).includes('nemo.ai'), false)
  assert.equal(JSON.stringify(rows).includes('Слушать'), false)
})

// --- Разбор нажатий -----------------------------------------------------------------------------
//
// callback_data приходит от клиента Telegram и подделывается тривиально: кто угодно с ботом может
// послать send_offer с любым идентификатором.

check(() => assert.deepEqual(parseCallbackData(`send_offer:${UUID}`), { action: 'send_offer', callId: UUID }))
check(() => assert.deepEqual(parseCallbackData(`manual_call:${UUID}`), { action: 'manual_call', callId: UUID }))
check(() => assert.equal(parseCallbackData(`drop_table:${UUID}`), null, 'чужая приставка не проходит'))
check(() => assert.equal(parseCallbackData('send_offer:1; drop table leads'), null, 'вторая часть обязана быть UUID'))
check(() => assert.equal(parseCallbackData('send_offer:'), null))
check(() => assert.equal(parseCallbackData(`:${UUID}`), null))
check(() => assert.equal(parseCallbackData(UUID), null, 'без приставки — не наша кнопка'))
check(() => assert.equal(parseCallbackData(null), null))
check(() => assert.equal(parseCallbackData(''), null))

// --- Отправка через подменный API ---------------------------------------------------------------

const fakeApi = () => {
  const sent = []
  return { sent, sendMessage: async (chatId, text, options) => { sent.push({ chatId, text, options }); return { message_id: 42 } } }
}

await checkAsync(async () => {
  const api = fakeApi()
  const svc = new TelegramNotificationService(api)
  const result = await svc.sendLeadCardToManager(475857370, card)
  assert.deepEqual(result, { ok: true, messageId: 42 })
  assert.equal(api.sent[0].options.parse_mode, 'HTML')
  assert.equal(api.sent[0].options.reply_markup.inline_keyboard.length, 2)
  // Предпросмотр ссылки на запись занял бы половину экрана плеером и оттеснил вниз боли и рекомендацию.
  assert.equal(api.sent[0].options.disable_web_page_preview, true)
})

// Негодная нагрузка проверяется В СЕРВИСЕ, а не у вызывающего: разбор звонка приходит от модели, и
// rapportScore: 240 доехал бы до экрана менеджера, если бы проверку можно было пропустить.
await checkAsync(async () => {
  const api = fakeApi()
  const result = await new TelegramNotificationService(api).sendLeadCardToManager(1, { ...card, rapportScore: 240 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid_payload')
  assert.equal(api.sent.length, 0, 'негодная карточка не должна уходить в Telegram вовсе')
})

// Отказ Telegram — ЗНАЧЕНИЕ, а не исключение: недоставленная карточка это потеря одного уведомления, а
// исключение посреди пост-звонкового цикла оставит звонок незафиксированным и запустит второй звонок.
await checkAsync(async () => {
  const svc = new TelegramNotificationService({ sendMessage: async () => { throw new Error('Bad Request: chat not found') } })
  const result = await svc.sendLeadCardToManager(1, card)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'telegram_error')
  assert.match(result.error, /chat not found/)
})

check(() => assert.throws(() => new TelegramNotificationService('  '), /нужен токен/))
// Обработка нажатий требует живого бота: на подменном API её подключить нельзя, и молчать об этом нельзя.
check(() => assert.throws(() => new TelegramNotificationService(fakeApi()).registerCallbacks(() => 'ok'), /живого бота/))

// --- Найденный лид → карточка -------------------------------------------------------------------

const hotLead = {
  name: 'Дента Люкс', phone: '+998712000000', website: 'https://denta.uz', city: 'Ташкент',
  dedupe_key: 'denta-lux|tashkent',
  score: { score: 88, status: 'HOT', reason: 'нет онлайн-записи', icebreaker_pitch: 'Заметил, что нет онлайн-записи' },
  enrichment: { emails: [], booking_widgets: [], socials: { whatsapp: 'https://wa.me/998901112233' } },
}
const coldLead = { name: 'Стом Плюс', phone: '+998713000000', score: { score: 30, status: 'COLD' }, enrichment: {} }

// Устойчивый id: случайный означал бы, что повторный прогон присылает карточку с новым идентификатором,
// и кнопка ссылается на то, чего нет ни в одной таблице.
check(() => assert.equal(deterministicUuid('denta-lux|tashkent'), deterministicUuid('denta-lux|tashkent')))
check(() => assert.notEqual(deterministicUuid('a'), deterministicUuid('b')))
// Форма проверяется на МНОЖЕСТВЕ семян. При одном семени биты варианта могут случайно оказаться
// верными сами собой (в hex туда попадает 8, 9, a или b с вероятностью 1/4), и проверка пройдёт, не
// проверив маску. Postgres откажет на первой же неверной строке, а найдётся это в бою.
check(() => {
  for (let i = 0; i < 64; i++) {
    const uuid = deterministicUuid(`семя-${i}`)
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, `семя ${i}: ${uuid}`)
    assert.equal(LeadCardNotificationSchema.shape.callId.safeParse(uuid).success, true, `семя ${i} не прошло как UUID`)
  }
})

check(() => assert.equal(isHotLead(hotLead), true))
check(() => assert.equal(isHotLead(coldLead), false))
// Порог решает наравне со статусом: пайплайн ставит оба поля, а старые записи в базе — не всегда.
check(() => assert.equal(isHotLead({ score: { score: 90 } }), true))
check(() => assert.equal(isHotLead({ score: null }), false))
check(() => assert.equal(isHotLead({}), false))

check(() => {
  const converted = leadToCardNotification(hotLead)
  // CALL_LATER — единственное значение из четырёх, которое не врёт о несостоявшемся звонке.
  // INTERESTED_DEMO означало бы, что лид выразил интерес, чего не было.
  assert.equal(converted.outcome, 'CALL_LATER')
  assert.equal(converted.rapportScore, 88)
  assert.equal(converted.recordingUrl, undefined, 'записи нет — поля быть не должно')
  // Первое, что читает менеджер: звонка не было. Без этой строки он решит, что разговор состоялся.
  assert.match(converted.summaryText, /Звонка ещё не было/)
  assert.match(converted.recommendedAction, /Заметил, что нет онлайн-записи/)
})

// Идентификатор карточки берётся из ключа дедупликации лида, а не из случайного числа: повторный
// прогон должен дать ТОТ ЖЕ id, иначе кнопка «Отправить оффер» ссылается на то, чего нет ни в одной
// таблице. Проверяется на самой конверсии, а не только на deterministicUuid: связь между ними и есть
// то, что легко потерять правкой.
check(() => assert.equal(leadToCardNotification(hotLead).callId, leadToCardNotification(hotLead).callId))
check(() => assert.notEqual(
  leadToCardNotification(hotLead).callId,
  leadToCardNotification({ ...hotLead, dedupe_key: 'другой-лид|ташкент' }).callId,
))
// Без ключа дедупликации id собирается из имени, города и связи — и остаётся устойчивым.
check(() => {
  const withoutKey = { ...hotLead, dedupe_key: null }
  assert.equal(leadToCardNotification(withoutKey).callId, leadToCardNotification(withoutKey).callId)
  assert.notEqual(leadToCardNotification(withoutKey).callId, leadToCardNotification({ ...withoutKey, name: 'Другая' }).callId)
})

check(() => assert.equal(leadToCardNotification(coldLead), null, 'карточка с кнопками по холодному лиду приучит пролистывать все'))
check(() => assert.equal(leadToCardNotification({ name: 'Без связи', score: { score: 90, status: 'HOT' } }), null, 'карточка без единого канала связи бесполезна'))
// Лид без питча всё равно получает осмысленную рекомендацию, а не пустое поле.
check(() => assert.match(leadToCardNotification({ ...hotLead, score: { score: 80, status: 'HOT' } }).recommendedAction, /Позвонить/))

// Заголовок карточки найденного лида НЕ должен утверждать, что звонок состоялся.
check(() => assert.equal(FOUND_LEAD_STYLE.headline.includes('Завершен'), false))
check(() => assert.match(FOUND_LEAD_STYLE.headline, /звонка ещё не было/i))
check(() => assert.equal(FOUND_LEAD_STYLE.scoreLabel, 'Соответствие ICP', '88/100 здесь про пригодность, а не про доверие в разговоре'))

await checkAsync(async () => {
  const styles = []
  const service = { sendLeadCardToManager: async (chat, payload, style) => { styles.push(style); return { ok: true } } }
  const report = await sendLeadCards(service, 1, [hotLead, coldLead, hotLead])
  assert.deepEqual(report, { sent: 2, skipped: 1, errors: [] })
  assert.deepEqual(styles[0], FOUND_LEAD_STYLE, 'оформление обязано доехать до отправки')
})

// Отказ по одному лиду не отменяет остальные и попадает в отчёт с ИМЕНЕМ: «отправлено 0» без причины
// выглядит как «горячих не нашлось».
await checkAsync(async () => {
  let call = 0
  const service = { sendLeadCardToManager: async () => (++call === 1 ? { ok: false, error: 'chat not found' } : { ok: true }) }
  const report = await sendLeadCards(service, 1, [hotLead, { ...hotLead, dedupe_key: 'вторая' }])
  assert.equal(report.sent, 1)
  assert.equal(report.errors.length, 1)
  assert.match(report.errors[0], /Дента Люкс/)
  assert.match(report.errors[0], /chat not found/)
})

// --- Настройки рассылки -------------------------------------------------------------------------
//
// ВЫКЛЮЧЕНО по умолчанию: обычные уведомления о горячих лидах уже отправляет notifier.ts внутри
// пайплайна, и включить карточки, не выключив те, значит присылать по два сообщения на каждый лид.

check(() => assert.equal(resolveLeadCardConfig({}).enabled, false))
check(() => assert.match(resolveLeadCardConfig({}).reason, /SDR_LEAD_CARDS/))
// ФЛАГ обязателен даже когда токен и чат уже настроены. Именно этот случай и опасен: токен с чатом есть
// у каждого, кто включил обычные уведомления, и без проверки флага они получат по два сообщения на лид.
check(() => {
  const configured = resolveLeadCardConfig({ SDR_TELEGRAM_BOT_TOKEN: 't', SDR_TELEGRAM_CHAT_ID: '5' })
  assert.equal(configured.enabled, false, 'без флага карточки включаться не должны')
  assert.match(configured.reason, /SDR_LEAD_CARDS/)
})
check(() => assert.equal(resolveLeadCardConfig({ SDR_LEAD_CARDS: '1' }).enabled, false, 'без токена включить нельзя'))
check(() => assert.match(resolveLeadCardConfig({ SDR_LEAD_CARDS: '1' }).reason, /SDR_TELEGRAM_BOT_TOKEN/))
check(() => assert.match(resolveLeadCardConfig({ SDR_LEAD_CARDS: '1', SDR_TELEGRAM_BOT_TOKEN: 't' }).reason, /CHAT_ID/))
check(() => {
  const on = resolveLeadCardConfig({ SDR_LEAD_CARDS: 'true', SDR_TELEGRAM_BOT_TOKEN: 't', SDR_TELEGRAM_CHAT_ID: '5' })
  assert.equal(on.enabled, true)
  assert.equal(on.chatId, '5')
})
// Отдельный чат для карточек важнее общего: карточки с кнопками уходят менеджеру, а обычные алерты —
// владельцу, и это бывают разные люди.
check(() => assert.equal(
  resolveLeadCardConfig({ SDR_LEAD_CARDS: '1', SDR_TELEGRAM_BOT_TOKEN: 't', SDR_TELEGRAM_CHAT_ID: '5', SDR_LEAD_CARD_CHAT_ID: '9' }).chatId,
  '9',
))

console.log(`[OK] V5 contracts and Telegram lead card behaviour: ${checks} assertions`)
