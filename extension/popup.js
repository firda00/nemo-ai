// Окно расширения. Одна кнопка и одна фраза о том, что происходит.
//
// Всё, что владелец здесь читает, приходит из messages.js на его языке. Ни одного технического
// слова: расширение говорит, какой у него следующий шаг, а не какая у нас внутренняя причина.

import { fieldList, pickLang, say } from './messages.js'

const nodes = {
  title: document.getElementById('title'),
  intro: document.getElementById('intro'),
  state: document.getElementById('state'),
  fill: document.getElementById('fill'),
  result: document.getElementById('result'),
}

let lang = pickLang()

async function loadLang() {
  const stored = await chrome.storage.local.get('lang')
  lang = pickLang(stored?.lang)
  for (const button of document.querySelectorAll('.lang button')) {
    button.setAttribute('aria-pressed', String(button.dataset.lang === lang))
  }
}

function show(node, text, kind) {
  node.textContent = text
  if (node === nodes.state) node.className = kind ? `state ${kind}` : 'state'
}

/** Статические подписи. Перерисовываются при смене языка вместе со всем остальным. */
function paintChrome() {
  nodes.title.textContent = say('title', lang)
  nodes.intro.textContent = say('intro', lang)
  nodes.fill.textContent = say('fill', lang)
}

async function refresh() {
  paintChrome()
  const info = await chrome.runtime.sendMessage({ type: 'nemo:state' }).catch(() => null)
  if (!info) { show(nodes.state, say('no_response', lang), 'bad'); nodes.fill.disabled = true; return }

  if (!info.linked) { show(nodes.state, say('not_linked', lang), 'bad'); nodes.fill.disabled = true; return }
  if (!info.selectorsReady) { show(nodes.state, say('selectors_missing', lang), 'bad'); nodes.fill.disabled = true; return }
  nodes.fill.disabled = false
  show(nodes.state, say('ready', lang), 'ok')
}

/**
 * Исход одного заполнения — одной фразой.
 *
 * Ключи полей превращаются в слова: «описание на русском», а не «descriptionRu». Список того, что
 * осталось дописать руками, важнее самого факта успеха — по нему видно, доделана карточка или нет.
 */
function describe(answer) {
  if (!answer) return say('no_response', lang)
  if (answer.idle) return say('idle', lang)

  if (!answer.ok) {
    if (answer.reason === 'too_long') {
      // Числа оставляем как есть: «95 из 90» понятно без перевода и говорит, насколько сокращать.
      const list = (answer.tooLong ?? []).map((one) => {
        const [key, numbers] = String(one).split(':')
        return `${fieldList([key.trim()], lang)} — ${(numbers ?? '').trim()}`
      }).join('; ')
      return `${say('tooLong', lang)} ${list}`
    }
    return say(answer.reason, lang) || say('form_changed', lang)
  }

  if (answer.skipped?.length) return `${say('doneSkipped', lang)} ${fieldList(answer.skipped, lang)}`
  return say('done', lang)
}

async function run() {
  nodes.fill.disabled = true
  show(nodes.result, say('working', lang))
  const answer = await chrome.runtime.sendMessage({ type: 'nemo:run' }).catch(() => null)
  show(nodes.result, describe(answer))
  await refresh()
}

nodes.fill.addEventListener('click', () => void run())

for (const button of document.querySelectorAll('.lang button')) {
  button.addEventListener('click', async () => {
    lang = button.dataset.lang
    // Язык — настройка вида, а не секрет: ему место в local, где он переживёт закрытие браузера.
    // Токен доступа по-прежнему живёт только в session.
    await chrome.storage.local.set({ lang })
    await loadLang()
    nodes.result.textContent = ''
    await refresh()
  })
}

void loadLang().then(refresh)
