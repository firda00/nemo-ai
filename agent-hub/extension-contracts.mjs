// Границы расширения, записанные проверками.
//
// Расширение работает в чужом кабинете вашей сессией. Всё, что здесь проверяется, — это обещания
// из README, которые иначе остались бы обещаниями: их легко нарушить одной строкой и не заметить.

import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

const manifest = JSON.parse(read('extension/manifest.json'))
const background = read('extension/background.js')
const content = read('extension/content.js')
const nemo = read('extension/nemo.js')
const selectors = read('extension/selectors.js')
const popup = read('extension/popup.js')
const readme = read('extension/README.md')
const control = read('supabase/functions/commerce-control/index.ts')
const migration = read('supabase/migrations/20260813160000_extension_submit.sql')
const link = read('src/lib/extensionLink.ts')
const page = read('src/pages/app/CommercePage.tsx')

const NEMO_ORIGIN = 'https://nemo.185.8.213.144.sslip.io'

const contracts = [
  // ── Область действия ───────────────────────────────────────────────────────────────────────

  // Расширение с доступом ко всем сайтам не должен ставить никто, включая владельца продукта.
  ['the extension reaches exactly one host',
    Array.isArray(manifest.host_permissions)
    && manifest.host_permissions.length === 1
    && manifest.host_permissions[0] === 'https://seller.uzum.uz/*'],

  ['no wildcard host slips in through content scripts',
    manifest.content_scripts.every((script) =>
      script.matches.every((match) => match === 'https://seller.uzum.uz/*'))],

  ['nothing asks for all-urls, tabs history or cookies',
    !JSON.stringify(manifest).includes('<all_urls>')
    && !JSON.stringify(manifest).includes('*://*/*')
    && !manifest.permissions.includes('cookies')
    && !manifest.permissions.includes('webRequest')
    && !manifest.permissions.includes('history')],

  // Manifest V3: service worker вместо фоновой страницы, иначе это расширение прошлой эпохи.
  ['it is a manifest v3 extension',
    manifest.manifest_version === 3 && manifest.background?.service_worker === 'background.js'],

  // ── Учётные данные ─────────────────────────────────────────────────────────────────────────

  // Пароль расширение не видит: вход остаётся на сайте, сюда приезжает короткий токен сессии.
  ['the extension never handles a password',
    !/password/i.test(background) && !/password/i.test(popup) && !/password/i.test(nemo)
    && !manifest.permissions.includes('identity')],

  // Токен на диске переживает вкладку, вечер и следующего человека за этим компьютером.
  ['the session lives in session storage, not on disk',
    nemo.includes('chrome.storage.session.set')
    && !nemo.includes('chrome.storage.local')],

  // Настройка манифеста ограничивает домен, но полагаться на неё ОДНУ при приёме учётных данных
  // нельзя: проверка отправителя стоит и в коде.
  ['the sender origin is checked in code, not only in the manifest',
    manifest.externally_connectable?.matches?.length === 1
    && manifest.externally_connectable.matches[0] === `${NEMO_ORIGIN}/*`
    && background.includes(`origin !== '${NEMO_ORIGIN}'`)
    && background.indexOf('forbidden_origin') < background.indexOf('saveSession(message.session)')],

  // Протухшая сессия — это «свяжитесь заново», а не «нет прав». Токен забывается сразу.
  ['an expired session is dropped, not retried',
    nemo.includes('if (response.status === 401)') && nemo.includes('await forgetSession()')],

  // ── Связь сайта с расширением ──────────────────────────────────────────────────────────────

  // Без ответа на ping сайт не отличает «не установлено» от «установлено и отказало» и показывает
  // «поставьте расширение» тому, у кого оно стоит.
  ['the extension answers whether it is installed and linked',
    background.includes("message?.type === 'nemo:ping'")
    && background.includes('sendResponse({ ok: true, linked: Boolean(session) })')
    && link.includes("ask({ type: 'nemo:ping' })")],

  // Refresh token выпускает новые сессии сколько угодно долго. Его утечка стоит дороже, чем
  // неудобство связаться заново раз в час.
  ['only the short-lived token crosses to the extension',
    link.includes('session: { access_token: session.access_token, expires_at: session.expires_at }')
    && !link.includes('refresh_token')
    && !page.includes('refresh_token')],

  // Идентификатор распакованного расширения выводится из пути к папке: перенесли — сменился.
  // Зашитое намертво значение молча перестало бы находиться.
  ['the extension id is configurable, not welded in',
    link.includes('import.meta.env.VITE_NEMO_EXTENSION_ID')],

  // Флаг в базе показывал бы «связано» и после того, как расширение снесли.
  ['the site asks the extension itself, not the database',
    page.includes('void extensionState().then(')
    && !page.includes('pilot?.extension_linked')],

  // Chrome не бросает исключение на неизвестный идентификатор — он выставляет lastError и зовёт
  // колбэк. Не прочитать его значит получить «Unchecked runtime.lastError» на каждой загрузке.
  ['a missing extension is handled, not thrown',
    link.includes('chromeRuntime.lastError')
    && link.includes('window.setTimeout(() => finish(null), 3000)')],

  // ── Чего расширение не делает ──────────────────────────────────────────────────────────────

  // Вариант А (перехват токена вкладки Uzum и вызов внутренних адресов) отвергнут: это обход
  // контроля доступа площадки, а не автоматизация разрешённого действия.
  ['it does not touch the tab own credentials or hidden endpoints',
    !content.includes('localStorage')
    && !content.includes('sessionStorage')
    && !content.includes('document.cookie')
    && !/fetch\(\s*['"`]https:\/\/(api-)?seller\.uzum\.uz/.test(content)
    && !/XMLHttpRequest/.test(content)],

  // Расширение, которое начинает работать само, однажды заполнит форму, открытую посмотреть.
  ['the content script acts only when asked',
    content.includes("chrome.runtime.onMessage.addListener")
    && content.includes("message?.type !== 'nemo:fill'")
    // Ни одного вызова заполнения или клика вне обработчика сообщения. Сверяется именно ВЫЗОВ
    // с аргументами обработчика: объявление функции начинается теми же буквами и стоит выше.
    && content.indexOf('onMessage.addListener') < content.indexOf('fillFields(selectors ?? {}')],

  // ── Остановка ради человека ────────────────────────────────────────────────────────────────

  // Заполнить форму и только потом заметить капчу — значит оставить в кабинете полуготовую
  // карточку. Проверка идёт ДО единого символа в полях.
  ['the stop check runs before anything is typed',
    content.indexOf('findStopSign(stopSigns ?? [])') < content.indexOf('fillFields(selectors ?? {}')],

  // Между заполнением и кликом появляется подтверждение, которого никто не ждал.
  ['the stop check runs again right before the irreversible click',
    (content.match(/findStopSign\(stopSigns \?\? \[\]\)/g) ?? []).length >= 2
    && content.indexOf('lateStop') < content.indexOf('button.click()')],

  ['captcha frames are named as stop signs',
    selectors.includes('iframe[src*="captcha"]') && selectors.includes('[class*="captcha" i]')],

  // Остановка ради человека — отказ, а не поломка: карточка цела, решение за владельцем.
  ['a human handover is recorded as a refusal',
    background.includes("response.reason === 'human_needed' ? 'refused' : 'failed'")],

  // ── Угадывание полей ───────────────────────────────────────────────────────────────────────

  // Форма, заполненная неверно и отправленная на модерацию, — это товар с чужим описанием в
  // магазине и разбирательство в чужом интерфейсе. Пустая карта означает отказ, а не попытку.
  ['empty selectors refuse instead of guessing',
    selectors.includes("titleRu: ''")
    && selectors.includes('export function selectorsReady()')
    && background.includes('if (!selectorsReady()) {')
    && background.indexOf('selectorsReady()') < background.indexOf('const task = await nextTask()')],

  ['the missing fields are named, not merely counted',
    selectors.includes('export function missingSelectors()')
    && background.includes('missingSelectors().join')],

  // ── Журнал ─────────────────────────────────────────────────────────────────────────────────

  // Две таблицы дали бы две несходящиеся статистики «сколько карточек доехало».
  ['extension attempts land in the same log as api attempts',
    control.includes("action === 'report_extension_result'")
    && control.includes("transport: 'extension'")
    && !control.includes('extension_submissions')],

  // Попытка, о которой ничего не осталось, через неделю превращается в «оно почему-то не работает».
  ['every branch reports, including the ones that never reached uzum',
    (background.match(/await reportResult\(\{/g) ?? []).length >= 4],

  // ── Тумблер ────────────────────────────────────────────────────────────────────────────────

  // Способ вероятно нарушает правила продавца Uzum. Включить его человек должен сам.
  ['the extension switch is off by default and separate from the api one',
    migration.includes('add column if not exists auto_extension_submit boolean not null default false')
    && control.includes("body?.channel === 'extension' ? 'auto_extension_submit' : 'auto_submit_to_moderation'")],

  // ── Слова ──────────────────────────────────────────────────────────────────────────────────

  // Риск назван прямо, а не спрятан в примечание: магазин чужой, и цена решения — блокировка.
  ['the readme states the risk instead of implying it',
    readme.includes('блокировка магазина')
    && readme.includes('правилам продавца Uzum')],

  // Кнопка со словом «отправить» не должна выглядеть как кнопка «продолжить».
  ['the irreversible button says what it does',
    popup.includes('«Отправить на модерацию»') || read('extension/popup.html').includes('Заполнить и отправить на модерацию')],
]

let failed = 0
for (const [name, passed] of contracts) {
  if (!passed) { console.log(`FAIL ${name}`); failed++ }
}
console.log(`Extension contracts: ${contracts.length - failed}/${contracts.length}`)
if (failed) process.exit(1)
