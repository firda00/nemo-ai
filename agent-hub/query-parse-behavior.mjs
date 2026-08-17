// Разбор запроса одной фразой + оформление экрана интерактива.
//
// Главное, что здесь защищается: разбор НЕ ДОЛЖЕН УГАДЫВАТЬ. Неверно угаданный город уводит прогон
// в другую страну, тратит кредиты и возвращает «ничего не найдено» без объяснения. Поэтому почти
// половина проверок ниже — про то, что разбор ЧЕСТНО вернул null и спросит человека.

import assert from 'node:assert/strict'
import { MAX_LIMIT, parseCommand, parseNaturalQuery } from './query-parse.mjs'
import { dashboard, statusMenu, visibleWidth } from './tui.mjs'
import { leadCard, phaseLine, renderLeadCards } from './lead-report.mjs'

// Цвет собирается из кода символа, а не пишется управляющим байтом в литерале: литеральный ESC уже
// пропадал при правке файлов этого проекта, и проверка ширины молча начинала мерить не то.
const color = (code, text) => `${String.fromCharCode(27)}[${code}m${text}${String.fromCharCode(27)}[0m`

let checks = 0
const check = (fn) => { fn(); checks++ }

// --- Полная фраза: всё вынимается сразу -----------------------------------------------------------

check(() => {
  const r = parseNaturalQuery('стоматология в Ташкенте 15')
  assert.equal(r.query, 'стоматология')
  assert.equal(r.city, 'Ташкенте')
  assert.equal(r.limit, 15)
})

// Число вынимается ПЕРВЫМ, иначе оно уедет в название ниши или в город.
check(() => assert.equal(parseNaturalQuery('стоматология в Ташкенте 15').query.includes('15'), false))
check(() => assert.equal(parseNaturalQuery('стоматология в Ташкенте 15').city.includes('15'), false))

// Слова-паразиты вокруг числа съедаются вместе с ним: «15 лидов» — это лимит, а не часть ниши.
check(() => assert.equal(parseNaturalQuery('кофейни в Бухаре 10 штук').query, 'кофейни'))
check(() => assert.equal(parseNaturalQuery('кофейни в Бухаре 10 штук').limit, 10))
check(() => assert.equal(parseNaturalQuery('автосервисы в Намангане 30 компаний').query, 'автосервисы'))
check(() => assert.equal(parseNaturalQuery('до 25 фитнес-клубов в Самарканде').limit, 25))
check(() => assert.equal(parseNaturalQuery('до 25 фитнес-клубов в Самарканде').query, 'фитнес-клубов'))

// Запятая на месте вынутого числа: без зачистки ниша уезжала в чужой API как «кофейни ,».
check(() => assert.equal(parseNaturalQuery('кофейни в Бухаре, 10 штук').query, 'кофейни'))
check(() => assert.equal(parseNaturalQuery('салоны красоты, 50').query, 'салоны красоты'))
check(() => assert.equal(parseNaturalQuery('пекарни — 20').query, 'пекарни'))

// --- Частичная фраза: недостающее остаётся null, а не подставляется ------------------------------

check(() => {
  const r = parseNaturalQuery('автосервис')
  assert.equal(r.query, 'автосервис')
  assert.equal(r.city, null, 'город не назван — спросим, а не возьмём Ташкент по умолчанию')
  assert.equal(r.limit, null, 'лимит не назван — спросим')
})

check(() => assert.equal(parseNaturalQuery('салоны красоты 50').city, null))
check(() => assert.equal(parseNaturalQuery('салоны красоты 50').limit, 50))

// Город БЕЗ предлога не угадывается: «стоматология Ташкент» может быть названием сети, и разобрать
// это надёжно нельзя. Лучше спросить, чем увезти прогон не туда.
check(() => assert.equal(parseNaturalQuery('стоматология Ташкент').city, null))
check(() => assert.equal(parseNaturalQuery('стоматология Ташкент').query, 'стоматология Ташкент'))

// «во» — отдельный предлог, иначе «во Владимире» разберётся как ниша «во Владимире».
check(() => assert.equal(parseNaturalQuery('пекарни во Владимире').city, 'Владимире'))
check(() => assert.equal(parseNaturalQuery('пекарни во Владимире').query, 'пекарни'))

// Берётся ПОСЛЕДНИЙ предлог: по первому город получался «бутылках в Фергане».
check(() => assert.equal(parseNaturalQuery('вода в бутылках в Фергане').city, 'Фергане'))
check(() => assert.equal(parseNaturalQuery('вода в бутылках в Фергане').query, 'вода в бутылках'))

// Город ВПЕРЕДИ — обычный порядок слов, и он не должен съедать нишу.
check(() => assert.equal(parseNaturalQuery('в Ташкенте стоматологии').city, 'Ташкенте'))
check(() => assert.equal(parseNaturalQuery('в Ташкенте стоматологии').query, 'стоматологии'))
check(() => assert.equal(parseNaturalQuery('в Фергане аптеки 20').limit, 20))

// Двухсловное название держится вместе: признак — заглавная буква второго слова.
check(() => assert.equal(parseNaturalQuery('пекарни в Нижнем Новгороде').city, 'Нижнем Новгороде'))
check(() => assert.equal(parseNaturalQuery('пекарни в Нижнем Новгороде').query, 'пекарни'))

// Всё строчными — останавливаемся на первом слове. Падеж потом снимет поиск границ города.
check(() => assert.equal(parseNaturalQuery('в ташкенте стоматологии').city, 'ташкенте'))
check(() => assert.equal(parseNaturalQuery('в ташкенте стоматологии').query, 'стоматологии'))

// Остаток числа, не ставшего лимитом, в название города не попадает.
check(() => assert.equal(parseNaturalQuery('клиники в Ташкенте 500').city, 'Ташкенте'))

// Запятая обрывает название: «Ташкенте,» с прилипшим знаком уедет в геокодер ровно в таком виде.
check(() => assert.equal(parseNaturalQuery('клиники в Ташкенте, только центр').city, 'Ташкенте'))

// Пустая строка не должна давать пустых строк вместо null: пустая ниша уйдёт в API как есть.
check(() => assert.deepEqual(parseNaturalQuery(''), { query: null, city: null, limit: null, rest: '' }))
check(() => assert.equal(parseNaturalQuery('   ').query, null))
check(() => assert.equal(parseNaturalQuery(null).query, null))
check(() => assert.equal(parseNaturalQuery(undefined).city, null))

// --- Границы лимита -------------------------------------------------------------------------------
// Число вне разумных границ — это НЕ лимит, а часть названия: «кофейни 2024» про год, а не про счёт.

check(() => assert.equal(parseNaturalQuery('стоматология в Ташкенте 0').limit, null, 'ноль лидов не заказывают'))
check(() => assert.equal(parseNaturalQuery('кофейни 2024 в Бухаре').limit, null, '2024 — не лимит'))
check(() => assert.equal(parseNaturalQuery('кофейни 2024 в Бухаре').query, 'кофейни 2024', 'год остался в нише'))
check(() => assert.equal(parseNaturalQuery(`клиники в Ташкенте ${MAX_LIMIT}`).limit, MAX_LIMIT))
check(() => assert.equal(parseNaturalQuery(`клиники в Ташкенте ${MAX_LIMIT + 1}`).limit, null))
check(() => assert.equal(parseNaturalQuery('клиники в Ташкенте 1').limit, 1))

// Исходная фраза сохраняется целиком: если разбор ошибся, восстановить сказанное можно.
check(() => assert.equal(parseNaturalQuery('  кофейни в Бухаре 10  ').rest, 'кофейни в Бухаре 10'))

// --- Команды --------------------------------------------------------------------------------------
// Команда отличается от запроса ровно ведущим слешем. Без этого «/exit» ушёл бы искать ниши.

check(() => assert.equal(parseCommand('/exit').name, 'exit'))
check(() => assert.equal(parseCommand('/HELP').name, 'help', 'регистр не важен'))
check(() => assert.deepEqual(parseCommand('/find кофейни').args, ['кофейни']))
check(() => assert.equal(parseCommand('стоматология'), null, 'обычный запрос командой не считается'))
check(() => assert.equal(parseCommand(''), null))
check(() => assert.equal(parseCommand('  /exit  ').name, 'exit', 'пробелы по краям не мешают'))
// Слеш ПОСРЕДИ строки командой не делает: «интернет-магазины b/w» — это запрос.
check(() => assert.equal(parseCommand('магазины /b'), null))

// --- Панель состояния: рамка не разъезжается от цвета ---------------------------------------------
// 'ESC[32mтекстESC[0m' занимает на экране столько же, сколько 'текст'. Если считать .length, правая
// стенка уезжает на девять позиций за каждый цвет, и панель превращается в лестницу.

check(() => {
  const box = dashboard({
    // Заголовок в настоящем вызове ТОЖЕ цветной, и его ширина считается тем же способом: с .length
    // верхняя граница уезжает на восемь позиций относительно нижней.
    title: color('1', 'Nemo SDR'),
    left: [color('35', 'NEMO'), 'Баланс: 100'],
    right: ['Как начать', color('36', 'ниша в город')],
  })
  const widths = new Set(box.split('\n').map((line) => visibleWidth(line)))
  assert.equal(widths.size, 1, `все строки рамки одной ширины, а получилось: ${[...widths].join(', ')}`)
})

// Пустая колонка не ломает рамку: строк слева и справа бывает разное количество.
check(() => {
  const box = dashboard({ title: 'X', left: ['a', 'b', 'c'], right: ['1'] })
  assert.equal(new Set(box.split('\n').map(visibleWidth)).size, 1)
  assert.equal(box.split('\n').length, 5, 'верх + три строки + низ')
})

// Заголовок вписан в верхнюю границу, а не напечатан над ней.
check(() => assert.ok(dashboard({ title: 'Nemo SDR', left: ['a'], right: ['b'] }).split('\n')[0].includes('Nemo SDR')))

// --- Меню одной строкой ---------------------------------------------------------------------------

check(() => {
  const menu = statusMenu([{ key: '1', label: 'CSV' }, { key: 'q', label: 'Выход' }])
  assert.ok(menu.includes('[1] CSV'))
  assert.ok(menu.includes('[q] Выход'))
  assert.equal(menu.includes('\n'), false, 'меню должно занимать одну строку — под ним сразу приглашение')
})

// --- Формулировка этапа ---------------------------------------------------------------------------
// Номер шага показываем ВСЕГДА: без «[2/3]» долгий этап выглядит как зависание, и прогон убивают.

check(() => assert.ok(phaseLine({ phase: 'search', step: 1, total: 3 }, 'Ташкент').startsWith('[1/3]')))
check(() => assert.ok(phaseLine({ phase: 'search', step: 1, total: 3 }, 'Ташкент').includes('Ташкент')))
check(() => assert.ok(phaseLine({ phase: 'clean', step: 2, total: 3 }, 'Ташкент').startsWith('[2/3]')))

// Технические имена фаз человеку не показываем — ни в одной ветке. Проверяется каждая, потому что
// формулировки живут в отдельных строках кода и «забыть» одну можно независимо от остальных.
for (const [phase, forbidden, expected] of [
  ['search', 'search', 'Поиск'],
  ['clean', 'clean', 'Очистка'],
  ['enrich_score', 'enrich', 'Обогащение'],
]) {
  check(() => assert.equal(phaseLine({ phase, step: 1, total: 3 }, 'Ташкент').includes(forbidden), false, `${phase}: техническое имя утекло`))
  check(() => assert.ok(phaseLine({ phase, step: 1, total: 3 }, 'Ташкент').includes(expected), `${phase}: нет человеческой формулировки`))
}
// Счётчик внутри этапа — единственный признак, что долгий шаг движется.
check(() => assert.ok(phaseLine({ phase: 'enrich_score', step: 3, total: 3, done: 4, of: 12 }, 'Ташкент').includes('4/12')))
check(() => assert.equal(phaseLine({ phase: 'enrich_score', step: 3, total: 3 }, 'Ташкент').includes('/'), true))
check(() => assert.equal(phaseLine({ phase: 'search', step: 1, total: 3 }, null).includes('null'), false, 'города нет — не печатаем «в null»'))

// --- Карточка лида --------------------------------------------------------------------------------

const hotLead = {
  name: 'Дента Люкс', city: 'Ташкент', phone: '+998 71 200-00-00', website: 'https://denta.uz',
  enrichment: { emails: ['info@denta.uz'], socials: { telegram: '@denta', instagram: '@denta_uz' }, people: [] },
  score: { score: 88, status: 'HOT', reason: 'много отзывов, нет онлайн-записи', icebreaker_pitch: 'Здравствуйте! Заметил…' },
}
const coldLead = { name: 'Стом Плюс', city: 'Ташкент', phone: '+998 71 300-00-00', enrichment: {}, score: { score: 30, status: 'COLD', reason: 'нет сайта' } }

check(() => assert.ok(leadCard(hotLead, 1).includes('1. Дента Люкс')))
check(() => assert.ok(leadCard(hotLead, 1).includes('88/100')))
check(() => assert.ok(leadCard(hotLead, 1).includes('+998 71 200-00-00')))
check(() => assert.ok(leadCard(hotLead, 1).includes('https://denta.uz')))
check(() => assert.ok(leadCard(hotLead, 1).includes('@denta')))
check(() => assert.ok(leadCard(hotLead, 1).includes('нет онлайн-записи')))

// Питч отделён ПУСТОЙ строкой и идёт последним: его выделяют мышью и копируют целиком, и любая наша
// строка, прилипшая снизу, уедет в чужой чат вместе с текстом.
check(() => {
  const lines = leadCard(hotLead, 1).split('\n')
  assert.ok(lines[lines.length - 1].includes('Здравствуйте!'), 'питч — последняя строка карточки')
  assert.equal(lines[lines.length - 2].trim(), '', 'над питчем пустая строка')
})

// Лид без питча не должен давать пустого хвоста.
check(() => assert.equal(leadCard(coldLead, 2).split('\n').at(-1).trim() === '', false))
// Лид без оценки — прочерк, а не «undefined/100».
check(() => assert.ok(leadCard({ name: 'Х', enrichment: {}, score: null }, 1).includes('—/100')))
check(() => assert.equal(leadCard({ name: 'Х', enrichment: {}, score: null }, 1).includes('undefined'), false))

// --- Экран результата -----------------------------------------------------------------------------

check(() => {
  const screen = renderLeadCards([hotLead, coldLead])
  assert.ok(screen.includes('Горячие лиды — 1'))
  assert.ok(screen.includes('Дента Люкс'))
  assert.equal(screen.includes('Стом Плюс'), false, 'холодных на экране интерактива не печатаем')
  assert.ok(screen.includes('ещё 1'), 'но говорим, что они есть — иначе выгрузка CSV выглядит бессмысленной')
})

// Горячих нет — говорим ЧИСЛОМ найденных. «Горячих нет» в пустоте читается как «поиск ничего не дал»,
// хотя лиды есть и их можно выгрузить тут же.
check(() => {
  const screen = renderLeadCards([coldLead, coldLead])
  assert.ok(screen.includes('Горячих нет'))
  assert.ok(screen.includes('2'), 'сколько всё-таки нашли')
})
check(() => assert.ok(renderLeadCards([]).includes('Горячих нет')))
check(() => assert.ok(renderLeadCards(null).includes('0'), 'ни один вход не должен ронять экран'))
check(() => assert.equal(renderLeadCards(undefined).includes('undefined'), false))

// Порог решает статус, но лид со статусом COLD и баллом 90 — противоречие, и полагаться в интерфейсе
// на один только status нельзя: пайплайн ставит оба поля, а старые записи в базе — не всегда.
check(() => assert.ok(renderLeadCards([{ name: 'Без статуса', enrichment: {}, score: { score: 90 } }]).includes('Без статуса')))

console.log(`[OK] Query parse + TUI redesign behaviour: ${checks} assertions`)
