// Границы браузерного агента, записанные проверками.
//
// Расширение работает в чужом кабинете вашей сессией и выполняет план, придуманный моделью. Всё,
// что здесь проверяется, — обещания, которые иначе остались бы словами в README: их легко нарушить
// одной строкой и не заметить.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

const manifest = JSON.parse(read('extension/manifest.json'))
const background = read('extension/background.js')
const scanner = read('extension/scanner.js')
const executor = read('extension/executor.js')
const content = read('extension/content.js')
const nemo = read('extension/nemo.js')
const popup = read('extension/popup.js')
const popupHtml = read('extension/popup.html')
const messages = read('extension/messages.js')
const control = read('supabase/functions/commerce-control/index.ts')
const plan = read('supabase/functions/_shared/agentPlan.ts')
const link = read('src/lib/extensionLink.ts')
const page = read('src/pages/app/CommercePage.tsx')
const cors = read('supabase/functions/_shared/cors.ts')

/** Код без комментариев. Проверять надо исполняемое, а не объяснение рядом с ним. */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const NEMO_ORIGIN = 'https://nemo.185.8.213.144.sslip.io'

// Только тело обработчика agent_plan, а не «всё после первого упоминания строки». Голая строка
// `action === 'agent_plan'` встречается ещё раз в общем списке разрешённых действий (строка ~246,
// задолго до самого обработчика) — split по ней брал промежуток МЕЖДУ этим упоминанием и настоящим
// `if`, а не сам обработчик. Проверки, полагавшиеся на это, могли зеленеть по случайному совпадению
// в чужом коде, а не потому что проверяли то, что заявляли.
const AGENT_PLAN_BODY = control.split("if (action === 'agent_plan') {")[1]
  .split("if (action === 'next_extension_task') {")[0]

const contracts = [
  // ── Область действия ───────────────────────────────────────────────────────────────────────

  // Расширение с доступом ко всем сайтам не должен ставить никто, включая владельца продукта.
  // «Универсальный» здесь про архитектуру, а не про разрешения: список доменов остаётся явным.
  // Пять подходов подряд ушли на выяснение ОДНОГО факта за раз. Отчёт собирается разом и
  // работает БЕЗ СВЯЗИ — именно тогда он и нужен. Кнопка, отключённая вместе с основной,
  // оставила бы человека без единственного способа рассказать, что у него не так.
  ['the problem report works even when nothing else does',
    background.includes('export async function collectDiagnostics()')
    && popup.includes("chrome.runtime.sendMessage({ type: 'nemo:diagnose' })")
    && !popup.includes('nodes.diagnose.disabled = !linked')],

  // Отчёт, который страшно переслать, диагностикой не работает: ни токена, ни значений полей.
  ['the report carries no secrets and no field values',
    !background.split('collectDiagnostics')[1].includes('accessToken')
    && !background.split('collectDiagnostics')[1].includes('one.value')],

  // 'всего=0' раньше означало число ПОСЛЕ фильтра видимости: по нему нельзя было отличить
  // «полей нет» от «мой фильтр съел все». Разница решающая, а подпись врала.
  ['the raw dom count is reported before any filter',
    scanner.includes('const raw = queryAllDeep(document, INTERACTIVE)')
    && scanner.includes('raw: raw.length')
    && scanner.includes('dropped')
    && content.includes('в DOM=')],

  // Живой отчёт показал «в DOM: 1» на кабинете Uzum, целиком собранном из веб-компонентов:
  // обычный querySelectorAll с document не заглядывает внутрь открытого shadowRoot, и почти вся
  // страница остаётся невидимой для сканера. Обход находит то, что обычный запрос теряет.
  ['the scanner walks into open shadow roots',
    scanner.includes('function queryAllDeep(root, selector)')
    && scanner.includes('if (node.shadowRoot) found.push(...queryAllDeep(node.shadowRoot, selector))')
    && scanner.includes('const raw = queryAllDeep(document, INTERACTIVE)')
    && scanner.includes('queryAllDeep(node, FIELD_LIKE)') // ownCard — тоже сквозь shadow root
    && scanner.includes('queryAllDeep(parent, FIELD_LIKE)')], // nearbyText

  // Число одно на двоих: «узлов мало вообще» — страница ещё не отрисовалась; «узлов много, root-ов
  // тоже» — форма спрятана в веб-компонентах. Без обоих чисел «в DOM: 1» можно было только гадать.
  ['the report distinguishes an unrendered page from a shadow-hidden one',
    scanner.includes('function countShadowHosts(root)')
    && scanner.includes('const domTotal = document.querySelectorAll')
    && scanner.includes('shadowHosts,')
    && background.includes('shadow-корней: ${page.shadowHosts')],

  // Скан, снятый раньше, чем SPA дорисовала форму, видит пустую обёртку — ровно то, что случилось
  // на живой странице. Ждать после КАЖДОГО скана нельзя, поэтому решение принимается по тому,
  // насколько пуст первый снимок, и пересканирование происходит не больше одного раза.
  ['an empty-looking scan waits once for the page to settle, not forever',
    scanner.includes('function looksUnrendered(page)')
    && content.includes('function settled(')
    && content.includes('if (looksUnrendered(page))')
    && content.includes('await settled()')
    && !content.includes('while (looksUnrendered(page))')],

  // Форма во фрейме и форма в главном документе выглядят в отчёте одинаково, а чинятся
  // по-разному: вторая требует all_frames.
  ['frames are scanned and named',
    manifest.content_scripts[0].all_frames === true
    && scanner.includes('frame: window.top === window.self')],

  ['the extension reaches exactly the two hosts it needs',
    Array.isArray(manifest.host_permissions)
    && manifest.host_permissions.length === 2
    && manifest.host_permissions.includes('https://seller.uzum.uz/*')
    && manifest.host_permissions.includes('https://ogfmyjiuqmgroobckdyw.supabase.co/*')
    && manifest.host_permissions.every((one) => !one.includes('*.'))],

  ['no wildcard host slips in through content scripts',
    manifest.content_scripts.every((script) =>
      script.matches.every((match) => match === 'https://seller.uzum.uz/*'))],

  ['nothing asks for all-urls, tabs history or cookies',
    !JSON.stringify(manifest).includes('<all_urls>')
    && !JSON.stringify(manifest).includes('*://*/*')
    && !manifest.permissions.includes('cookies')
    && !manifest.permissions.includes('webRequest')
    && !manifest.permissions.includes('history')],

  ['it is a manifest v3 extension',
    manifest.manifest_version === 3 && manifest.background?.service_worker === 'background.js'],

  // Модули подключаются в порядке зависимости: content.js зовёт функции из scanner и executor,
  // а content_scripts делят одну область видимости.
  ['the content scripts load in dependency order',
    manifest.content_scripts[0].js.join(',') === 'scanner.js,executor.js,content.js'],

  // ── Учётные данные ─────────────────────────────────────────────────────────────────────────

  ['the extension never handles a password',
    !/password/i.test(background) && !/password/i.test(popup) && !/password/i.test(nemo)
    && !manifest.permissions.includes('identity')],

  // Токен на диске переживает вкладку, вечер и следующего человека за этим компьютером.
  ['the session lives in session storage, not on disk',
    nemo.includes('chrome.storage.session.set')
    && !nemo.includes('chrome.storage.local')],

  ['the sender origin is checked in code, not only in the manifest',
    manifest.externally_connectable?.matches?.includes(`${NEMO_ORIGIN}/*`)
    && background.includes('ALLOWED_ORIGINS.includes(origin)')
    && background.indexOf('forbidden_origin') < background.indexOf('saveSession(message.session)')],

  // sslip.io — служба подстановочного DNS: <любой-ip>.sslip.io указывает на этот адрес, то есть
  // «все поддомены» означало бы «любая страница, которую кто угодно поднял у себя».
  ['no wildcard origin may talk to the extension',
    manifest.externally_connectable.matches.every((one) => !one.includes('*.'))],

  // Сайт показывал «Связано» из собственной памяти, пока расширение уже говорило «нет связи».
  // Два ответа на один вопрос — худшее, что может показать интерфейс.
  ['an expired link is named as expired, on both sides',
    nemo.includes('export async function sessionState()')
    && background.includes('sessionState().then(({ session, expired })')
    && link.includes("return probe.reply.expired ? 'expired' : 'unlinked'")
    && popup.includes("info?.expired ? 'expired' : 'not_linked'")
    && page.includes("window.addEventListener('focus', check)")],

  ['only the short-lived token crosses to the extension',
    link.includes('session: { access_token: session.access_token, expires_at: session.expires_at }')
    && !link.includes('refresh_token')],

  ['the extension id is pinned by a manifest key',
    typeof manifest.key === 'string' && manifest.key.length > 300],

  ['the built id matches the one derived from the key',
    (() => {
      const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)
      const derived = [...digest].flatMap((b) => [b >> 4, b & 15])
        .map((n) => String.fromCharCode(97 + n)).join('')
      return link.includes(`?? '${derived}'`) && read('.env.example').includes(derived)
    })()],

  ['the function lets exactly this extension call it',
    cors.includes('const EXTENSION_ORIGIN =')
    && !cors.includes('chrome-extension://*')
    && cors.includes("origin !== EXTENSION_ORIGIN && originAllowed(origin)")],

  // ── Сканер ─────────────────────────────────────────────────────────────────────────────────

  // Наружу уходят НОМЕРА, а не селекторы. Селектор, вернувшийся обратно, — это способ указать на
  // элемент, которого мы не показывали.
  ['the page is described by numbers, not by selectors',
    scanner.includes("const NEMO_ID = 'data-nemo-id'")
    && scanner.includes('function elementById(id)')
    && scanner.includes('queryAllDeep(document, `[${NEMO_ID}="${Number(id)}"]`)[0] ?? null')],

  // Старые номера снимаются перед новым сканом: иначе номер из прошлого снимка после перерисовки
  // укажет на другой элемент. Снимаются и внутри shadow root тем же обходом, которым ставились.
  ['stale numbers are cleared before a new scan',
    scanner.includes(`for (const stale of queryAllDeep(document, \`[\${NEMO_ID}]\`)) stale.removeAttribute(NEMO_ID)`)],

  // Ближайший div почти всегда общая обёртка: её текст содержит подписи соседних полей, и оба
  // получают одинаковый контекст. Тогда текст уезжает не в то поле.
  ['the context is the element own card, not the whole block',
    scanner.includes('function ownCard(element)')
    && scanner.includes('if (others.length) break')],

  // Редакторы описания стоят «блоком ниже» подписи: между надписью и полем лежат панель
  // инструментов и обёртки. Без подъёма вверх такое поле остаётся без смысла — ровно та причина,
  // по которой описания оставались пустыми, когда названия вставали.
  ['the label above a distant editor is still found',
    scanner.includes('function nearbyText(element)')
    && scanner.includes('function boundLabel(element)')
    && scanner.includes('aria-labelledby')],

  // Панель инструментов richtext-редактора — это КНОПКИ, а не другое поле. Считать их «другим
  // интерактивным элементом» останавливало подъём на первом же предке, и подпись, стоящая выше
  // всей панели, никогда не находилась — richtext оставался без подписи, без плейсхолдера и без
  // контекста разом, и модель осторожно пропускала поле целиком.
  ['toolbar buttons do not stop the climb to a field label',
    (() => {
      const body = scanner.split('const FIELD_LIKE = [')[1]?.split('].join')[0] ?? ''
      return body.length > 0
        && !body.includes("'button'") && !body.includes('role="button"') && !body.includes('a[href]')
        && scanner.includes('queryAllDeep(node, FIELD_LIKE)') // ownCard
        && scanner.includes('queryAllDeep(parent, FIELD_LIKE)') // nearbyText
        && !scanner.split('function ownCard')[1].split('function boundLabel')[0].includes('queryAllDeep(node, INTERACTIVE)')
    })()],

  // Разметка наружу не уезжает: ни html, ни классы, ни селекторы. Только то, что видит человек.
  ['no markup leaves the page',
    !/innerHTML/.test(stripComments(scanner))
    && !/outerHTML/.test(scanner)
    && !scanner.includes('className')],

  // Пометка рискованного действия ставится НА ЭЛЕМЕНТ, а не только в отчёт: исполнитель читает её
  // сам и не полагается на то, что скажет пришедший план.
  ['risky controls are marked on the element itself',
    scanner.includes("element.setAttribute('data-nemo-risky', 'true')")
    && executor.includes("element.getAttribute?.('data-nemo-risky') === 'true'")],

  // ── Исполнитель ────────────────────────────────────────────────────────────────────────────

  ['only three actions exist',
    plan.includes("export const ALLOWED_ACTIONS = ['type', 'click', 'select'] as const")
    && executor.includes("action.type === 'type'")
    && executor.includes("action.type === 'click'")
    && executor.includes("action.type === 'select'")
    && executor.includes("error: 'unknown_action'")],

  // innerHTML даёт худший исход: текст появляется на экране, модель редактора остаётся пустой, и
  // описание уходит на модерацию пустым. Именно так описания и остались пустыми в прошлой версии.
  ['the rich text editor is never filled through innerhtml',
    !stripComments(executor).includes('.innerHTML')
    && executor.includes("inputType: 'insertText'")
    && executor.includes("document.execCommand('insertText', false, wanted)")],

  // Способ, который «выполнился без ошибки», но ничего не изменил, — это молчаливый провал.
  ['the editor result is read back, not assumed',
    executor.includes('const reads = () =>')
    && executor.includes("reads().includes(wanted.slice(0, 20))")],

  // На blur формы запускают проверку поля: без него оно остаётся подсвеченным как незаполненное.
  ['the input events include blur',
    executor.includes("for (const type of ['input', 'change', 'blur'])")],

  // Пайплайн из десяти шагов, где седьмой молча не сработал, — это форма, заполненная наполовину,
  // и день на выяснение, какая половина уцелела.
  ['every step reports for itself and the plan does not stop early',
    executor.includes('function runPlan(actions, options)')
    && executor.includes('results.push(runAction(action, options))')
    && !/break\s*$/m.test(stripComments(executor))],

  // Кнопка «Удалить» или «Отправить», нажатая по плану модели, не отменяется никаким «назад».
  ['an irreversible click needs a human yes',
    executor.includes("error: 'needs_confirmation'")
    && executor.includes('confirmRisky = false')
    && popup.includes('confirmRisky: nodes.risky.checked')],

  // Разрешение, выданное однажды и запомненное, через неделю нажимает кнопку, о которой забыли.
  ['the consent is asked every run, never remembered',
    !popup.includes("storage.local.set({ risky")
    && popupHtml.includes('id="risky"')],

  // ── Что делает content script ──────────────────────────────────────────────────────────────

  // Расширение, которое начинает работать само, однажды заполнит форму, открытую посмотреть.
  ['the content script acts only when asked',
    content.includes('chrome.runtime.onMessage.addListener')
    && content.includes("message?.type === 'nemo:scan'")
    && content.includes("message?.type === 'nemo:run-plan'")],

  // Заполнить половину формы и только потом заметить капчу — значит оставить в чужом кабинете
  // полуготовую карточку.
  ['the stop check runs before the first action',
    content.indexOf('findStopSign()') < content.indexOf('runPlan(message.actions')
    && content.includes('[class*="captcha" i]')],

  // Content script подключается обычным скриптом: import и export здесь — синтаксическая ошибка,
  // из-за которой не выполнится НИ ОДНА строка файла, и расширение молча перестанет отвечать.
  ['the content scripts are not written as modules',
    ![scanner, executor, content].some((source) => /^export /m.test(source) || /^import /m.test(source))],

  // ── План от модели ─────────────────────────────────────────────────────────────────────────

  // Ни одному ответу модели не верим на слово: каждый номер сверяется со снимком, который сами же
  // и прислали. Элемента, которого мы не показывали, коснуться нельзя.
  ['every planned id is checked against the snapshot we sent',
    plan.includes('const known = new Map(items.map((item) => [Number(item.id), item]))')
    && plan.includes("rejected.push({ action: candidate, reason: 'unknown_id' })")
    && control.includes('checkPlan(parsed, items)')],

  // Данные для подстановки берутся НА СЕРВЕРЕ: иначе достаточно попросить «впиши сюда чужой
  // артикул», и расширение впишет что угодно, что уместилось в текст поручения.
  ['the data to type comes from the database, not from the instruction',
    control.includes("action === 'agent_plan'")
    && AGENT_PLAN_BODY.indexOf("from('commerce_listing_drafts')") < AGENT_PLAN_BODY.indexOf('planUserPrompt(')],

  // Замок подписки стоит и здесь: агент — это новое действие ИИ, а не чтение своих данных.
  ['the planner is behind the subscription lock and owner-only',
    control.includes("|| action === 'agent_plan'")
    && AGENT_PLAN_BODY.includes('entitlementFor(admin, profile.account_id)')],

  // Без третьего аргумента resolveOpenRouterKey отдаёт undefined всем, у кого нет СВОЕГО ключа
  // OpenRouter в настройках, — а план всегда работает на общем платформенном ключе, если владелец
  // не подключил свой. Так и получилось «llm_not_configured» на живом аккаунте, у которого ключ на
  // сервере был, просто не долетал: одному-единственному вызову из тридцати не хватало аргумента.
  ['the planner falls back to the platform key, not to undefined',
    AGENT_PLAN_BODY.includes("resolveOpenRouterKey(admin, profile.account_id, Deno.env.get('OPENROUTER_API_KEY')")],

  // Молчаливая фильтрация превращает разбор в гадание: план «не сработал», и никто не знает почему.
  ['what the guard threw away is named',
    plan.includes("rejected: PlanCheck['rejected']")
    && control.includes('rejected: checked.rejected')
    // Отброшенное доезжает до владельца, а не остаётся в консоли: «уточните поручение» человеку,
    // у которого план отвергла наша же проверка, — это совет чинить не то.
    && background.includes('rejected: planned.data?.rejected ?? []')
    && popup.includes('answer.rejected?.length')],

  // «Модель не заметила поле» и «предложила, но проверка отклонила» снаружи выглядели одинаково —
  // «поле осталось пустым». unaddressedFields называет первое отдельно, и оно доезжает до отчёта
  // диагностики, до консоли service worker и до самого владельца в попапе, а не гаснет внутри
  // одного из трёх слоёв.
  ['fields the plan never even tried are named, not just the rejected ones',
    plan.includes('export function unaddressedFields(items: PageItem[], checked: PlanCheck)')
    && control.includes('unaddressed: unaddressedFields(items, checked)')
    && background.includes('planned.data?.unaddressed ?? []')
    && popup.includes('answer.unaddressed?.length')],

  // Бренд, страна происхождения и прочие характеристики, которые владелец сам назвал, живут в
  // commerce_listing_drafts.attributes — next_extension_task их уже отдавал, а agent_plan эту
  // колонку не запрашивал вовсе. Планировщик не мог сопоставить select с данными, которых ему не
  // показали, — это выглядело как отказ модели гадать, а было недостающим полем в SELECT.
  ['attributes reach the planner, not just the legacy task feed',
    AGENT_PLAN_BODY.includes(
      ".select('id, title_ru, title_uz, description_ru, description_uz, uzum_category, attributes, min_selling_price_tiyin')",
    ) && AGENT_PLAN_BODY.includes('attributes: draft.attributes')],

  // ── Прозрачность ───────────────────────────────────────────────────────────────────────────

  // Пустой снимок и снимок без полей формы снаружи выглядят одинаково. Разбивка по видам — то, по
  // чему сразу видно, дошли ли поля до дерева вообще.
  ['the snapshot reports what it collected, by kind',
    scanner.includes('const byKind = {}')
    && scanner.includes('truncated: found.length > limit')
    // Печатается СТРОКОЙ, а не объектом: консоль сворачивает объект в «Object», и человек,
    // копирующий лог в переписку, присылает это слово вместо данных. Так и случилось.
    && content.includes('[Nemo] снимок: в DOM=')
    && background.includes('[Nemo] план: поручение=')
    && !content.includes("console.log('[Nemo] снимок страницы:', {")],

  // В значениях полей лежит содержимое чужого кабинета, а консоль читают через плечо и копируют
  // в переписку. В журнал идут номера, виды и подписи — не то, что там написано.
  ['the log never prints what is written in the fields',
    !/console.log[sS]{0,400}item.value/.test(content)],

  // Служебная кнопка 1×1 за экраном получала первый номер в снимке и участвовала в разборе
  // наравне с настоящими полями. Проверка «ширина и высота больше нуля» такое пропускает.
  ['hidden and off-screen elements never enter the snapshot',
    scanner.includes('const MIN_SIZE = 8')
    && scanner.includes("if (box.width < MIN_SIZE || box.height < MIN_SIZE) return 'tiny'")
    && scanner.includes("if (box.right <= 0 || box.bottom <= 0) return 'offscreen'")
    && scanner.includes("element.getAttribute?.('aria-hidden') === 'true'")],

  // Проверка «попадает ли элемент в текущий экран» напрашивается и ломает всё: на длинной форме
  // почти все поля лежат ниже сгиба, и снимок потерял бы то, ради чего затевался. Прокрутка — не
  // способ спрятать элемент.
  ['fields below the fold stay in the snapshot',
    !stripComments(scanner).includes('window.innerHeight')],

  // У элементов с position: fixed offsetParent равен null всегда: плавающая панель формы видима,
  // и отбрасывать её нельзя.
  ['a fixed element is not mistaken for a hidden one',
    scanner.includes("element.offsetParent === null && style?.position !== 'fixed'")],

  // Поля формы лежат ниже навигации, а ссылок в кабинете десятки. При отборе «первые N в порядке
  // документа» меню съедало весь снимок, и модель получала страницу без единого поля ввода.
  ['form fields outrank navigation links in the snapshot',
    scanner.includes('const RANK =')
    && scanner.includes('.sort((a, b) => (a.rank - b.rank) || (a.index - b.index))')],

  // ── Слова ──────────────────────────────────────────────────────────────────────────────────

  // Ни одной фразы прямо в коде окна: любой видимый текст приходит из messages.js на языке
  // владельца. Проверяется отсутствие кириллицы в исполняемой части — русская строка, набранная
  // здесь, по-узбекски не покажется никогда, и заметят это только на чужом экране.
  ['every visible word comes from the phrasebook, not from the code',
    !/[а-яё]/i.test(stripComments(popup))
    && popup.includes("say('")
    && messages.includes('LANGS = [')
    && messages.includes('uz:')],
]

let failed = 0
for (const [name, passed] of contracts) {
  if (!passed) { console.log(`FAIL ${name}`); failed++ }
}
console.log(`Extension contracts: ${contracts.length - failed}/${contracts.length}`)
if (failed) process.exit(1)
