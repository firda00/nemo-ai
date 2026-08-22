// Аудит разговора: проверка дословных цитат и отказ в безопасную сторону.
//
// ЧТО ЗДЕСЬ ЗАЩИЩАЕТСЯ. От этой оценки зависит премия менеджера. Модель, которую попросили
// проверить разговор, охотно напишет «потребность выявлена» там, где этого не было: связный отчёт
// для неё правдоподобнее рваного. Единственная защита — требовать дословную цитату и сверять её с
// расшифровкой.
//
// Проверки идут ПАРАМИ: рядом с каждым принятым доказательством стоит отвергнутое, отличающееся
// ровно тем, из-за чего его нельзя принимать. Ослабить сверку легко, а заметить это нечем —
// отчёты продолжат выглядеть убедительно.
//
// Запуск: npm run test:sales-qa
import assertStrict from 'node:assert/strict'

const { buildAuditPrompt, buildReport, isEvidenceValid, normalizeForMatch } = await import('./modules/sales-qa/auditor.ts')
const { DEFAULT_PLAYBOOK, PlaybookCatalog, validatePlaybook } = await import('./modules/sales-qa/playbook.ts')

let checks = 0
const assert = new Proxy(assertStrict, {
  get: (target, key) => {
    const value = target[key]
    if (typeof value !== 'function') return value
    return (...args) => { checks++; return value.apply(target, args) }
  },
})

const TRANSCRIPT = [
  '0:03 Менеджер: Здравствуйте, меня зовут Азиз, компания «Ромашка», звоню по вашей заявке.',
  '0:11 Клиент: Да, здравствуйте, слушаю.',
  '0:14 Менеджер: Вам сейчас удобно говорить пару минут?',
  '0:18 Клиент: Удобно.',
  '0:22 Менеджер: Расскажите, какую задачу вы хотите закрыть в первую очередь?',
  '0:31 Клиент: У нас заявки теряются между отделами.',
  '1:05 Менеджер: Давайте я перезвоню во вторник в одиннадцать и принесу расчёт.',
].join('\n')

// ── Нормализация: снимает оформление, но не слова ─────────────────────────────────────────────
{
  assert.equal(normalizeForMatch('Ёлка,  «тест»!'), 'елка "тест"')
  // Порядок слов сохраняется: иначе проверка начнёт принимать пересказ вместо цитаты.
  assert.notEqual(normalizeForMatch('удобно говорить'), normalizeForMatch('говорить удобно'))
}

// ── Годное доказательство ─────────────────────────────────────────────────────────────────────
{
  const good = { quote: 'Вам сейчас удобно говорить пару минут', timestamp: '0:14' }
  assert.equal(isEvidenceValid(good, TRANSCRIPT), true, 'дословная цитата с временем отвергнута')

  // Отличается регистром и кавычками — обязана приниматься: это то же самое предложение.
  assert.equal(isEvidenceValid({ quote: 'ВАМ СЕЙЧАС УДОБНО ГОВОРИТЬ ПАРУ МИНУТ', timestamp: '00:14' }, TRANSCRIPT), true)
}

// ── Негодное: каждый случай отдельно ──────────────────────────────────────────────────────────
{
  const cases = [
    ['цитаты нет в расшифровке', { quote: 'Менеджер предложил скидку двадцать процентов', timestamp: '0:40' }],
    ['пересказ вместо цитаты', { quote: 'менеджер спросил про удобство разговора', timestamp: '0:14' }],
    ['нет отметки времени', { quote: 'Вам сейчас удобно говорить пару минут', timestamp: '' }],
    ['время не похоже на время', { quote: 'Вам сейчас удобно говорить пару минут', timestamp: 'начало' }],
    ['слишком короткая цитата', { quote: 'Удобно', timestamp: '0:18' }],
    ['пустое доказательство', null],
    ['слова переставлены', { quote: 'говорить удобно сейчас вам пару минут', timestamp: '0:14' }],
  ]
  for (const [name, evidence] of cases) {
    assert.equal(isEvidenceValid(evidence, TRANSCRIPT), false, `принято негодное доказательство: ${name}`)
  }
}

/*
 * ── ОТКАЗ В БЕЗОПАСНУЮ СТОРОНУ ────────────────────────────────────────────────────────────────
 *
 * Заявленное без цитаты обязано стать НЕПОДТВЕРЖДЁННЫМ с нулём, а не остаться выполненным.
 * Обратный выбор дал бы систему, которая тем сильнее завышает оценки, чем лучше модель пишет.
 */
{
  const raw = {
    stages: [
      { stageId: 1, status: 'done', score: 3, evidence: { quote: 'меня зовут Азиз, компания «Ромашка»', timestamp: '0:03' }, note: '' },
      // Заявлено, но цитаты в расшифровке нет.
      { stageId: 3, status: 'done', score: 3, evidence: { quote: 'менеджер подробно выявил все потребности клиента', timestamp: '0:31' }, note: '' },
      // Заявлено частично и тоже без подтверждения: лазейку «писать partial» надо закрыть.
      { stageId: 4, status: 'partial', score: 2, evidence: null, note: '' },
      { stageId: 2, status: 'done', score: 3, evidence: { quote: 'Вам сейчас удобно говорить пару минут', timestamp: '0:14' }, note: '' },
      { stageId: 5, status: 'not_applicable', score: 0, evidence: null, note: 'возражений не было' },
      { stageId: 6, status: 'done', score: 3, evidence: { quote: 'перезвоню во вторник в одиннадцать', timestamp: '1:05' }, note: '' },
    ],
    criteria: [
      // Годный: цитата длиннее порога и есть в расшифровке.
      { code: 'honesty', score: 3, evidence: { quote: 'принесу расчёт', timestamp: '1:05' }, note: '' },
      // Негодный: цитаты в расшифровке нет — оценка обязана обнулиться, как у этапов.
      { code: 'listening', score: 3, evidence: { quote: 'менеджер ни разу не перебил собеседника', timestamp: '0:31' }, note: '' },
    ],
    summary: 'Разговор проведён по сценарию.',
    recommendations: ['Уточнять бюджет до предложения'],
  }
  const report = buildReport(raw, DEFAULT_PLAYBOOK, TRANSCRIPT)

  const byId = new Map(report.stages.map((one) => [one.stageId, one]))
  assert.equal(byId.get(1).status, 'done', 'подтверждённый этап понижен зря')
  assert.equal(byId.get(3).status, 'unverified', 'этап без цитаты остался выполненным')
  assert.equal(byId.get(3).score, 0, 'у неподтверждённого этапа осталась оценка')
  assert.equal(byId.get(3).evidence, null, 'ложное доказательство осталось в отчёте')
  assert.equal(byId.get(4).status, 'unverified', '«частично» без цитаты прошло — лазейка открыта')

  assert.equal(report.downgraded.length, 2, 'понижения не показаны человеку')
  assert.ok(report.downgraded.every((one) => one.reason), 'понижение без объяснения причины')

  /*
   * НЕПРИМЕНИМЫЙ ЭТАП ИСКЛЮЧЁН ИЗ ЗНАМЕНАТЕЛЯ.
   *
   * Разговор без возражений не должен терять баллы за неотработанное возражение — иначе вежливый
   * клиент портит менеджеру оценку. Считаем руками: этапы 1,2,6 по 3 балла с весами 1,1,2;
   * этапы 3,4 неподтверждены (0) с весами 2,2; этап 5 неприменим и не считается.
   */
  const earned = 1 * 3 + 1 * 3 + 2 * 3
  const possible = (1 + 1 + 2 + 2 + 2) * 3
  assert.equal(report.scorePercent, Math.round((earned / possible) * 100), 'итог посчитан не по весам')

  assert.deepEqual(report.weakStages.sort((a, b) => a - b), [3, 4], 'слабые зоны определены неверно')
  // Критерии проверяются тем же порядком, что и этапы: подтверждённый живёт, заявленный — нет.
  const criteria = new Map(report.criteria.map((one) => [one.code, one]))
  assert.equal(criteria.get('honesty').score, 3, 'подтверждённый критерий обнулён зря')
  assert.equal(criteria.get('listening').score, 0, 'критерий без цитаты в расшифровке не обнулён')
  assert.equal(criteria.get('listening').evidence, null, 'ложное доказательство критерия осталось')
}

// Пропущенный моделью этап не исчезает: иначе знаменатель тихо уменьшается и итог завышается.
{
  const partial = buildReport({ stages: [{ stageId: 1, status: 'done', score: 3, evidence: { quote: 'меня зовут Азиз, компания «Ромашка»', timestamp: '0:03' } }], criteria: [] }, DEFAULT_PLAYBOOK, TRANSCRIPT)
  assert.equal(partial.stages.length, DEFAULT_PLAYBOOK.stages.length, 'неразобранные этапы потерялись')
  assert.ok(partial.issues.some((one) => /не разобрала этап/.test(one)), 'о неразобранных этапах не сказано')
  assert.ok(partial.scorePercent < 40, `итог завышен на неполном разборе: ${partial.scorePercent}%`)
}

// Чужой этап и чужой критерий не принимаются: модель не должна расширять сценарий сама.
{
  const alien = buildReport({ stages: [{ stageId: 99, status: 'done', score: 3 }], criteria: [{ code: 'выдумка', score: 3 }] }, DEFAULT_PLAYBOOK, TRANSCRIPT)
  assert.ok(alien.issues.some((one) => /этап 99/.test(one)))
  assert.ok(alien.issues.some((one) => /выдумка/.test(one)))
  assert.equal(alien.criteria.length, 0)
}

// ── Сценарии как данные, без имён заказчиков ──────────────────────────────────────────────────
{
  assert.deepEqual(validatePlaybook(DEFAULT_PLAYBOOK), [], 'сценарий по умолчанию сам себя не проходит')

  // Негодный сценарий отвергается ПРИ ДОБАВЛЕНИИ, а не через час делением на ноль.
  const catalog = new PlaybookCatalog()
  assert.throws(() => catalog.add({ id: 'bad', title: 'x', language: 'ru', stages: [], criteria: [] }), /негоден/)
  assert.throws(() => catalog.add({
    id: 'zero', title: 'x', language: 'ru',
    stages: [{ id: 1, title: 'a', expectation: 'b', weight: 0 }], criteria: [],
  }), /сумма весов/)
  assert.throws(() => catalog.add({
    id: 'dup', title: 'x', language: 'ru',
    stages: [{ id: 1, title: 'a', expectation: 'b', weight: 1 }, { id: 1, title: 'c', expectation: 'd', weight: 1 }],
    criteria: [],
  }), /повторяются/)

  // Свой сценарий заказчика принимается без правки кода — ради этого перенос и делался.
  catalog.add({
    id: 'clinic-intake', title: 'Запись в клинику', language: 'uz',
    stages: [{ id: 1, title: 'Приветствие', expectation: 'Назвал клинику', weight: 1 }],
    criteria: [{ code: 'tone', title: 'Тон', expectation: 'Вежливо' }],
  })
  assert.equal(catalog.list().length, 2)
  assert.equal(catalog.get('clinic-intake').language, 'uz')
  assert.equal(catalog.get('нет-такого'), null)
}

/*
 * ── НИ ОДНОГО ИМЕНИ ЗАКАЗЧИКА В КОДЕ ──────────────────────────────────────────────────────────
 *
 * Ради этого перенос и затевался: в исходном модуле сценарий был константой с именем одного
 * клиента, и таких упоминаний по коду было двадцать четыре. Модуль с зашитым именем продаётся
 * ровно одному — второму он достаётся вместе с правкой исходников.
 */
{
  const fs = (await import('node:fs')).default
  const path = (await import('node:path')).default
  const dir = path.resolve(import.meta.dirname, 'modules')
  const files = []
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) files.push(full)
    }
  }
  walk(dir)
  assert.ok(files.length >= 3, 'модули не найдены')

  const VENDORS = /ustudy|dojim|metasell|ромашка/i
  const dirty = files.filter((file) => VENDORS.test(fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '')))
  assert.deepEqual(dirty.map((f) => path.basename(f)), [], 'в коде модулей осталось имя заказчика')
}

/*
 * ── ЦИТАТА ПРИВЯЗАНА К МОМЕНТУ ────────────────────────────────────────────────────────────────
 *
 * Без привязки цитата проверялась на вхождение в расшифровку ЦЕЛИКОМ — и один удачный фрагмент
 * годился доказательством всех шести этапов сразу. Модель повторяла его с шестью разными отметками
 * и получала сто процентов; в отчёте это выглядело безупречно.
 */
{
  const quote = 'Вам сейчас удобно говорить пару минут'
  assert.equal(isEvidenceValid({ quote, timestamp: '0:14' }, TRANSCRIPT), true)
  // Та же цитата с чужой отметкой — отвергается, хотя слова в расшифровке есть.
  assert.equal(isEvidenceValid({ quote, timestamp: '0:03' }, TRANSCRIPT), false)
  // Отметка, которой в расшифровке нет вовсе.
  assert.equal(isEvidenceValid({ quote, timestamp: '7:42' }, TRANSCRIPT), false)

  // Время, НАЗВАННОЕ В РЕЧИ, разметкой не считается: иначе кусок рвался бы посреди фразы.
  const spoken = ['0:05 Менеджер: Договорились, в 11:00 я пришлю расчёт и наберу вас.'].join('\n')
  assert.equal(isEvidenceValid({ quote: 'в 11:00 я пришлю расчёт', timestamp: '0:05' }, spoken), true)

  // Расшифровка без разметки проверяется по-старому — на вхождение. Отвергать её целиком значило бы
  // отказываться разбирать целый класс входных данных вместо того, чтобы разобрать их честно, но хуже.
  const plain = 'Менеджер представился и договорился о следующем шаге во вторник.'
  assert.equal(isEvidenceValid({ quote: 'договорился о следующем шаге', timestamp: '0:01' }, plain), true)
}

/*
 * ── ОДНА ЦИТАТА — ОДИН ЭТАП ───────────────────────────────────────────────────────────────────
 *
 * Остаток той же дыры: привязка к моменту не мешает сослаться на ОДНУ отметку из всех этапов.
 */
{
  const evidence = { quote: 'Вам сейчас удобно говорить пару минут', timestamp: '0:14' }
  const report = buildReport({
    stages: [
      { stageId: 1, status: 'done', score: 3, evidence, note: '' },
      { stageId: 2, status: 'done', score: 3, evidence, note: '' },
      { stageId: 3, status: 'done', score: 3, evidence, note: '' },
    ],
    criteria: [],
  }, DEFAULT_PLAYBOOK, TRANSCRIPT)

  assert.equal(report.stages.find((one) => one.stageId === 1).status, 'done', 'первому этапу цитата зачтена')
  for (const id of [2, 3]) {
    assert.equal(report.stages.find((one) => one.stageId === id).status, 'unverified')
  }
  assert.ok(report.downgraded.some((one) => /уже засчитана другому этапу/.test(one.reason)))
}

/*
 * ── ОБХОДЫ ЗАПРЕТА ПОВТОРА ────────────────────────────────────────────────────────────────────
 *
 * Проверка на повтор ценна ровно настолько, насколько её нельзя обойти записью того же самого
 * другими знаками. Две лазейки, обе выглядят как разные доказательства и обе ими не являются.
 */
{
  const quote = 'Вам сейчас удобно говорить пару минут'
  const twoStages = (a, b) => buildReport({
    stages: [
      { stageId: 1, status: 'done', score: 3, evidence: a, note: '' },
      { stageId: 2, status: 'done', score: 3, evidence: b, note: '' },
    ],
    criteria: [],
  }, DEFAULT_PLAYBOOK, TRANSCRIPT).stages.find((one) => one.stageId === 2).status

  // «0:14» и «00:14» — одно и то же время, записанное по-разному.
  assert.equal(twoStages({ quote, timestamp: '0:14' }, { quote, timestamp: '00:14' }), 'unverified')
  // Та же цитата, обрезанная с краю, — то же доказательство.
  assert.equal(
    twoStages({ quote: 'Менеджер: Вам сейчас удобно говорить пару минут', timestamp: '0:14' }, { quote, timestamp: '0:14' }),
    'unverified',
  )
}

/*
 * ── ОТМЕТКА ВРЕМЕНИ: ФОРМА И РАЗМЕТКА ─────────────────────────────────────────────────────────
 */
{
  const quote = 'Вам сейчас удобно говорить пару минут'

  /*
   * «1:60» и «2:00» — это 120 секунд и там, и там.
   *
   * Расшифровка нарочно СОДЕРЖИТ отметку 2:00: без неё проверка проходила бы просто потому, что
   * куска на 120 секунд нет вовсе, и ослабление формата отметки осталось бы незамеченным.
   */
  const withTwoMinutes = [
    '0:14 Менеджер: Вам сейчас удобно говорить пару минут?',
    '2:00 Менеджер: Тогда я пришлю расчёт и наберу вас в среду утром.',
  ].join('\n')
  assert.equal(isEvidenceValid({ quote: 'я пришлю расчёт и наберу вас', timestamp: '2:00' }, withTwoMinutes), true)
  assert.equal(
    isEvidenceValid({ quote: 'я пришлю расчёт и наберу вас', timestamp: '1:60' }, withTwoMinutes),
    false,
    'несуществующая отметка 1:60 принята как 2:00',
  )
  assert.equal(isEvidenceValid({ quote, timestamp: '0:14:00' }, TRANSCRIPT), false)

  /*
   * Разметка списком — та же разметка.
   *
   * Не узнав её, разбор молча переходил в слабый режим «цитата есть где-то в тексте»: любая цитата
   * подходила к любой отметке. Выглядело это как работающая привязка к моменту.
   */
  const bulleted = [
    '- 0:03 Менеджер: Здравствуйте, меня зовут Азиз, компания «Ромашка», звоню по вашей заявке.',
    '- 0:14 Менеджер: Вам сейчас удобно говорить пару минут?',
  ].join('\n')
  assert.equal(isEvidenceValid({ quote, timestamp: '0:14' }, bulleted), true)
  assert.equal(isEvidenceValid({ quote, timestamp: '0:03' }, bulleted), false, 'разметка списком не распознана — привязка отключилась')

  // Одно и то же время дважды: расшифровки, склеенные из двух дорожек. Цитата из второго куска
  // должна приниматься — это ложное отрицание, а не лазейка, но менеджеру от него не легче.
  const twoTracks = [
    '0:14 Менеджер: Вам сейчас удобно говорить пару минут?',
    '0:14 Клиент: Да, вполне удобно, я как раз освободился.',
  ].join('\n')
  assert.equal(isEvidenceValid({ quote: 'я как раз освободился', timestamp: '0:14' }, twoTracks), true)
}

/*
 * ── НЕПРИМЕНИМЫМ ЭТАП ОБЪЯВЛЯЕТ СЦЕНАРИЙ ──────────────────────────────────────────────────────
 *
 * Неприменимый этап выпадает из знаменателя. Отдать это решение модели — значит отдать ей ключ от
 * итога: пять этапов «неприменимы», шестой подтверждён, сто процентов из ничего.
 */
{
  const one = {
    stageId: 1, status: 'done', score: 3,
    evidence: { quote: 'меня зовут Азиз, компания «Ромашка»', timestamp: '0:03' }, note: '',
  }
  const rest = [2, 3, 4, 5, 6].map((id) => ({ stageId: id, status: 'not_applicable', score: 0, evidence: null, note: '' }))
  const report = buildReport({ stages: [one, ...rest], criteria: [] }, DEFAULT_PLAYBOOK, TRANSCRIPT)

  assert.notEqual(report.scorePercent, 100, 'массовое «неприменимо» дало сто процентов из ничего')
  // Условный этап 5 остаётся неприменимым — он объявлен таким в сценарии.
  assert.equal(report.stages.find((item) => item.stageId === 5).status, 'not_applicable')
  // Обязательные 2, 3, 4, 6 — нет.
  for (const id of [2, 3, 4, 6]) {
    assert.equal(report.stages.find((item) => item.stageId === id).status, 'unverified', `этап ${id}`)
  }
  // Веса 1,1,2,2,1,2. Условный пятый (вес 1) исключён, остальные восемь остались:
  // подтверждён только этап 1 на 3 балла → 1*3 / (8*3) = 3/24 = 13 %.
  assert.equal(report.scorePercent, 13)
}

// Промпт несёт сценарий целиком и прямо предупреждает о сверке цитат.
{
  const prompt = buildAuditPrompt(DEFAULT_PLAYBOOK, TRANSCRIPT)
  for (const stage of DEFAULT_PLAYBOOK.stages) {
    assert.ok(prompt.includes(stage.expectation), `в промпте нет определения этапа ${stage.id}`)
  }
  assert.match(prompt, /Цитата сверяется автоматически/, 'модель не предупреждена о сверке')
  assert.match(prompt, /ИМЕННО В НАЗВАННЫЙ МОМЕНТ/, 'модель не предупреждена о сверке отметки времени')
  assert.match(prompt, /Одна цитата подтверждает ОДИН этап/, 'модель не предупреждена о запрете повтора')
  assert.match(prompt, /Не выдумывай цитат/)

  /*
   * Условность этапа названа В ПРОМПТЕ, а не только проверяется после.
   *
   * Разбор отвергает not_applicable у обязательного этапа. Если модель об этом не предупредить, она
   * будет ставить его добросовестно и получать «не подтверждено» — то есть проверка превратится в
   * источник шума вместо источника честности.
   */
  assert.match(prompt, /1\. Представление \(вес 1\) \[обязательный\]/)
  assert.match(prompt, /5\. Работа с возражением \(вес 1\) \[условный: может быть неприменим\]/)
  assert.match(prompt, /not_applicable допустим ТОЛЬКО у этапов, помеченных выше как условные/)
}

console.log(`[OK] Sales QA: ${checks} assertions`)
