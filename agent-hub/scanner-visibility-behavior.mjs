// Что попадает в снимок страницы, а что нет.
//
// Проверка видимости — единственное, что отделяет поля формы от служебного мусора разметки. Ошибка
// в любую сторону дорога: пропустив спрятанное, агент отдаёт модели ловушку вместо поля; отбросив
// лишнее, теряет половину формы и отвечает «нечего заполнять» на полностью рабочей странице.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const source = fs.readFileSync(path.join(root, 'extension/scanner.js'), 'utf8')

/** Элемент макета: задаём то, что читает проверка, — стиль, прямоугольник, offsetParent. */
function makeElement({ style = {}, box = { width: 200, height: 32, top: 10, bottom: 42, left: 0, right: 200 }, offsetParent = {}, attrs = {} } = {}) {
  return {
    offsetParent,
    attrs,
    getAttribute(name) { return this.attrs[name] ?? null },
    getBoundingClientRect() { return box },
    __style: { display: 'block', visibility: 'visible', opacity: '1', position: 'static', ...style },
  }
}

function load() {
  const windowStub = {
    innerHeight: 800,
    getComputedStyle: (element) => element.__style,
  }
  const factory = new Function('window', 'document', 'location', `${source}\nreturn { visible, kindOf }`)
  return factory(windowStub, { querySelectorAll: () => [], title: '' }, { href: '' })
}

const { visible } = load()

// --- Нормальное поле проходит -------------------------------------------------------------------

assert.equal(visible(makeElement()), true)
// Поле НИЖЕ СГИБА — обычное положение длинной формы, а не способ спрятать. Именно здесь ломается
// напрашивающаяся проверка «попадает ли элемент в текущий экран»: на форме создания товара почти
// все поля лежат ниже первого экрана, и снимок потерял бы почти всё.
assert.equal(visible(makeElement({ box: { width: 200, height: 32, top: 4200, bottom: 4232, left: 0, right: 200 } })), true,
  'поле ниже сгиба остаётся в снимке')
// Прокрученное ВВЕРХ за верхний край — тоже нормальное положение: человек может прокрутить обратно.
assert.equal(visible(makeElement({ box: { width: 200, height: 32, top: -20, bottom: 12, left: 0, right: 200 } })), true)

// --- Служебная кнопка 1×1 за экраном — тот самый мусор ---------------------------------------------
// Найдено в живом кабинете: <button id="support-button"> с left:-9999px и размером 1×1 занимал
// первый номер в снимке и участвовал в разборе наравне с настоящими полями.

const supportButton = makeElement({
  style: { position: 'absolute' },
  box: { width: 1, height: 1, top: 0, bottom: 1, left: -9999, right: -9998 },
})
assert.equal(visible(supportButton), false, 'кнопка 1×1 за левым краем в снимок не попадает')

// Каждая из двух причин отбрасывает сама по себе.
assert.equal(visible(makeElement({ box: { width: 1, height: 1, top: 10, bottom: 11, left: 10, right: 11 } })), false,
  'размер 1×1 — не элемент управления')
assert.equal(visible(makeElement({ box: { width: 200, height: 32, top: 10, bottom: 42, left: -9999, right: -9799 } })), false,
  'уведено за левый край — прокруткой не вернуть')

// Граница размера проверяется явно, а не «примерно там».
assert.equal(visible(makeElement({ box: { width: 8, height: 8, top: 0, bottom: 8, left: 0, right: 8 } })), true)
assert.equal(visible(makeElement({ box: { width: 7, height: 8, top: 0, bottom: 8, left: 0, right: 7 } })), false)

// --- Обычные способы спрятать ------------------------------------------------------------------------

assert.equal(visible(makeElement({ style: { display: 'none' } })), false)
assert.equal(visible(makeElement({ style: { visibility: 'hidden' } })), false)
assert.equal(visible(makeElement({ style: { opacity: '0' } })), false)
assert.equal(visible(makeElement({ style: { clipPath: 'inset(100%)' } })), false)
assert.equal(visible(makeElement({ attrs: { 'aria-hidden': 'true' } })), false)
// opacity 0.01 — это видимое поле, просто бледное. Отбрасывать по «похоже на ноль» нельзя.
assert.equal(visible(makeElement({ style: { opacity: '0.01' } })), true)

// --- offsetParent: ловушка с position: fixed ----------------------------------------------------------
// У элементов с position: fixed offsetParent равен null ВСЕГДА. Проверка «offsetParent === null →
// спрятан» отбросила бы плавающую панель формы, которая прекрасно видна на экране.

assert.equal(visible(makeElement({ offsetParent: null })), false, 'обычный элемент без offsetParent спрятан')
assert.equal(visible(makeElement({ offsetParent: null, style: { position: 'fixed' } })), true,
  'плавающая панель видима, хотя offsetParent у неё null')

console.log('[OK] Scanner visibility behaviour: 16 assertions')
