const port = chrome.runtime.connect({ name: 'nemo-sidepanel' })
const connect = document.querySelector('#connect')
const status = document.querySelector('#status')
const observation = document.querySelector('#observation')
const pairing = document.querySelector('#pairing')
const save = document.querySelector('#save')
let requestTimeout = null
let latestObservation = null

function finishRequest() {
  connect.disabled = false
  if (requestTimeout) clearTimeout(requestTimeout)
  requestTimeout = null
}

connect.addEventListener('click', () => {
  if (connect.disabled) return
  connect.disabled = true
  status.textContent = 'Подключаем вкладку в read-only режиме...'
  // A content script can disappear during page navigation. Never leave the
  // owner with a permanently disabled control when Chrome drops that message.
  requestTimeout = setTimeout(() => {
    finishRequest()
    status.textContent = 'Ответ от вкладки не получен. Обновите страницу Seller Uzum и повторите.'
  }, 6000)
  port.postMessage({ type: 'nemo:observe-active-tab' })
})

port.onMessage.addListener((message) => {
  finishRequest()
  if (message.type === 'nemo:observation-error') {
    status.textContent = message.error
    return
  }
  if (message.type !== 'nemo:observation') return

  const data = message.observation
  latestObservation = data
  document.querySelector('#title').textContent = data.title || 'Без названия'
  const url = document.querySelector('#url')
  url.href = data.url
  url.textContent = data.url
  document.querySelector('#body').textContent = data.bodyText || 'Текст страницы недоступен.'
  observation.hidden = false
  save.disabled = false
  connect.textContent = 'Обновить данные текущей вкладки'
  status.textContent = `Вкладка подключена: ${new Date(data.observedAt).toLocaleTimeString('ru-RU')}`
})

save.addEventListener('click', async () => {
  const secret = pairing.value.trim()
  if (!latestObservation || secret.length < 32) {
    status.textContent = 'Создайте и вставьте код связки в Nemo AI.'
    return
  }
  save.disabled = true
  status.textContent = 'Сохраняем snapshot в Nemo...'
  try {
    const response = await fetch('https://ogfmyjiuqmgroobckdyw.supabase.co/functions/v1/browser-bridge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'observe', secret, observation: latestObservation }),
    })
    const result = await response.json()
    if (!response.ok || !result.ok) throw new Error(result.error || 'save failed')
    pairing.value = ''
    status.textContent = 'Snapshot сохранён. Его смогут использовать агенты Nemo.'
  } catch {
    status.textContent = 'Не удалось сохранить snapshot. Проверьте код связки и попробуйте снова.'
  } finally { save.disabled = false }
})
