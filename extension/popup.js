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
  media: document.getElementById('media'),
  mediaLabel: document.getElementById('mediaLabel'),
  mediaCount: document.getElementById('mediaCount'),
  risky: document.getElementById('risky'),
  riskyLabel: document.getElementById('riskyLabel'),
  run: document.getElementById('run'),
  diagnose: document.getElementById('diagnose'),
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
  nodes.diagnose.textContent = say('diagnose', lang)
  nodes.instruction.placeholder = say('placeholder', lang)
  nodes.mediaLabel.textContent = say('mediaLabel', lang)
  nodes.mediaCount.textContent = nodes.media.files?.length
    ? say('mediaCount', lang).replace('{count}', String(nodes.media.files.length))
    : say('mediaEmpty', lang)
}

const MAX_MEDIA_FILES = 8
const MAX_MEDIA_FILE_BYTES = 8 * 1024 * 1024
const MAX_MEDIA_TOTAL_BYTES = 32 * 1024 * 1024
const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('read_failed'))
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsDataURL(file)
  })
}

async function selectedMedia() {
  const files = [...(nodes.media.files ?? [])]
  if (!files.length) return []
  if (files.length > MAX_MEDIA_FILES) throw new Error('too_many_media')
  if (files.some((file) => !ALLOWED_MEDIA_TYPES.has(file.type))) throw new Error('unsupported_media')
  if (files.some((file) => file.size <= 0 || file.size > MAX_MEDIA_FILE_BYTES)) throw new Error('media_too_large')
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_MEDIA_TOTAL_BYTES) throw new Error('media_total_too_large')
  return await Promise.all(files.map(async (file) => ({
    name: file.name,
    type: file.type,
    size: file.size,
    dataUrl: await readAsDataUrl(file),
  })))
}

async function refresh() {
  paintChrome()
  const info = await chrome.runtime.sendMessage({ type: 'nemo:state' }).catch(() => null)
  const linked = Boolean(info?.linked)
  nodes.run.disabled = !linked
  nodes.state.className = linked ? 'state ok' : 'state bad'
  // «Не связывались» и «связь просрочена» — разные беды: во втором случае человек уже делал
  // то, что ему советуют, и повторять совет дословно значит выглядеть сломанным.
  const recentRun = info?.browserRun && Date.now() - Number(info.browserRun.updatedAt ?? 0) < 15 * 60 * 1000
    ? info.browserRun : null
  nodes.state.textContent = linked && recentRun?.status === 'running'
    ? say('autonomousRunning', lang).replace('{step}', String(recentRun.step ?? 0))
    : say(linked ? 'ready' : info?.expired ? 'expired' : 'not_linked', lang)
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
    // Категория страницы не совпадает с черновиком: заполненные ПРАВИЛЬНЫМИ по формату значениями
    // поля — не в ту карточку — это не мелкая неточность, а гарантированный отказ модерации.
    // Составное сообщение, а не статичная фраза из словаря: обе категории называются прямо.
    if (answer.reason === 'category_mismatch') {
      return [
        say('categoryMismatch', lang),
        `${say('onPage', lang)}: ${answer.pageCategory || '—'}`,
        `${say('inDraft', lang)}: ${answer.draftCategory || '—'}`,
        say('categoryMismatchConfirm', lang),
      ].join('\n')
    }
    const known = say(answer.reason, lang)
    if (known && answer.reason !== 'no_plan') return known

    // «Модель ничего не предложила» и «наша проверка всё отвергла» — разные беды, и вторую
    // владелец починить не может вовсе. Совет «уточните поручение» там вреден: он посылает не туда.
    const lines = [say('no_plan', lang)]
    if (answer.note) lines.push(answer.note)
    if (answer.rejected?.length) lines.push(`${say('rejected', lang)} ${answer.rejected.length}`)
    return lines.join('\n')
  }
  if (answer.submitted) return say('submitted', lang)
  const lines = [`${say('filledCount', lang)} ${answer.done}`]
  if (answer.failed) lines.push(`${say('failedCount', lang)} ${answer.failed}`)
  if (answer.needsConfirmation) lines.push(say('needs_confirmation', lang))
  // «Готово, заполнено 4» молчит про остальные 5 полей формы. Владелец должен узнать, что часть
  // карточки план вообще не тронул, — иначе решит, что заполнено ВСЁ, и отправит её такой.
  if (answer.unaddressed?.length) lines.push(`${say('notAddressed', lang)} ${answer.unaddressed.length}`)
  if (answer.note) lines.push(answer.note)
  return lines.join('\n')
}

// Согласие продолжить, несмотря на расхождение категорий, — как и confirmRisky, спрашивается
// заново на каждом запуске и не переживает попытку. Отдельного чекбокса для него нет: он нужен
// только сразу ПОСЛЕ предупреждения, и постоянная галочка «игнорировать несовпадение категории»
// в интерфейсе — это ровно то самое молчаливое согласие, которого confirmRisky и избегает.
let pendingCategoryConfirm = false

async function run() {
  const instruction = nodes.instruction.value.trim()
  if (!instruction) { nodes.instruction.focus(); return }
  nodes.run.disabled = true
  nodes.result.textContent = say('working', lang)
  const confirmCategoryMismatch = pendingCategoryConfirm
  pendingCategoryConfirm = false
  let attachments = []
  try {
    attachments = await selectedMedia()
  } catch (error) {
    nodes.result.textContent = say(error instanceof Error ? error.message : 'unsupported_media', lang)
    nodes.run.disabled = false
    return
  }
  const answer = await chrome.runtime.sendMessage({
    type: 'nemo:instruct',
    instruction,
    // Согласие передаётся ЯВНО и каждый раз: галочка не запоминается между запусками, потому что
    // разрешение, выданное однажды, через неделю нажимает кнопку, о которой уже забыли.
    confirmRisky: nodes.risky.checked,
    confirmCategoryMismatch,
    attachments,
  }).catch(() => null)
  if (answer && !answer.ok && answer.reason === 'category_mismatch') pendingCategoryConfirm = true
  nodes.result.textContent = describe(answer)
  if (answer?.ok) nodes.media.value = ''
  await refresh()
}

/**
 * Отчёт о проблеме одним нажатием.
 *
 * Работает ДАЖЕ БЕЗ СВЯЗИ с Nemo: именно тогда он и нужен. Кнопка, отключённая вместе с основной,
 * оставила бы человека без единственного способа рассказать, что у него не так.
 */
async function diagnose() {
  nodes.diagnose.disabled = true
  nodes.result.textContent = say('working', lang)
  const answer = await chrome.runtime.sendMessage({ type: 'nemo:diagnose' }).catch(() => null)
  const text = answer?.text ?? ''
  if (!text) { nodes.result.textContent = say('no_response', lang); nodes.diagnose.disabled = false; return }
  try {
    await navigator.clipboard.writeText(text)
    nodes.result.textContent = `${say('diagnoseDone', lang)}\n\n${text}`
  } catch {
    // Буфер может быть недоступен. Текст всё равно показывается — иначе отчёт, который нельзя
    // скопировать автоматически, пропал бы совсем.
    nodes.result.textContent = `${say('diagnoseFail', lang)}\n\n${text}`
  }
  nodes.diagnose.disabled = false
}

nodes.diagnose.addEventListener('click', () => void diagnose())
nodes.run.addEventListener('click', () => void run())
nodes.instruction.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void run()
})
nodes.media.addEventListener('change', paintChrome)

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
