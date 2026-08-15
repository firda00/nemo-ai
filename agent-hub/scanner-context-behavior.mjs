// Контекст поля: собственная карточка и текст над ней.
//
// richtext-редакторы носят с собой панель инструментов — кнопки «жирный», «курсив», «ссылка».
// Если считать эти кнопки «другим полем» (как считался весь INTERACTIVE), подъём вверх
// останавливался на первом же предке с панелью, и подпись поля, стоящая ВЫШЕ панели, никогда не
// попадала в контекст: richtext-поле выглядело для модели безымянным и оставалось незаполненным.
// Проверяется, что подъём проходит СКВОЗЬ панель инструментов, но по-прежнему останавливается на
// границе с ДРУГИМ полем — то самое разделение, ради которого ownCard вообще существует.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const source = fs.readFileSync(path.join(root, 'extension/scanner.js'), 'utf8')

function load(src) {
  const factory = new Function('window', 'document', 'location',
    `${src}\nreturn { ownCard, nearbyText }`)
  return factory({}, { querySelectorAll: () => [] }, { href: '' })
}

/** Мини-DOM: parentElement, querySelectorAll (не заходит в тень — здесь она и не нужна), innerText. */
function matchesPart(node, part) {
  part = part.trim()
  let m = part.match(/^([a-z]+):not\(\[(\w+)="([^"]*)"\]\)$/)
  if (m) return node.tag === m[1] && node.attrs[m[2]] !== m[3]
  m = part.match(/^([a-z]+)\[(\w+)\]$/)
  if (m) return node.tag === m[1] && node.attrs[m[2]] != null
  m = part.match(/^\[(\w+)="([^"]*)"\]$/)
  if (m) return node.attrs[m[1]] === m[2]
  m = part.match(/^\[(\w+)\]$/)
  if (m) return node.attrs[m[1]] != null
  return node.tag === part
}
const matchesSelector = (node, selector) => selector.split(',').some((part) => matchesPart(node, part))

function el(tag, { attrs = {}, text = '', children = [] } = {}) {
  const node = { tag, attrs, __text: text, children: [], parentElement: null }
  for (const child of children) { child.parentElement = node; node.children.push(child) }
  node.querySelectorAll = (selector) => {
    const out = []
    const walk = (from) => {
      for (const child of from.children) {
        if (matchesSelector(child, selector)) out.push(child)
        walk(child)
      }
    }
    walk(node)
    return out
  }
  Object.defineProperty(node, 'innerText', {
    get() { return [node.__text, ...node.children.map((c) => c.innerText)].filter(Boolean).join(' ') },
  })
  node.textContent = ''
  node.getAttribute = (name) => node.attrs[name] ?? null
  return node
}

// --- Сценарий с живой страницы: панель инструментов между подписью и редактором ------------------
//
// labelWrapper ("Полное описание на русском *")
//   └── editorWrapper
//         ├── toolbar: button("Ж"), button("К")   ← панель инструментов, НЕ другое поле
//         └── contentWrapper
//               └── richtext (contenteditable)
//
// Кнопки панели носят видимый короткий текст («Ж», «К») специально: это тот случай, где старая
// проверка находила ИХ текст раньше текста подписи и останавливалась, набрав в контекст мусор
// вместо смысла.

function buildRichTextForm() {
  const richtext = el('div', { attrs: { contenteditable: 'true' } })
  const contentWrapper = el('div', { children: [richtext] })
  const toolbar = el('div', { children: [
    el('button', { text: 'Ж' }),
    el('button', { text: 'К' }),
  ] })
  const editorWrapper = el('div', { children: [toolbar, contentWrapper] })
  const labelWrapper = el('div', { text: 'Полное описание на русском *', children: [editorWrapper] })
  return { richtext, contentWrapper, editorWrapper, labelWrapper }
}

{
  const api = load(source)
  const { richtext, editorWrapper, labelWrapper } = buildRichTextForm()

  assert.equal(api.ownCard(richtext), labelWrapper,
    'подъём проходит сквозь панель инструментов до самой подписи — кнопки Ж/К не считаются другим полем')
  assert.ok(api.nearbyText(richtext).includes('Полное описание'),
    'подпись, стоящая НАД панелью инструментов, попадает в контекст richtext-поля')

  void editorWrapper // используется только для наглядности структуры выше
}

// --- Регресс-защита: два соседних поля по-прежнему не делятся контекстом -------------------------
// Ради этого разделения ownCard вообще существует — фикс не должен его сломать.

function buildTwoTitles() {
  const input1 = el('input', { attrs: { type: 'text' } })
  const input2 = el('input', { attrs: { type: 'text' } })
  const row1 = el('div', { text: 'на русском', children: [input1] })
  const row2 = el('div', { text: 'на узбекском', children: [input2] })
  const container = el('div', { children: [row1, row2] })
  return { input1, input2, row1, container }
}

{
  const api = load(source)
  const { input1, input2, row1 } = buildTwoTitles()

  assert.equal(api.ownCard(input1), row1, 'своя карточка поля — его собственная строка, не общий контейнер')
  assert.ok(api.nearbyText(input1).includes('на русском'))
  assert.ok(!api.nearbyText(input1).includes('на узбекском'),
    'сосед не примешивается — иначе оба поля получили бы оба языка сразу')
  assert.ok(!api.nearbyText(input2).includes('на русском'))
}

console.log('[OK] Scanner context behaviour: 6 assertions')
