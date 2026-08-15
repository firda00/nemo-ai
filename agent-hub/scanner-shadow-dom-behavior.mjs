// Обход shadow DOM: сканер должен находить поля внутри веб-компонентов, а не только снаружи них.
//
// document.querySelectorAll не заглядывает в открытый shadowRoot — это поведение браузера, не наша
// ошибка. Страница, целиком собранная из веб-компонентов, снаружи выглядела бы почти пустой: ровно
// то, что показал живой отчёт («в DOM: 1») на кабинете Uzum. Проверяется, что рекурсивный обход
// находит то, что обычный запрос теряет, — и что при этом он не пытается заглянуть в ЗАКРЫТЫЙ shadow
// root, куда снаружи страницы нет доступа в принципе.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const source = fs.readFileSync(path.join(root, 'extension/scanner.js'), 'utf8')

function load() {
  const factory = new Function('window', 'document', 'location',
    `${source}\nreturn { queryAllDeep, countShadowHosts, looksUnrendered }`)
  return factory({}, {}, { href: '' })
}

const api = load()

/**
 * Мок-узел с той же семантикой querySelectorAll, что и настоящий DOM: обходит светлое дерево
 * рекурсивно, но НЕ спускается сам внутрь shadowRoot дочернего узла. От этого зависит весь тест —
 * если мок будет заглядывать в shadow root сам, queryAllDeep останется непроверенным ровно на том
 * случае, ради которого он написан.
 */
function node({ mark = null, children = [], shadow = null } = {}) {
  const self = { mark, children, shadowRoot: shadow }
  self.querySelectorAll = (selector) => {
    const out = []
    const walk = (from) => {
      for (const child of from.children) {
        if (selector === '*' || child.mark === selector) out.push(child)
        walk(child)
      }
    }
    walk(self)
    return out
  }
  return self
}

// --- Светлый DOM виден и без обхода — обход это не должен ломать -------------------------------

{
  const field = node({ mark: 'FIELD' })
  const light = node({ children: [field] })
  assert.deepEqual(light.querySelectorAll('FIELD'), [field], 'контрольная проверка самого мока')
  assert.deepEqual(api.queryAllDeep(light, 'FIELD'), [field], 'светлый DOM виден и через обход')
}

// --- Поле внутри открытого shadow root: обычный запрос его не видит, обход — видит -------------

{
  const innerField = node({ mark: 'FIELD' })
  const shadowRoot = node({ children: [innerField] })
  const host = node({ shadow: shadowRoot })
  const page = node({ children: [host] })

  assert.deepEqual(page.querySelectorAll('FIELD'), [],
    'обычный querySelectorAll не видит поле в shadow root — это и даёт "в DOM: 1" на живой странице')
  assert.deepEqual(api.queryAllDeep(page, 'FIELD'), [innerField],
    'обход находит поле, спрятанное в открытом shadow root')
}

// --- Смесь: часть полей снаружи, часть — внутри компонента. Обход находит оба и не задваивает ---

{
  const outside = node({ mark: 'FIELD' })
  const inside = node({ mark: 'FIELD' })
  const host = node({ shadow: node({ children: [inside] }) })
  const page = node({ children: [outside, host] })

  const found = api.queryAllDeep(page, 'FIELD')
  assert.equal(found.length, 2, 'найдено и снаружи, и внутри компонента — ни один не потерян и не задвоен')
  assert.ok(found.includes(outside) && found.includes(inside))
}

// --- Вложенность: веб-компонент внутри веб-компонента -------------------------------------------

{
  const deepField = node({ mark: 'FIELD' })
  const innerHost = node({ shadow: node({ children: [deepField] }) })
  const outerHost = node({ shadow: node({ children: [innerHost] }) })
  const page = node({ children: [outerHost] })

  assert.deepEqual(api.queryAllDeep(page, 'FIELD'), [deepField],
    'обход спускается сквозь два вложенных shadow root подряд')
}

// --- ЗАКРЫТЫЙ shadow root: element.shadowRoot === null для него, и это не чинится ----------------
// Браузер не отдаёт доступ к closed shadow root вообще — ни querySelectorAll, ни обходу. Это не
// недосмотр, а граница того, что вообще видно снаружи страницы.

{
  const closedHost = node({ shadow: null })
  const page = node({ children: [closedHost] })
  assert.deepEqual(api.queryAllDeep(page, 'FIELD'), [],
    'closed shadow root остаётся невидимым — element.shadowRoot для него null')
}

// --- countShadowHosts: считает открытые корни, включая вложенные --------------------------------

{
  const innerHost = node({ shadow: node({ children: [] }) })
  const outerHost = node({ shadow: node({ children: [innerHost] }) })
  const page = node({ children: [outerHost] })
  assert.equal(api.countShadowHosts(page), 2, 'считает и внешний, и вложенный shadow root')
}

assert.equal(api.countShadowHosts(node({ children: [node({ mark: 'FIELD' })] })), 0,
  'страница без единого веб-компонента — ноль')

// --- looksUnrendered: решает, стоит ли подождать SPA и пересканировать --------------------------
// raw=1 — не гипотеза, это цифра из живого отчёта на кабинете Uzum. domTotal отличает «страница ещё
// не отрисовалась» (узлов мало вообще) от «форма спрятана глубже, но узлов на странице много».

assert.equal(api.looksUnrendered({ raw: 1, domTotal: 4 }), true,
  'ровно тот случай из живого отчёта — сканер ждёт и пересканирует')
assert.equal(api.looksUnrendered({ raw: 0, domTotal: 0 }), true, 'совсем пустая страница тоже ждёт')
assert.equal(api.looksUnrendered({ raw: 40, domTotal: 300 }), false, 'нормальная отрисованная форма — ждать незачем')
assert.equal(api.looksUnrendered({ raw: 1, domTotal: 500 }), false,
  'узлов много, а интерактивных мало — это не "ещё не отрисовалось", ждать бесполезно')
assert.equal(api.looksUnrendered({ raw: 3, domTotal: 10 }), false, 'порог raw ровно на границе не срабатывает')

console.log('[OK] Scanner shadow DOM behaviour: 15 assertions')
