// Алерты о горячих лидах в Telegram. Вызов API замокан целиком — сюда не приходит ни один
// настоящий запрос.
//
// Проверяется три вещи, каждая из которых стоит дорого при поломке: сообщение не должно быть
// отвергнуто Telegram из-за неэкранированного символа (иначе горячий лид пропадает молча), алерт не
// должен уходить о НЕ-горячем (иначе поток выключают вместе с нужными сообщениями), и неудача
// отправки не должна ронять фиксацию задачи (иначе воркер возьмёт её снова и спишет кредиты дважды).

import assert from 'node:assert/strict'
import { TelegramNotifier, formatHotLeadMessage } from '../supabase/functions/_shared/leadgen/notifier.ts'

const baseLead = {
  place_id: 'p1', name: 'Дента', normalized_name: 'дента', city: 'Ташкент', dedupe_key: '0'.repeat(64),
  address: null, phone: '+998712562363', website: 'https://denta.uz/', rating: 4.7, reviews: 128, operational: true,
  enrichment: {
    description: null, emails: [],
    socials: { linkedin: null, instagram: null, telegram: null, facebook: null },
    people: [], failed: [],
  },
  score: {
    score: 85, status: 'HOT', reason: 'Есть сайт и высокий рейтинг',
    key_decision_maker: null, icebreaker_pitch: 'Поможем не терять заявки ночью.',
  },
  found_at: new Date(0).toISOString(),
}

/** Мок Telegram: запоминает, что бы ушло в сеть, и отвечает как настоящий на успех. */
function mockTelegram({ ok = true, status = 200 } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), method: init.method })
    return { ok, status, json: async () => ({ ok }) }
  }
  return { calls, fetchImpl }
}

// --- Форма запроса к API --------------------------------------------------------------------------

{
  const { calls, fetchImpl } = mockTelegram()
  const outcome = await new TelegramNotifier('BOT:TOKEN', '-100500', fetchImpl).alertHot(baseLead)
  assert.equal(outcome.ok, true)
  assert.equal(calls.length, 1)

  const call = calls[0]
  assert.equal(call.method, 'POST')
  assert.ok(call.url.includes('/botBOT:TOKEN/sendMessage'), 'токен в пути, как требует Bot API')
  assert.ok(call.url.startsWith('https://api.telegram.org/'))
  assert.equal(call.body.chat_id, '-100500')
  // HTML, а не MarkdownV2: в MarkdownV2 экранировать надо восемнадцать символов, включая точку и
  // дефис, и один забытый даёт не кривой текст, а отказ 400 — то есть потерянный лид.
  assert.equal(call.body.parse_mode, 'HTML')
}

// --- Содержимое сообщения -------------------------------------------------------------------------

{
  const lead = {
    ...baseLead,
    enrichment: {
      ...baseLead.enrichment,
      emails: ['info@denta.uz'],
      socials: { linkedin: null, instagram: 'https://instagram.com/denta', telegram: 'https://t.me/denta', facebook: null },
    },
    score: { ...baseLead.score, key_decision_maker: 'Иван Петров' },
  }
  const text = formatHotLeadMessage(lead)

  assert.ok(text.includes('🔥'), 'горячий помечен значком')
  assert.ok(text.includes('Новый горячий лид: Дента'))
  assert.ok(text.includes('(Ташкент)'), 'город в заголовке')
  assert.ok(text.includes('📊 Балл: <b>85/100</b>'))
  assert.ok(text.includes('📞 Телефон: +998712562363'))
  assert.ok(text.includes('🌐 Сайт: https://denta.uz/'))
  assert.ok(text.includes('💬'), 'строка соцсетей есть')
  assert.ok(text.includes('t.me/denta') && text.includes('instagram.com/denta'), 'обе соцсети в теле сообщения')
  assert.ok(text.includes('info@denta.uz'), 'почта — тоже канал первого касания')
  assert.ok(text.includes('👤 ЛПР: Иван Петров'))
  assert.ok(text.includes('📝 <b>Первое касание:</b>'))
  assert.ok(text.includes('«Поможем не терять заявки ночью.»'), 'питч в кавычках, отдельным блоком')
  // Отбив после заголовка — намеренная пустая строка, а не отсутствующее поле. Фильтр по истинности
  // однажды съел бы её вместе с пустыми полями.
  assert.ok(text.split('\n')[1] === '', 'пустая строка после заголовка сохраняется')
}

// Полей нет — строк нет, и никаких «null» на экране у владельца.
{
  const bare = {
    ...baseLead, phone: null, website: null,
    score: { score: 70, status: 'HOT', reason: null, key_decision_maker: null, icebreaker_pitch: null },
  }
  const text = formatHotLeadMessage(bare)
  assert.equal(text.includes('null'), false, '«null» в сообщении недопустим')
  assert.equal(text.includes('📞'), false)
  assert.equal(text.includes('🌐'), false)
  assert.equal(text.includes('📝'), false)
  assert.ok(text.includes('📊 Балл: <b>70/100</b>'), 'то, что есть, — на месте')
}

// --- Экранирование: один незакрытый символ = отказ 400 и потерянный лид ----------------------------

{
  const nasty = {
    ...baseLead,
    name: 'Клиника <b>ЛУЧШАЯ</b> & Co',
    city: 'Ташкент <script>',
    score: {
      ...baseLead.score,
      reason: 'Рейтинг > 4 & сайт есть',
      key_decision_maker: 'Иван <admin>',
      icebreaker_pitch: 'Ваши 4.7 & 128 отзывов — <b>отлично</b>!',
    },
  }
  const text = formatHotLeadMessage(nasty)

  // Чужая разметка обязана приехать текстом, а не тегами: иначе она либо ломает разбор, либо
  // исполняется как оформление, которого мы не писали.
  assert.ok(text.includes('Клиника &lt;b&gt;ЛУЧШАЯ&lt;/b&gt; &amp; Co'))
  assert.ok(text.includes('Ташкент &lt;script&gt;'))
  assert.ok(text.includes('Рейтинг &gt; 4 &amp; сайт есть'))
  assert.ok(text.includes('Иван &lt;admin&gt;'))
  assert.ok(text.includes('&lt;b&gt;отлично&lt;/b&gt;'))

  // Наши собственные теги остаются рабочими — экранируются ЗНАЧЕНИЯ, а не разметка сообщения.
  assert.ok(text.includes('<b>Новый горячий лид:'))
  assert.ok(text.includes('<i>'))

  // Ни одного «сырого» тега из данных: всё, что похоже на тег, должно быть либо нашим, либо
  // экранированным. Проверяем, что чужих <b> без амперсанда не осталось.
  assert.equal(/<script>/.test(text), false)
  assert.equal(/Клиника <b>/.test(text), false)
}

// Амперсанд экранируется ПЕРВЫМ: иначе он испортил бы уже вставленные последовательности
// («&lt;» превратилось бы в «&amp;lt;» и приехало бы текстом).
assert.ok(formatHotLeadMessage({ ...baseLead, name: '<A & B>' }).includes('&lt;A &amp; B&gt;'))

// --- ТОЛЬКО горячие ------------------------------------------------------------------------------
// Алерт о каждом найденном лиде превращается в поток, который выключают на второй день, — и вместе
// с ним выключают те несколько сообщений в неделю, ради которых всё делалось.

for (const status of ['QUALIFIED', 'LOW_PRIORITY']) {
  const { calls, fetchImpl } = mockTelegram()
  const outcome = await new TelegramNotifier('t', 'c', fetchImpl).alertHot({
    ...baseLead, score: { ...baseLead.score, score: 50, status },
  })
  assert.equal(outcome.ok, false, `${status} не отправляется`)
  assert.equal(outcome.error, 'not_hot')
  assert.equal(calls.length, 0, 'ни одного запроса к Telegram — а не «отправили и передумали»')
}

// Лид без оценки вовсе — тоже не горячий.
{
  const { calls, fetchImpl } = mockTelegram()
  const outcome = await new TelegramNotifier('t', 'c', fetchImpl).alertHot({ ...baseLead, score: null })
  assert.equal(outcome.ok, false)
  assert.equal(calls.length, 0)
}

// --- Неудача отправки не бросает исключение -------------------------------------------------------
// Воркер вызывает это перед фиксацией задачи. Брошенное исключение здесь означало бы, что задача не
// зафиксирована, воркер возьмёт её снова и спишет кредиты второй раз.

{
  const { fetchImpl } = mockTelegram({ ok: false, status: 429 })
  const outcome = await new TelegramNotifier('t', 'c', fetchImpl).alertHot(baseLead)
  assert.equal(outcome.ok, false)
  assert.ok(outcome.error.startsWith('telegram_http_429'), 'код ответа назван — 429 и 400 чинятся по-разному')
}

// ПРИЧИНА ОТКАЗА ИЗ ТЕЛА ОТВЕТА — она и есть инструкция к действию. Живая проверка доставки
// вернула 400 «chat not found», то есть «получатель не нажимал Start у бота»; один код 400 об этом
// не говорит ничего, и оператор пошёл бы искать ошибку в коде вместо того, чтобы открыть Telegram.
{
  const explained = async () => ({
    ok: false, status: 400,
    json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
  })
  const outcome = await new TelegramNotifier('t', 'c', explained).alertHot(baseLead)
  assert.equal(outcome.ok, false)
  assert.ok(outcome.error.includes('chat not found'), 'объяснение Telegram доезжает до журнала')
  assert.ok(outcome.error.includes('400'), 'код тоже сохраняется')
}

// Тело отказа нечитаемо — код всё равно назван, без «undefined» в хвосте.
{
  const mute = async () => ({ ok: false, status: 502, json: async () => { throw new Error('html') } })
  const outcome = await new TelegramNotifier('t', 'c', mute).alertHot(baseLead)
  assert.equal(outcome.error, 'telegram_http_502')
}

{
  // Сеть недоступна: fetch бросает. Наружу всё равно должен выйти объект, а не исключение.
  const throwing = async () => { throw new Error('ECONNREFUSED') }
  const outcome = await new TelegramNotifier('t', 'c', throwing).alertHot(baseLead)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error, 'telegram_unreachable')
}

{
  // Bot API умеет ответить 200 с отказом в ТЕЛЕ — например, на кривую разметку в parse_mode.
  // Раньше здесь возвращалось { ok: true }: отвергнутое сообщение считалось доставленным, и
  // горячий лид пропадал молча. Проверка тела нашлась именно так — прежний тест утверждал только
  // «наружу вышел boolean» и проходил, ничего не проверяя.
  const rejecting = async () => ({
    ok: true, status: 200,
    json: async () => ({ ok: false, description: "Bad Request: can't parse entities" }),
  })
  const outcome = await new TelegramNotifier('t', 'c', rejecting).alertHot(baseLead)
  assert.equal(outcome.ok, false, 'ok:false в теле — это отказ, а не доставка')
  assert.ok(outcome.error.startsWith('telegram_rejected:'))
  assert.ok(outcome.error.includes('parse entities'), 'объяснение Telegram доезжает до журнала')
}

{
  // Тело не разобралось, но код 200: сообщение почти наверняка ушло. Объявлять его потерянным
  // из-за нашей неудачи прочитать ответ — хуже, чем считать доставленным.
  const unreadable = async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json') } })
  const outcome = await new TelegramNotifier('t', 'c', unreadable).alertHot(baseLead)
  assert.equal(outcome.ok, true, 'нечитаемое тело при 200 — доставка')
}

// Обычный успешный ответ Bot API — конверт с ok:true.
{
  const fine = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) })
  assert.deepEqual(await new TelegramNotifier('t', 'c', fine).alertHot(baseLead), { ok: true })
}

// --- Кнопки: только ссылки ------------------------------------------------------------------------
// callback_data требует запущенного вебхука, которого в этом пайплайне нет. Кнопка без обработчика
// нажимается и ничего не делает — хуже отсутствия кнопки.

{
  const { calls, fetchImpl } = mockTelegram()
  await new TelegramNotifier('t', 'c', fetchImpl).alertHot({
    ...baseLead,
    enrichment: { ...baseLead.enrichment, socials: { ...baseLead.enrichment.socials, telegram: 'https://t.me/denta' } },
  })
  const keyboard = calls[0].body.reply_markup.inline_keyboard
  const buttons = keyboard.flat()
  assert.ok(buttons.length >= 1)
  assert.ok(buttons.every((one) => typeof one.url === 'string'), 'у каждой кнопки есть url')
  assert.ok(buttons.every((one) => one.callback_data === undefined), 'ни одной кнопки без обработчика')
}

// Нет ни сайта, ни телеграма — клавиатуры нет вовсе, а не пустая строка кнопок.
{
  const { calls, fetchImpl } = mockTelegram()
  await new TelegramNotifier('t', 'c', fetchImpl).alertHot({ ...baseLead, website: null })
  assert.deepEqual(calls[0].body.reply_markup.inline_keyboard, [])
}

console.log('[OK] Telegram alert behaviour: 57 assertions')
