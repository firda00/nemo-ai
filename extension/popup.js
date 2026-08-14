// Окно расширения — командная строка.
//
// Владелец пишет поручение своими словами, Nemo смотрит страницу и предлагает действия. Всё, что
// здесь читается, приходит из messages.js на его языке: ни одного технического слова.

import { pickLang, say } from './messages.js'

const nodes = {
  title: document.getElementById('title'),
  intro: document.getElementById('intro'),
  state: document.getElementById('state'),
  instruction: document.getElementById('instruction'),
  risky: document.getElementById('risky'),
  riskyLabel: document.getElementById('riskyLabel'),
  run: document.getElementById('run'),
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

function paintChrome() {
  nodes.title.textContent = say('title', lang)
  nodes.intro.textContent = say('intro', lang)
  nodes.run.textContent = say('run', lang)
  nodes.riskyLabel.textContent = say('allowRisky', lang)
  nodes.instruction.placeholder = say('placeholder', lang)
}

async function refresh() {
  paintChrome()
  const info = await chrome.runtime.sendMessage({ type: 'nemo:state' }).catch(() => null)
  const linked = Boolean(info?.linked)
  nodes.run.disabled = !linked
  nodes.state.className = linked ? 'state ok' : 'state bad'
  nodes.state.textContent = say(linked ? 'ready' : 'not_linked', lang)
}

/**
 * Исход одного поручения — человеческим языком.
 *
 * Число заполненных полей называется всегда, даже когда всё получилось. «Готово» без числа не
 * позволяет отличить заполненную форму от формы, где сработал один шаг из пяти.
 */
function describe(answer) {
  if (!answer) return say('no_response', lang)
  if (!answer.ok) {
    if (answer.needsConfirmation) return say('needs_confirmation', lang)
    const known = say(answer.reason, lang)
    if (known) return known
    if (answer.reason === 'no_plan') return `${say('no_plan', lang)}${answer.note ? `\n${answer.note}` : ''}`
    return say('no_plan', lang)
  }
  const lines = [`${say('filledCount', lang)} ${answer.done}`]
  if (answer.failed) lines.push(`${say('failedCount', lang)} ${answer.failed}`)
  if (answer.needsConfirmation) lines.push(say('needs_confirmation', lang))
  if (answer.note) lines.push(answer.note)
  return lines.join('\n')
}

async function run() {
  const instruction = nodes.instruction.value.trim()
  if (!instruction) { nodes.instruction.focus(); return }
  nodes.run.disabled = true
  nodes.result.textContent = say('working', lang)
  const answer = await chrome.runtime.sendMessage({
    type: 'nemo:instruct',
    instruction,
    // Согласие передаётся ЯВНО и каждый раз: галочка не запоминается между запусками, потому что
    // разрешение, выданное однажды, через неделю нажимает кнопку, о которой уже забыли.
    confirmRisky: nodes.risky.checked,
  }).catch(() => null)
  nodes.result.textContent = describe(answer)
  await refresh()
}

nodes.run.addEventListener('click', () => void run())
nodes.instruction.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void run()
})

for (const button of document.querySelectorAll('.lang button')) {
  button.addEventListener('click', async () => {
    lang = button.dataset.lang
    // Язык — настройка вида, а не секрет: ему место в local. Токен доступа по-прежнему в session.
    await chrome.storage.local.set({ lang })
    await loadLang()
    nodes.result.textContent = ''
    await refresh()
  })
}

void loadLang().then(refresh)
