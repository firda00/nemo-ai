// Вывод лидов в консоль. Проверяется то, что читает человек и копирует в чужой чат.
//
// Две вещи здесь дороже прочих: горячий лид с готовым текстом обязан появиться БЕЗ флага (иначе
// прогон просят повторить ради уже посчитанного), а сам текст первого касания не должен нести наших
// значков — его копируют целиком и отправляют живому человеку.

import assert from 'node:assert/strict'
import { HOT_SCORE, contactLines, formatLead, isHot, renderLeadReport } from './lead-report.mjs'

const base = {
  name: 'Дента', city: 'Ташкент', phone: '+998712003040', website: 'https://denta.uz/',
  address: null, rating: 4.7, reviews: 128,
  enrichment: { description: null, emails: [], socials: { linkedin: null, instagram: null, telegram: null, facebook: null }, people: [], failed: [] },
  score: null, found_at: new Date(0).toISOString(),
}
const scored = (score, extra = {}) => ({
  ...base,
  score: {
    score, status: score >= HOT_SCORE ? 'HOT' : score >= 40 ? 'QUALIFIED' : 'LOW_PRIORITY',
    reason: 'Есть сайт и высокий рейтинг', key_decision_maker: null,
    icebreaker_pitch: 'У вас 128 отзывов и 4.7 — поможем не терять заявки ночью.',
    ...extra,
  },
})

// --- Что считается горячим ------------------------------------------------------------------------

assert.equal(isHot(scored(70)), true, 'ровно порог — уже горячий')
assert.equal(isHot(scored(69)), false)
assert.equal(isHot(scored(100)), true)
assert.equal(isHot(base), false, 'без оценки горячим быть нельзя — модель не спрашивали')
assert.equal(isHot({ ...base, score: null }), false)
// Статус и число расходиться не должны, но если статус пришёл HOT — верим ему тоже: порог мог
// поменяться на сервере, а вывод не должен от этого замолчать.
assert.equal(isHot({ ...base, score: { score: 10, status: 'HOT', reason: 'r', icebreaker_pitch: null } }), true)

// --- Горячий печатается БЕЗ флага -----------------------------------------------------------------
// Главная проверка файла: за --details горячих прятать нельзя.

{
  const report = renderLeadReport([scored(85)], {})
  assert.ok(report.includes('Дента'), 'название есть')
  assert.ok(report.includes('85/100'), 'балл есть')
  assert.ok(report.includes('Есть сайт и высокий рейтинг'), 'причина есть')
  assert.ok(report.includes('+998712003040'), 'телефон есть')
  assert.ok(report.includes('https://denta.uz/'), 'сайт есть')
  assert.ok(report.includes('поможем не терять заявки ночью'), 'готовый текст первого касания есть')
  assert.ok(report.includes('🔥'), 'горячий помечен')
}

// Тёплый и холодный без флага не печатаются, но их количество названо — иначе «горячих нет»
// читается как «пусто», хотя лиды есть.
{
  const report = renderLeadReport([scored(50), scored(20)], {})
  assert.equal(report.includes('Дента'), false, 'без --details тёплых не печатаем')
  assert.ok(report.includes('--details'), 'подсказка, как их увидеть, обязательна')
  assert.ok(report.includes('Найдено 2'))
}

// С флагом печатаются все, горячие первыми.
{
  const report = renderLeadReport([scored(30), scored(90)], { details: true })
  assert.ok(report.includes('Все лиды (2)'))
  assert.ok(report.indexOf('90/100') < report.indexOf('30/100'), 'горячий идёт первым, а не в порядке выдачи')
}

// Смесь: горячий печатается, про остальных сказано числом.
{
  const report = renderLeadReport([scored(90), scored(50), scored(10)], {})
  assert.ok(report.includes('Горячие лиды (1 из 3)'))
  assert.ok(report.includes('Остальные 2'))
}

assert.equal(renderLeadReport([], {}), '', 'пустой список — пустой вывод, без заголовков ни о чём')
assert.equal(renderLeadReport(null, {}), '')
assert.equal(renderLeadReport(undefined, {}), '')

// --- Текст первого касания не должен нести нашу разметку -------------------------------------------
// Его копируют целиком. Любой значок, попавший внутрь строки с питчем, уедет в чужой чат.

{
  const pitch = 'У вас 128 отзывов и 4.7 — поможем не терять заявки ночью.'
  const line = formatLead(scored(90), 1).split(/\r?\n/).find((one) => one.includes(pitch))
  assert.ok(line, 'строка с питчем найдена')
  assert.equal(line.trim(), pitch, 'в строке только сам текст: ни 🔥, ни «первое касание:», ни номера')
}

// Нет питча — так и сказано, а не пустая строка и не «null».
{
  const report = formatLead(scored(90, { icebreaker_pitch: null }), 1)
  assert.ok(report.includes('не составлено'))
  assert.equal(report.includes('null'), false, '«null» на экране у владельца недопустим')
}

// --- Отсутствие оценки — это не ноль баллов --------------------------------------------------------
// Путать нельзя: неоценённый лид может быть лучшим в списке, просто его не спрашивали.

{
  const report = formatLead(base, 1)
  assert.ok(report.includes('оценка не запускалась'))
  assert.equal(report.includes('0/100'), false)
}

// --- Контакты: одного канала достаточно, и он должен быть виден -------------------------------------
// После смягчения фильтра лид может иметь только телефон или только сайт.

assert.deepEqual(contactLines({ ...base, website: null }), ['телефон:  +998712003040'])
assert.deepEqual(contactLines({ ...base, phone: null }), ['сайт:     https://denta.uz/'])
{
  const lines = contactLines({
    ...base,
    enrichment: {
      ...base.enrichment,
      emails: ['a@b.uz', 'c@d.uz'],
      socials: { ...base.enrichment.socials, telegram: 'https://t.me/denta', instagram: 'https://instagram.com/denta' },
    },
  })
  assert.ok(lines.some((one) => one.includes('a@b.uz')), 'почта из обогащения — тоже канал первого касания')
  assert.ok(lines.some((one) => one.includes('t.me/denta')))
  assert.ok(lines.some((one) => one.includes('instagram.com/denta')))
}
// Лид без единого канала фильтр качества не пропускает. Если такое приехало — это надо УВИДЕТЬ.
{
  const lines = contactLines({ ...base, phone: null, website: null })
  assert.equal(lines.length, 1)
  assert.ok(lines[0].includes('контактов нет'))
}

// ЛПР берётся из оценки, а при её молчании — из найденных людей.
assert.ok(formatLead(scored(90, { key_decision_maker: 'Иван Петров' }), 1).includes('Иван Петров'))
assert.ok(formatLead({
  ...scored(90),
  enrichment: { ...base.enrichment, people: [{ name: 'Пётр Иванов', role: 'Главврач', source: 'search', profile_url: null }] },
}, 1).includes('Пётр Иванов — Главврач'))

console.log('[OK] Lead report behaviour: 38 assertions')
