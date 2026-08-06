const MAX_TEXT_LENGTH = 8000

// A documentation page is mostly navigation. Taking the first 8000 characters of document.body
// took the Uzum manual's entire chapter list and stopped before section 3.2 — the snapshot looked
// successful and carried none of the tariff the owner had opened the page to capture.
//
// So prefer the region the page itself marks as its content, and fall back to whichever block has
// the most text when the page marks nothing. Nav, headers, footers and asides are dropped from the
// fallback: they are chrome on every page and never the reason someone took a snapshot.
const CONTENT_SELECTORS = ['main', 'article', '[role="main"]', '#content', '.content', '#main']
const CHROME_SELECTORS = 'nav, aside, header, footer, script, style, noscript, [role="navigation"]'

function textOf(node) {
  if (!node) return ''
  // innerText on a detached clone returns nothing, so strip chrome from a clone that stays in the
  // document long enough to be measured, then read it.
  const clone = node.cloneNode(true)
  for (const junk of clone.querySelectorAll(CHROME_SELECTORS)) junk.remove()
  clone.style.position = 'absolute'
  clone.style.left = '-99999px'
  clone.style.top = '0'
  document.body.appendChild(clone)
  const text = clone.innerText ?? clone.textContent ?? ''
  clone.remove()
  return text.replace(/\s+/g, ' ').trim()
}

function pageText() {
  for (const selector of CONTENT_SELECTORS) {
    const text = textOf(document.querySelector(selector))
    // A content region shorter than this is a stub — a breadcrumb bar or an empty shell — and the
    // whole page is the better answer.
    if (text.length > 200) return text
  }
  const stripped = textOf(document.body)
  return stripped || (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim()
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'nemo:observe') return
  const full = pageText()
  sendResponse({
    url: window.location.origin + window.location.pathname,
    title: document.title,
    bodyText: full.slice(0, MAX_TEXT_LENGTH),
    // Reported so a truncated capture is visible as truncated. A snapshot that silently lost the
    // half the owner needed is worse than one that says it did.
    totalLength: full.length,
    observedAt: new Date().toISOString(),
  })
})
