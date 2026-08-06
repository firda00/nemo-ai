// The one page extractor. It is injected into the tab by background.js through
// chrome.scripting.executeScript, which SERIALISES the function and runs the text in the page —
// so everything it needs lives inside it. No imports, no module-scope helpers, no free names.
//
// It has to live in exactly one place. The first version of this logic went into content.js, a
// file the manifest never registered: Chrome never loaded it, the snapshot never changed, and it
// took three retakes to notice the fix was in code that does not run.
//
// What it solves: a documentation page is mostly navigation. Reading document.body from the top
// took the Uzum manual's entire chapter list and stopped before section 3.2 — the snapshot looked
// successful and carried none of the tariff the owner had opened the page to capture.
//
// Semantic tags would be the easy answer, but a page is free not to use them, and this one builds
// its sidebar from plain divs. What a menu cannot hide is that it is made of links: a chapter list
// is close to 100% link text, prose with a price table is not. So blocks are scored by the text
// that is NOT inside an anchor.
export function extractObservation() {
  const CONTENT_SELECTORS = ['main', 'article', '[role="main"]']
  const MIN_CONTENT_LENGTH = 200
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|SVG|NAV|ASIDE|HEADER|FOOTER)$/

  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

  // Text length, and how much of it sits inside links. textContent is a fallback for layouts that
  // deliberately leave innerText empty.
  const measure = (element) => {
    const text = clean(element.innerText || element.textContent)
    let linked = 0
    for (const link of element.querySelectorAll('a')) linked += clean(link.innerText || link.textContent).length
    return { text, length: text.length, prose: Math.max(0, text.length - linked) }
  }

  const pageText = () => {
    const body = document.body
    if (!body) return ''

    // A page that says what its content is gets believed, as long as it says something.
    for (const selector of CONTENT_SELECTORS) {
      const element = document.querySelector(selector)
      if (!element) continue
      const found = measure(element)
      if (found.prose > MIN_CONTENT_LENGTH) return found.text
    }

    // Otherwise find it: walk down while one child holds MORE PROSE THAN ALL ITS SIBLINGS
    // COMBINED. That is the step out of the page (menu plus article) and into the article alone,
    // and it stops as soon as the prose splits across several children — which is what a section
    // of paragraphs looks like, and where descending further would drop half the page.
    //
    // Majority rather than "keeps nearly all of it": a menu leaves residue behind — list markers
    // and whitespace outside its links — and requiring 90% let 119 characters of that residue
    // anchor the walk to the block that still contained the whole chapter list.
    let best = body
    let bestMeasure = measure(body)
    for (;;) {
      let winner = null
      let winnerMeasure = null
      for (const child of best.children) {
        if (SKIP.test(child.tagName)) continue
        const candidate = measure(child)
        if (candidate.prose <= (winnerMeasure ? winnerMeasure.prose : 0)) continue
        winner = child
        winnerMeasure = candidate
      }
      if (!winner || winnerMeasure.prose * 2 <= bestMeasure.prose) break
      best = winner
      bestMeasure = winnerMeasure
    }
    // No length floor here. The walk starts at <body> and only ever descends into a child holding
    // most of the prose, so the answer cannot be worse than the whole page — while "too short,
    // send everything" would answer a short article with the chapter list it was hiding behind.
    return bestMeasure.text
  }

  const full = pageText()
  return {
    url: window.location.href,
    title: document.title,
    bodyText: full.slice(0, 20000),
    // Reported so a truncated capture is visible as truncated. A snapshot that silently lost the
    // half the owner needed reads as a complete one, and one such capture cost a day of reasoning
    // about a tariff that was never in it.
    totalLength: full.length,
    observedAt: new Date().toISOString(),
  }
}
