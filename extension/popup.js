// Окно расширения. Показывает состояние и запускает один перенос.
//
// Кнопки две, и это не украшение. «Заполнить» ничего не отправляет — им пользуются, пока доверие
// к переносу не набрано. «Заполнить и отправить» делает необратимое, и потому названа полностью:
// кнопка со словом «отправить» не должна выглядеть как кнопка «продолжить».

const state = document.getElementById('state')
const result = document.getElementById('result')
const fill = document.getElementById('fill')
const send = document.getElementById('send')

const REASONS = {
  not_linked: 'Нет связи с Nemo. Откройте Nemo, войдите как владелец и нажмите «Связать с расширением».',
  selectors_missing: 'Разметка формы кабинета не заполнена — расширение не станет угадывать поля.',
  no_create_tab: 'Откройте в кабинете Uzum страницу создания товара: расширение работает на ней.',
  no_response: 'Страница кабинета не ответила. Обновите её и попробуйте снова.',
  human_needed: 'Нужен человек: на странице появился экран, который расширение не трогает.',
  too_long: 'Текст не влезает в лимиты Uzum. Сократите его в Nemo — обрезать посреди слова расширение не станет.',
  form_changed: 'Форма кабинета изменилась — разметку надо обновить.',
  network: 'Nemo сейчас недоступен.',
}

function show(node, text, kind) {
  node.textContent = text
  node.className = kind ? `state ${kind}` : 'state'
}

async function refresh() {
  const info = await chrome.runtime.sendMessage({ type: 'nemo:state' }).catch(() => null)
  if (!info) { show(state, 'Расширение не отвечает.', 'bad'); return }

  const blocked = !info.linked || !info.selectorsReady
  fill.disabled = blocked
  send.disabled = blocked

  if (!info.linked) { show(state, REASONS.not_linked, 'bad'); return }
  if (!info.selectorsReady) {
    show(state, `${REASONS.selectors_missing} Не размечены: ${info.missingSelectors.join(', ')}.`, 'bad')
    return
  }
  show(state, 'Связь с Nemo есть. Откройте страницу создания товара в кабинете Uzum.', 'ok')
}

async function run(submit) {
  fill.disabled = true
  send.disabled = true
  result.textContent = 'Работаю…'
  const answer = await chrome.runtime.sendMessage({ type: 'nemo:run', submit }).catch(() => null)

  if (!answer) result.textContent = 'Расширение не ответило.'
  else if (answer.idle) result.textContent = 'Готовых карточек нет — отправлять нечего.'
  else if (!answer.ok) result.textContent = answer.detail ?? REASONS[answer.reason] ?? `Не получилось: ${answer.reason}`
  else if (answer.advanced) result.textContent = 'Шаг 1 заполнен, перешли ко второму. Доведите карточку сами: шаги 2 и 3 Nemo пока не знает.'
  else result.textContent = answer.categoryTyped ? 'Поля заполнены, категория введена. Выберите полку из списка и нажмите «Принять».' : 'Поля заполнены. Выберите категорию и продолжите.'

  await refresh()
}

fill.addEventListener('click', () => void run(false))
send.addEventListener('click', () => void run(true))
void refresh()
