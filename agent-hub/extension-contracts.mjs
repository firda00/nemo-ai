// Границы расширения, записанные проверками.
//
// Расширение работает в чужом кабинете вашей сессией. Всё, что здесь проверяется, — это обещания
// из README, которые иначе остались бы обещаниями: их легко нарушить одной строкой и не заметить.

import { createHash } from 'node:crypto'
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
const messages = read('extension/messages.js')
const control = read('supabase/functions/commerce-control/index.ts')
const migration = read('supabase/migrations/20260813160000_extension_submit.sql')
const link = read('src/lib/extensionLink.ts')
const page = read('src/pages/app/CommercePage.tsx')
const cors = read('supabase/functions/_shared/cors.ts')

/** Код без комментариев. Проверять надо исполняемое, а не объяснение рядом с ним. */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const NEMO_ORIGIN = 'https://nemo.185.8.213.144.sslip.io'

const contracts = [
  // ── Область действия ───────────────────────────────────────────────────────────────────────

  // Расширение с доступом ко всем сайтам не должен ставить никто, включая владельца продукта.
  // Два хоста и ровно два: кабинет, который заполняем, и функции Nemo, откуда берём задания.
  // Домена бэкенда сначала не было, и запрос падал ещё на предзапросе — наружу это выглядело как
  // «сеть недоступна» при полностью исправной сети.
  ['the extension reaches exactly the two hosts it needs',
    Array.isArray(manifest.host_permissions)
    && manifest.host_permissions.length === 2
    && manifest.host_permissions.includes('https://seller.uzum.uz/*')
    && manifest.host_permissions.includes('https://ogfmyjiuqmgroobckdyw.supabase.co/*')
    && manifest.host_permissions.every((one) => !one.includes('*.'))],

  // Адрес заданий — домен функций, а НЕ адрес сайта: на стенде лежит только статика, и запрос
  // туда вернул бы 404 на каждое задание.
  ['the task endpoint points at the functions host, not at the static site',
    nemo.includes("const FUNCTIONS_URL = 'https://ogfmyjiuqmgroobckdyw.supabase.co/functions/v1/commerce-control'")
    && !/FUNCTIONS_URL = '[^']*sslip.io/.test(nemo)],

  // Шлюз Supabase ждёт публичный ключ отдельным заголовком рядом с токеном пользователя.
  ['the gateway gets its public key alongside the user token',
    nemo.includes('apikey: ANON_KEY')],

  // Одного host_permissions мало: он снимает проверку на стороне браузера, а не на нашей.
  // Точечное разрешение по одному идентификатору, закреплённому ключом манифеста.
  ['the function lets exactly this extension call it',
    cors.includes('const EXTENSION_ORIGIN =')
    && cors.includes('PROD_ORIGIN, EXTENSION_ORIGIN]')
    && !cors.includes('chrome-extension://*')
    // Разрешено звонить, но не быть адресом возврата после оплаты.
    && cors.includes("origin !== EXTENSION_ORIGIN && originAllowed(origin)")],

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
    manifest.externally_connectable?.matches?.includes(`${NEMO_ORIGIN}/*`)
    && background.includes(`'${NEMO_ORIGIN}'`)
    && background.includes('ALLOWED_ORIGINS.includes(origin)')
    && background.indexOf('forbidden_origin') < background.indexOf('saveSession(message.session)')],

  // sslip.io — служба подстановочного DNS: <любой-ip>.sslip.io указывает на этот адрес. Значит
  // «все поддомены sslip.io» это «любая страница, которую кто угодно поднял у себя», и давать ей
  // возможность достучаться до расширения с ключом доступа незачем.
  ['no wildcard origin may talk to the extension',
    manifest.externally_connectable.matches.every((one) => !one.includes('*.'))
    && background.split('ALLOWED_ORIGINS')[1].split(']')[0].split('nemo.185.8.213.144.sslip.io').length === 3],

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

  // Без `key` идентификатор выводится из пути к папке, и связь рвётся при первом же переносе.
  // Мы это прошли дважды: сначала ID оказался чужим, потом сменился после перезагрузки папки.
  // Открытый ключ в манифесте закрепляет его навсегда; закрытый в репозиторий не попадает.
  ['the extension id is pinned by a manifest key',
    typeof manifest.key === 'string'
    && manifest.key.length > 300
    && !read('.gitignore').split(/\r?\n/).every((line) => line.trim() !== '*.local')],

  // Идентификатор в сборке обязан совпадать с тем, что даёт ключ: расхождение здесь — это ровно
  // тот отказ, который мы ловили руками два раза подряд.
  ['the built id matches the one derived from the key',
    (() => {
      const spki = Buffer.from(manifest.key, 'base64')
      const digest = createHash('sha256').update(spki).digest().subarray(0, 16)
      const derived = [...digest].flatMap((b) => [b >> 4, b & 15])
        .map((n) => String.fromCharCode(97 + n)).join('')
      return link.includes(`?? '${derived}'`) && read('.env.example').includes(derived)
    })()],

  // Флаг в базе показывал бы «связано» и после того, как расширение снесли.
  ['the site asks the extension itself, not the database',
    page.includes('void extensionState().then(')
    && !page.includes('pilot?.extension_linked')],

  // Chrome не бросает исключение на неизвестный идентификатор — он выставляет lastError и зовёт
  // колбэк. Не прочитать его значит получить «Unchecked runtime.lastError» на каждой загрузке.
  ['a missing extension is handled, not thrown',
    link.includes('chromeRuntime.lastError')
    && link.includes("finish({ ok: false, failure: 'silent' })")],

  // Три причины молчания требуют трёх РАЗНЫХ действий: перезагрузить вкладку, поправить
  // идентификатор, разбудить расширение. Одно «не найдено» отправляет проверять наугад.
  ['a silent extension says which of the three things went wrong',
    link.includes("'no_bridge'") && link.includes("'no_answer'") && link.includes("'silent'")
    && page.includes('t(`commerce.submit.ext_${extension}`)')
    && page.includes('recheckExtension()')],

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
    && content.indexOf('onMessage.addListener') < content.indexOf('fillFields(fields ?? []')],

  // ── Остановка ради человека ────────────────────────────────────────────────────────────────

  // Заполнить форму и только потом заметить капчу — значит оставить в кабинете полуготовую
  // карточку. Проверка идёт ДО единого символа в полях.
  ['the stop check runs before anything is typed',
    content.indexOf('findStopSign(stopSigns ?? [])') < content.indexOf('fillFields(fields ?? []')],

  // Порядок в Uzum: пока категория не подтверждена кнопкой «Принять», полей названий и описания
  // на странице нет или они заблокированы. Это не поломка формы, а очередь действий, и сказать об
  // этом надо одной фразой, а не отправлять владельца искать сломанное поле.
  ['an unconfirmed category is explained, not reported as a broken form',
    content.includes('function fieldReady(control)')
    && content.includes("reason: categoryField ? 'category_first' : 'form_changed'")
    && content.includes('function categoryConfirmed()')
    && messages.includes('category_first')],

  // После «Принять» поле поиска категории исчезает, а названия открываются с ОДНИМ И ТЕМ ЖЕ
  // плейсхолдером на оба языка. Различает их соседнее слово; подъём прекращается на общем предке,
  // иначе контейнер с обоими полями подходит любому, и русский текст уезжает в узбекское поле.
  ['twin placeholders are told apart by the language beside them',
    content.includes('function findByPlaceholderNear(placeholders, near)')
    && content.includes('if (candidatesInside > 1) break')
    && selectors.includes("near: 'на русском'")
    && selectors.includes("near: 'на узбекском'")],

  ['captcha frames are named as stop signs',
    selectors.includes('iframe[src*="captcha"]') && selectors.includes('[class*="captcha" i]')],

  // Остановка ради человека — отказ, а не поломка: карточка цела, решение за владельцем. То же и
  // с неподтверждённой категорией: владелец просто ещё не нажал «Принять».
  ['a human handover is recorded as a refusal',
    background.includes("response.reason === 'human_needed' || response.reason === 'category_first' ? 'refused' : 'failed'")],

  // ── Разметка формы ─────────────────────────────────────────────────────────────────────────

  // Пустая карта означает отказ, а не попытку заполнить наугад.
  ['an empty field map refuses instead of guessing',
    selectors.includes('export function selectorsReady()')
    && background.includes('if (!selectorsReady()) {')
    && background.indexOf('selectorsReady()') < background.indexOf('const task = await nextTask()')],

  ['the missing fields are named, not merely counted',
    selectors.includes('export function missingSelectors()')
    && background.includes('missingSelectors().join')],

  // Классы вида `.css-1x2y3z` Uzum меняет при каждом релизе, и селектор на класс ломается молча,
  // в тот день, когда никто не смотрит. Подпись держится за смысл поля.
  ['fields are found by their labels, not by generated classes',
    selectors.includes("labels: ['Название товара на русском']")
    && content.includes('function findByLabel(labels)')
    // Комментарии вычищены: объяснение про `.css-1x2y3z` названо в тексте по имени, и поиск по
    // нему ловил бы собственное обоснование вместо нарушения.
    && !/\.css-[a-z0-9]/i.test(stripComments(selectors))],

  // Редактор форматированного текста — не <input>: у него нет value, и присваивание туда не делает
  // ничего. Перепутать значит получить пустое описание при заполненном на вид поле.
  // В вёрстке «подпись, поле, подпись, поле» обе подписи лежат в одной обёртке, и первый ввод
  // контейнера принадлежит СОСЕДНЕЙ подписи. Так русское название уезжало в узбекское поле —
  // карточка с перепутанными языками, а причину искали бы в переводчике.
  ['the control is the one after its label, not the first in the box',
    content.includes('function follows(labelNode, candidate)')
    && content.includes('candidates.find((candidate) => follows(labelNode, candidate))')],

  // Плейсхолдер живёт атрибутом ВНУТРИ поля, а не текстом на странице: обход узлов его не
  // встретит никогда. У категории подписи нет вовсе, и по подписям она не находилась молча.
  ['a placeholder is searched as a placeholder, not as a label',
    content.includes('function findByPlaceholder(placeholders)')
    && content.includes("getAttribute?.('placeholder')")
    && selectors.includes("placeholders: ['Название категории или товара']")
    && content.includes('findField(category)')],

  // Молча пропущенное описание — та ошибка, которую ищут сутки, глядя на карточку без текста.
  ['an expected field that was not found is named, not silently skipped',
    content.includes("else if (field.expected) skipped.push(field.key)")
    && background.includes('response.skipped?.length')
    && popup.includes('answer.skipped?.length')],

  // Краткие описания в форме есть, но своего короткого текста у черновика нет. Обрезать полное
  // под 390 знаков значит оборвать мысль и отдать это покупателю как аннотацию.
  ['the short description fields are named as deliberately not filled',
    selectors.includes('export const NOT_FILLED')
    && selectors.includes('shortDescriptionRu')],

  ['the rich text editor is filled as a rich text editor',
    content.includes('function setRichValue(element, value)')
    && content.includes("document.execCommand('insertText', false, value)")
    && content.includes('field.rich || control.isContentEditable')],

  // Название на 95 знаков при пределе 90 — это не «почти влезло»: обрезанное посреди слова
  // название снимают с модерации, и владелец узнаёт об этом через сутки.
  ['a text over the uzum limit is refused, never truncated',
    selectors.includes('title: 90')
    && content.includes('tooLong.push(')
    && content.includes("reason: 'too_long'")
    && !/\.slice\(0,\s*field\.limit\)/.test(content)],

  // ── Мастер в три шага ──────────────────────────────────────────────────────────────────────

  // На шаге 1 кнопки «Отправить на модерацию» не существует — там «Сохранить и продолжить», и за
  // ней ещё два шага, которых мы не видели.
  ['the extension clicks nothing at all',
    !/.click()/.test(content)
    && !content.includes('findButton')
    && !selectors.includes('STEP_BUTTON')
    && !content.includes('Отправить на модерацию')],

  // Шаг 1 из трёх — половина дела: товар ещё не в каталоге. Записать 'sent' здесь значило бы
  // объявить карточку отправленной и потерять её из виду.
  ['finishing step one is never recorded as sent',
    background.includes("status: 'refused'")
    && !/status:\s*'sent'/.test(background)],

  // Полка задаёт комиссию, характеристики и судьбу карточки на модерации. Список предложений мы
  // не видели ни разу, поэтому выбор остаётся человеку.
  ['the category is typed but never confirmed for the owner',
    selectors.includes("confirmButton: 'Принять'")
    && content.includes('categoryTyped = true')
    && !content.includes('category.confirmButton')],

  // Адрес сузился до настоящего: широкий шаблон означал бы попытку заполнить страницу
  // редактирования уже существующего товара.
  ['the create page pattern matches the real url',
    /products\\\/new/.test(String(selectors.match(/export const CREATE_PAGE = .*/)?.[0] ?? ''))
    && !selectors.includes('create)')],

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
  // Вторая кнопка означала бы выбор, которого у владельца нет: переход по шагам он делает сам.
  ['the popup offers exactly one button',
    (read('extension/popup.html').match(/<button[^>]*id="/g) ?? []).length === 1
    && !read('extension/popup.html').includes('перейти к шагу')],

  // Ни одной системной фразы на экране у продавца: он читает свой следующий шаг, а не нашу
  // внутреннюю причину.
  ['the owner never reads our internal wording',
    // Комментарии вычищены: слово «кнопка» стоит в объяснении наверху файла, и поиск по нему
    // ловил бы собственное описание вместо строки на экране.
    !/поля не найдены|кнопка «/.test(stripComments(popup))
    && messages.includes('LANGS = [')
    && messages.includes("ru:") && messages.includes("uz:")],

  // Ключи полей в сообщении владельцу — это тот же технический мусор, что и селекторы.
  ['field keys are spoken as words',
    messages.includes('const FIELD_NAMES')
    && messages.includes('export function fieldList')
    && popup.includes('fieldList(answer.skipped, lang)')],
]

let failed = 0
for (const [name, passed] of contracts) {
  if (!passed) { console.log(`FAIL ${name}`); failed++ }
}
console.log(`Extension contracts: ${contracts.length - failed}/${contracts.length}`)
if (failed) process.exit(1)
