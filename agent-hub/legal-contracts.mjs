// Юридические документы, согласие при регистрации и разделение по хосту.
//
// ЧТО ЗДЕСЬ ЗАЩИЩАЕТСЯ — ТО, ЧТО ЛОМАЕТСЯ БЕЗ ЕДИНОГО КРАСНОГО ЭКРАНА:
//
// 1. ПРОПАВШИЙ БЛОК В ДОКУМЕНТЕ. Пять блоков закрывают конкретные способы поссориться с клиентом:
//    ошибка модели, отправка без подтверждения, невозврат кредитов, обучение на чужих данных,
//    безграничная ответственность. Пропажу любого из них на трёх языках глазами не заметить, а
//    обнаружится она при разборе претензии.
//
// 2. МЁРТВАЯ ССЫЛКА В СОГЛАСИИ. Чекбокс «принимаю условия» со ссылкой на «#» — это согласие с
//    документом, который человек не смог открыть. Ссылки в футере уже были такими.
//
// 3. ФОРМА, ОТПРАВЛЯЕМАЯ БЕЗ СОГЛАСИЯ. Одного `disabled` на кнопке мало: форма отправляется клавишей
//    Enter, а кнопку можно включить через инструменты разработчика.
//
// 4. РАЗДЕЛЕНИЕ ПО ХОСТУ, СЧИТАЮЩЕЕ ПОДСТРОКУ. `includes('app')` уводит посетителя myapp.example.com
//    в форму входа чужого продукта.

import assertStrict from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  PRIVACY, PRIVACY_BLOCK_ORDER, REQUIRED_LEGAL_BLOCKS, TERMS, TERMS_BLOCK_ORDER,
  privacyFor, termsFor,
} from '../src/content/legal.ts'
import { isAppHost, rootRedirectFor } from '../src/lib/host.ts'

let checks = 0
const assert = new Proxy(assertStrict, {
  get: (target, key) => {
    const value = target[key]
    if (typeof value !== 'function') return value
    return (...args) => { checks++; return value.apply(target, args) }
  },
})

const root = path.resolve(import.meta.dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const LANGS = ['ru', 'uz', 'en']

// ─── Обязательные блоки ───────────────────────────────────────────────────────────────────────────

/**
 * Признаки блока в тексте.
 *
 * По СМЫСЛОВЫМ словам, а не по заголовкам: заголовок легко переписать, не тронув суть, и наоборот.
 * Каждый набор — то, без чего блок перестаёт защищать.
 */
const BLOCK_MARKERS = {
  ai_disclaimer: {
    ru: [/вероятностн/i, /выдуман|неверн/i, /не гарантируем/i],
    uz: [/ehtimollik/i, /toʻqib chiqarilgan|notoʻgʻri/i, /kafolatlamaymiz/i],
    en: [/probabilistic/i, /invented|wrong/i, /do not guarantee/i],
  },
  human_loop: {
    ru: [/подтвержден/i, /ответственност/i, /маркетплейс|карточк/i],
    uz: [/tasdiq/i, /javobgarlik/i, /marketpleys|kartochka/i],
    en: [/confirm/i, /responsib/i, /marketplace|listing/i],
  },
  billing: {
    ru: [/кредит/i, /не возвращаются/i, /токен/i],
    uz: [/kredit/i, /qaytarilmaydi/i, /token/i],
    en: [/credit/i, /non-refundable/i, /token/i],
  },
  rag: {
    ru: [/не передаёт их для обучения|не используе\w* для обучения/i, /принадлежат вам/i],
    uz: [/oʻqitish uchun uzatmaydi/i, /sizga tegishli/i],
    en: [/does not submit them for training/i, /belong to you/i],
  },
  liability: {
    ru: [/ограничена суммой/i, /последний месяц|последн\w+ месяц/i, /упущенную выгоду/i],
    uz: [/cheklanadi/i, /oxirgi obuna oyi/i, /boy berilgan foyda/i],
    en: [/limited to the amount/i, /last monthly subscription/i, /lost profit/i],
  },
}

/** Весь текст документа одной строкой: блок может лежать в любом разделе. */
const flatten = (doc) => [doc.intro, ...doc.sections.flatMap((one) => [one.heading, ...one.paragraphs])].join('\n')

for (const lang of LANGS) {
  const terms = flatten(termsFor(lang))
  const privacy = flatten(privacyFor(lang))
  for (const block of TERMS_BLOCK_ORDER) {
    for (const marker of BLOCK_MARKERS[block][lang]) {
      assert.ok(marker.test(terms), `[${lang}] в условиях нет блока ${block}: не найдено ${marker}`)
    }
  }
  for (const block of PRIVACY_BLOCK_ORDER) {
    for (const marker of BLOCK_MARKERS[block][lang]) {
      assert.ok(marker.test(privacy), `[${lang}] в политике нет блока ${block}: не найдено ${marker}`)
    }
  }
}

// Все пять блоков распределены между двумя документами: блок, не попавший ни в один, потерян молча.
assert.deepEqual(
  [...TERMS_BLOCK_ORDER, ...PRIVACY_BLOCK_ORDER].sort(),
  [...REQUIRED_LEGAL_BLOCKS].sort(),
  'какой-то обязательный блок не закреплён ни за одним документом',
)

// ─── Три языка, и ни один не заглушка ─────────────────────────────────────────────────────────────

for (const lang of LANGS) {
  for (const [name, doc] of [['условия', termsFor(lang)], ['политика', privacyFor(lang)]]) {
    assert.ok(doc.title.trim().length > 5, `[${lang}] у документа «${name}» нет заголовка`)
    assert.ok(doc.sections.length >= 4, `[${lang}] в документе «${name}» всего ${doc.sections.length} разделов`)
    assert.ok(flatten(doc).length > 1_500, `[${lang}] документ «${name}» подозрительно короткий`)
  }
}

/*
 * ЯЗЫКИ НЕ КОПИИ ДРУГ ДРУГА.
 *
 * Незаполненный перевод чаще всего выглядит как английский текст под русским заголовком — и это
 * хуже отсутствия перевода: человек считает, что документ на его языке, и не читает.
 */
assert.notEqual(flatten(termsFor('ru')), flatten(termsFor('en')))
assert.notEqual(flatten(termsFor('uz')), flatten(termsFor('en')))
assert.notEqual(flatten(privacyFor('ru')), flatten(privacyFor('uz')))
// Кириллица в русском и латиница в узбекском: перепутанные местами словари ловятся здесь.
assert.ok(/[а-яё]/i.test(flatten(termsFor('ru'))), 'русские условия без кириллицы')
assert.ok(/oʻ|gʻ|sh|ch/.test(flatten(termsFor('uz'))), 'узбекские условия не похожи на узбекский')

// Дата вступления в силу одна на оба документа: расхождение дат — первый вопрос проверяющего.
for (const lang of LANGS) {
  assert.equal(termsFor(lang).updated, privacyFor(lang).updated, `[${lang}] даты документов разошлись`)
}

// Неизвестный язык не роняет страницу и не отдаёт пустоту.
assert.ok(termsFor('de').title.length > 0, 'неизвестный язык оставил страницу без документа')
assert.equal(Object.keys(TERMS).length, LANGS.length)
assert.equal(Object.keys(PRIVACY).length, LANGS.length)

// ─── Согласие при регистрации ─────────────────────────────────────────────────────────────────────

const auth = read('src/pages/AuthPage.tsx')

/*
 * ОТПРАВКА БЛОКИРУЕТСЯ В ОБРАБОТЧИКЕ, А НЕ ТОЛЬКО АТРИБУТОМ.
 *
 * `disabled` на кнопке — это подсказка интерфейса, а не запрет: форма отправляется клавишей Enter, а
 * атрибут снимается в инструментах разработчика за две секунды. Аккаунт, созданный без согласия,
 * обнаружится при разборе претензии, когда доказывать будет нечем.
 */
assert.ok(/if \(isSignup && !agreed\)/.test(auth), 'отправка формы не проверяет согласие в обработчике')
assert.ok(/disabled=\{busy \|\| \(isSignup && !agreed\)\}/.test(auth), 'кнопка регистрации активна без согласия')
// Галочка НЕ отмечена по умолчанию: проставленная за человека, она согласием не является.
assert.ok(/useState\(false\)/.test(auth.slice(auth.indexOf('const [agreed'))), 'согласие отмечено по умолчанию')
// Ссылки ведут на настоящие документы, а не на «#».
assert.ok(/href="\/terms"/.test(auth), 'в согласии нет ссылки на условия')
assert.ok(/href="\/privacy"/.test(auth), 'в согласии нет ссылки на политику')
// При ВХОДЕ согласие не спрашивается: условия принимают один раз, при создании аккаунта.
assert.ok(/\{isSignup && \(/.test(auth), 'чекбокс показывается и при входе')

const footer = read('src/components/layout/MarketingFooter.tsx')
assert.ok(/href: '\/privacy'/.test(footer), 'в футере мёртвая ссылка на политику')
assert.ok(/href: '\/terms'/.test(footer), 'в футере мёртвая ссылка на условия')

// Перевод согласия есть во всех трёх языках: пропуск даёт пустую строку рядом с чекбоксом.
const dictionary = read('src/i18n/translations.ts')
for (const key of ['consentPrefix', 'consentTerms', 'consentAnd', 'consentPrivacy', 'consentRequired']) {
  const count = (dictionary.match(new RegExp(`${key}:`, 'g')) ?? []).length
  assert.equal(count, LANGS.length, `строка ${key} переведена на ${count} языков из ${LANGS.length}`)
}

// ─── Разделение по хосту ──────────────────────────────────────────────────────────────────────────

assert.equal(isAppHost('app.nemo.uz'), true)
assert.equal(isAppHost('APP.NEMO.UZ'), true, 'имя хоста регистронезависимо')
assert.equal(isAppHost('app.nemo.uz:5173'), true, 'порт не должен мешать')
assert.equal(isAppHost('nemo.uz'), false)

/*
 * ПРОВЕРЯЕТСЯ ПЕРВЫЙ УРОВЕНЬ ИМЕНИ, А НЕ ВХОЖДЕНИЕ ПОДСТРОКИ.
 *
 * `includes('app')` увёл бы посетителя myapp.example.com в форму входа чужого продукта, а
 * application.nemo.uz — в кабинет. Оба случая выглядят как «сайт сломался».
 */
assert.equal(isAppHost('myapp.nemo.uz'), false, 'подстрока «app» принята за субдомен кабинета')
assert.equal(isAppHost('application.nemo.uz'), false)
assert.equal(isAppHost('nemo.uz/app'), false)

// Разработка и проверки идут на localhost, где один сервер отдаёт и промо, и кабинет.
for (const host of ['localhost', '127.0.0.1', '0.0.0.0', '::1']) {
  assert.equal(isAppHost(host), false, `на ${host} включилось разделение — проверки перестанут видеть промо`)
}
assert.equal(isAppHost(''), false, 'пустое имя хоста включило кабинет')
assert.equal(isAppHost(null), false)

assert.equal(rootRedirectFor('app.nemo.uz'), '/app')
assert.equal(rootRedirectFor('nemo.uz'), null, 'на промо-домене корень уводит в кабинет')
assert.equal(rootRedirectFor('localhost'), null)

const app = read('src/App.tsx')
assert.ok(/rootRedirectFor\(window\.location\.hostname\)/.test(app), 'корень не смотрит на хост')
assert.ok(/typeof window === 'undefined'/.test(app), 'обращение к window без проверки — падение при отрисовке на сервере')

// ─── CORS ─────────────────────────────────────────────────────────────────────────────────────────

/*
 * БЕЛЫЙ СПИСОК, А НЕ ЗВЁЗДОЧКА.
 *
 * `Access-Control-Allow-Origin: *` вместе с заголовком авторизации означает, что чужая страница
 * сможет дёргать функции от имени открывшего её пользователя. Здесь список источников проверяется
 * до запуска функции, и субдомен кабинета попадает в него через APP_URL.
 */
const cors = read('supabase/functions/_shared/cors.ts')
assert.ok(/function originAllowed/.test(cors), 'исчезла проверка источника')
assert.ok(/Deno\.env\.get\('APP_URL'\)/.test(cors), 'адрес кабинета не берётся из настройки — субдомен app.* не пройдёт')
assert.ok(/return new Response\('forbidden origin', \{ status: 403 \}\)/.test(cors), 'предзапрос с чужого источника не отвергается')
assert.ok(/Never reflect an arbitrary Origin/.test(cors), 'пропало предупреждение об отражении чужого источника')

console.log(`[OK] Legal pages, consent and host split: ${checks} assertions`)
