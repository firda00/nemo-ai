import { extractObservation } from './extract.js'

const ALLOWED_HOSTS = new Set(['uzum.uz', 'seller.uzum.uz'])

function isAllowedUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && ALLOWED_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'nemo:tab-status') return
  sendResponse({ allowed: isAllowedUrl(sender.tab?.url ?? '') })
})

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'nemo-sidepanel') return

  port.onMessage.addListener(async (message) => {
    if (message?.type !== 'nemo:observe-active-tab') return
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (!tab?.id || !isAllowedUrl(tab.url ?? '')) {
      port.postMessage({ type: 'nemo:observation-error', error: 'Откройте страницу uzum.uz или seller.uzum.uz, затем подключите вкладку.' })
      return
    }

    try {
      // Inject only after an explicit side-panel click. This is more reliable than
      // a persistent content script on SPA navigations and limits page access to
      // the tab the owner selected.
      // executeScript serialises `func` and runs the source in the page, so extractObservation
      // must stay self-contained — see the note at the top of extract.js.
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: extractObservation,
      })
      // Seller dashboards can render the visible app inside a nested frame, so every frame is
      // read and the longest answer wins. totalLength is the extracted content, not the raw page,
      // so this compares articles rather than letting a frame full of menu outrank a real one.
      const observation = results
        .map(({ result }) => result)
        .filter(Boolean)
        .sort((a, b) => b.totalLength - a.totalLength)[0]
      if (!observation) throw new Error('empty observation')
      port.postMessage({ type: 'nemo:observation', observation })
    } catch {
      port.postMessage({ type: 'nemo:observation-error', error: 'Не удалось прочитать выбранную вкладку. Закройте панель Nemo, обновите страницу Seller Uzum и попробуйте снова.' })
    }
  })
})
