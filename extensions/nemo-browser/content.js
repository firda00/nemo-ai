const MAX_TEXT_LENGTH = 8000

// A documentation page is mostly navigation. Taking the first 8000 characters of document.body
// took the Uzum manual's entire chapter list and stopped before section 3.2 — the snapshot looked
// successful and carried none of the tariff the owner had opened the page to capture.
//
// Semantic tags would be the easy answer, but a page is free not to use them, and a sidebar built
// from plain divs would defeat a nav/aside filter completely. What a menu cannot hide is that it
// is made of links: a chapter list is close to 100% link text, and prose with a price table is
// not. So candidates are scored by how much NON-link text they hold, and the winner is the
// smallest block that still holds nearly all of it.
const CONTENT_SELECTORS = ['main', 'article', '[role="main"]']
const MIN_CONTENT_LENGTH = 200

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

/** Text length, and how much of it sits inside links. */
function measure(element) {
  const text = clean(element.innerText)
  let linked = 0
  for (const link of element.querySelectorAll('a')) linked += clean(link.innerText).length
  return { text, length: text.length, prose: Math.max(0, text.length - linked) }
}

function pageText() {
  const body = document.body
  if (!body) return ''

  // A page that says what its content is gets believed, as long as it says something.
  for (const selector of CONTENT_SELECTORS) {
    const element = document.querySelector(selector)
    if (!element) continue
    const { text, prose } = measure(element)
    if (prose > MIN_CONTENT_LENGTH) return text
  }

  // Otherwise find it: walk down while one child holds MORE PROSE THAN ALL ITS SIBLINGS COMBINED.
  // That is the step out of <body> (menu plus article) and into the article alone, and it stops as
  // soon as the prose splits across several children — which is what a section of paragraphs looks
  // like, and where descending further would start dropping half the page.
  //
  // Majority rather than "keeps nearly all of it": a menu leaves residue behind — list markers and
  // whitespace outside its links — and requiring 90% let 119 characters of that residue anchor the
  // walk to the block that still contained the whole chapter list.
  let best = body
  let bestMeasure = measure(body)
  for (;;) {
    let winner = null
    let winnerMeasure = null
    for (const child of best.children) {
      if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|NAV|ASIDE|HEADER|FOOTER)$/.test(child.tagName)) continue
      const candidate = measure(child)
      if (candidate.prose <= (winnerMeasure?.prose ?? 0)) continue
      winner = child
      winnerMeasure = candidate
    }
    if (!winner || winnerMeasure.prose * 2 <= bestMeasure.prose) break
    best = winner
    bestMeasure = winnerMeasure
  }
  // No length floor here. The walk starts at <body> and only ever descends into a child holding
  // most of the prose, so the answer cannot be worse than the whole page — while "too short, send
  // everything" would answer a short article with the chapter list it was hiding behind.
  return bestMeasure.text
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'nemo:observe') return
  const full = pageText()
  sendResponse({
    url: window.location.origin + window.location.pathname,
    title: document.title,
    bodyText: full.slice(0, MAX_TEXT_LENGTH),
    // Reported so a truncated capture is visible as truncated. A snapshot that silently lost the
    // half the owner needed reads as a complete one, and the last one cost a day of reasoning
    // about a tariff that was never in it.
    totalLength: full.length,
    observedAt: new Date().toISOString(),
  })
})
