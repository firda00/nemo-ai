const MAX_TEXT_LENGTH = 20000

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'nemo:observe') return
  const bodyText = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LENGTH)
  sendResponse({
    url: window.location.href,
    title: document.title,
    bodyText,
    observedAt: new Date().toISOString(),
  })
})
