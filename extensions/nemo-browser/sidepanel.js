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

// Restore the pairing from the last successful save so the owner pastes a code once per
// pairing rather than once per snapshot.
chrome.storage.local.get('nemoPairing', ({ nemoPairing }) => {
  if (nemoPairing && !pairing.value) pairing.value = nemoPairing
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
    // The code is NOT cleared any more. A pairing is valid for eight hours, but wiping the
    // field after one snapshot forced the owner back to Nemo to copy a fresh hash every single
    // time — the busywork that made this flow feel like a technical gate.
    chrome.storage.local.set({ nemoPairing: secret })
    status.textContent = 'Snapshot сохранён. Его смогут использовать агенты Nemo.'
  } catch (error) {
    // Report what actually failed. "Check your pairing code" was shown for every cause,
    // including a server-side bug that had nothing to do with the code.
    const reason = String(error?.message ?? '')
    status.textContent = reason === 'pairing expired or revoked'
      ? 'Код связки истёк или отозван. Создайте новый в Nemo → Интеграции.'
      : reason === 'invalid observation'
        ? 'Эта страница не с Uzum. Откройте вкладку uzum.uz или seller.uzum.uz.'
        : `Не удалось сохранить snapshot: ${reason || 'нет ответа от Nemo'}.`
  } finally { save.disabled = false }
})
