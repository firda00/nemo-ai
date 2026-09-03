import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// \u041E\u043A\u043E\u043D\u0447\u0430\u043D\u0438\u044F \u0441\u0442\u0440\u043E\u043A \u043D\u043E\u0440\u043C\u0430\u043B\u0438\u0437\u0443\u044E\u0442\u0441\u044F \u041F\u0420\u0418 \u0427\u0422\u0415\u041D\u0418\u0418.
//
// \u0420\u0430\u0431\u043E\u0447\u0435\u0435 \u0434\u0435\u0440\u0435\u0432\u043E \u0437\u0434\u0435\u0441\u044C CRLF, \u0430 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u0441\u0440\u0430\u0432\u043D\u0438\u0432\u0430\u044E\u0442 \u0438\u0441\u0445\u043E\u0434\u043D\u044B\u0439 \u0442\u0435\u043A\u0441\u0442. \u0411\u0435\u0437 \u043D\u043E\u0440\u043C\u0430\u043B\u0438\u0437\u0430\u0446\u0438\u0438 \u043A\u0430\u0436\u0434\u043E\u0435
// \u0441\u0440\u0430\u0432\u043D\u0435\u043D\u0438\u0435 \u0441 \u043F\u0435\u0440\u0435\u0432\u043E\u0434\u043E\u043C \u0441\u0442\u0440\u043E\u043A\u0438 \u043D\u0430\u0434\u043E \u043F\u0438\u0441\u0430\u0442\u044C \u043A\u0430\u043A \r?\n, \u0438 \u0437\u0430\u0431\u044B\u0442\u043E\u0435 \u043C\u0435\u0441\u0442\u043E \u043F\u0430\u0434\u0430\u0435\u0442 \u041D\u0410 \u0418\u0421\u041F\u0420\u0410\u0412\u041D\u041E\u041C \u041A\u041E\u0414\u0415 \u2014
// \u043E\u0431\u044B\u0447\u043D\u043E \u0441\u0440\u0430\u0437\u0443 \u043F\u043E\u0441\u043B\u0435 git checkout, \u043A\u043E\u0433\u0434\u0430 \u043F\u0440\u0438\u0447\u0438\u043D\u0443 \u0438\u0449\u0443\u0442 \u0432 \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0435\u0439 \u043F\u0440\u0430\u0432\u043A\u0435, \u0430 \u043E\u043D\u0430 \u043D\u0435 \u0442\u0430\u043C.
// \u0414\u0435\u0448\u0435\u0432\u043B\u0435 \u043F\u0440\u0438\u0432\u0435\u0441\u0442\u0438 \u0442\u0435\u043A\u0441\u0442 \u043A \u043E\u0434\u043D\u043E\u043C\u0443 \u0432\u0438\u0434\u0443 \u043E\u0434\u0438\u043D \u0440\u0430\u0437 \u043D\u0430 \u0432\u0445\u043E\u0434\u0435.
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
let failed = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`[OK] ${name}`)
  else { failed += 1; console.error(`[FAIL] ${name}${detail ? `: ${detail}` : ''}`) }
}

const data = read('src/data/integrations.ts')
const page = read('src/pages/app/IntegrationsPage.tsx')
const store = read('src/store/useIntegrationStore.ts')
const toolsPage = read('src/pages/app/IntegrationsToolsPage.tsx')
const provider = read('supabase/functions/connect-provider/index.ts')
const backendStatus = read('supabase/functions/backend-status/index.ts')
const modelPicker = read('src/components/platform/ModelPicker.tsx')
const providersPage = read('src/pages/app/ProvidersPage.tsx')
const appLayout = read('src/components/layout/AppLayout.tsx')
const appRoutes = read('src/App.tsx')
const googleOauth = read('supabase/functions/google-oauth/index.ts')
const googleSetup = read('src/components/platform/GoogleSetup.tsx')

check('integration store has no demo-connected seed', !/:\s*'connected'/.test(store.match(/const seed[\s\S]*?\n\}/)?.[0] ?? 'connected'))
/*
 * СНИППЕТ ВИДЖЕТА — ОДИН, И АДРЕС В НЁМ НЕ ВЫДУМАН.
 *
 * Проверка требовала `data-channel` прямо в файле каталога. Сниппет с тех пор переехал в общий
 * модуль src/lib/widget.ts — по причине, которую эта же проверка и должна ловить: строка собиралась
 * в ТРЁХ местах, и хосты в них разошлись. Каталог и список каналов отдавали клиенту
 * старый тестовый IP-домен, онбординг — другой CDN-хост. Работать мог максимум один, а отказ
 * наступал на чужом сайте, то есть там, где мы его не увидим.
 *
 * Теперь проверяется не место строки, а её свойства: источник один, ключ — канал, хост берётся из
 * окружения сборки, и ни один файл интерфейса не вписывает адрес руками.
 */
const widgetLib = read('src/lib/widget.ts')
check('widget snippet is keyed by channel', /data-channel/.test(widgetLib))
check('widget host comes from the build environment', /import\.meta\.env\.VITE_API_GATEWAY_URL/.test(widgetLib))
check('main catalog has no fake widget snippet', !/cdn\.nemo\.ai|ag_demo/.test(page))
{
  // Хост, вписанный руками, — это разъезд адресов через одну правку. Ищем по всему интерфейсу.
  const hardcoded = []
  for (const [name, source] of [
    ['IntegrationsPage', page],
    ['ChannelsManager', read('src/components/platform/ChannelsManager.tsx')],
    ['OnboardingPage', read('src/pages/OnboardingPage.tsx')],
  ]) {
    if (/https:\/\/[^"'`\s]*\/widget\.js/.test(source)) hardcoded.push(name)
  }
  check('no UI file hardcodes the widget host', hardcoded.length === 0, hardcoded.join(', '))
}
check('main catalog has no timer-simulated OAuth', !/setTimeout\(\(\) => finishConnect/.test(page))
check('main catalog hydrates provider, Google and channel state from backend', /connect-provider/.test(page) && /google-oauth/.test(page) && /from\('channels'\)/.test(page))
check('disconnect mutates the real backend', /action: 'disconnect'/.test(page) && /from\('channels'\)\.delete/.test(page))
check('widget is connected to a selected real agent', /def\.id === 'widget'/.test(page) && /channel_id/.test(page) && /needsAgent[\s\S]*widget/.test(page))
check('Meta channels are not advertised live without production signature secret', /id: 'whatsapp'[^\n]+status: 'soon'/.test(data) && /id: 'instagram'[^\n]+status: 'soon'/.test(data))
check('GitHub stays unavailable until a configured production smoke exists',
  /id: 'github'[^\n]+status: 'soon'/.test(data) &&
  /id: 'github'[^\n]+implemented: false/.test(toolsPage) &&
  /GitHub[\s\S]{0,300}end-to-end smoke-test/.test(read('src/i18n/extra.ts')))

const setupOnly = ['vapi', 'did', 'synthesia', 'stability', 'kaspi']
for (const id of setupOnly) check(`${id} is visibly unavailable until it has an executor`, new RegExp(`id: '${id}'[^\n]+implemented: false`).test(toolsPage))
check('setup-only providers cannot be connected', /implemented === false\) return/.test(toolsPage))
check('provider dictionary rejects prototype-property ids', /Object\.prototype\.hasOwnProperty\.call\(PROVIDERS, id\)/.test(provider))
check('provider keys are reported as secure write-only storage', /providerKeysSecure: true/.test(backendStatus))
check('saved provider key is labelled as saved, not provider-verified', /ключ сохранён/.test(read('src/i18n/extra.ts')) && /run the real test below/.test(read('src/i18n/extra.ts')))
check('model picker uses authenticated server-side OpenRouter storage', /functions\.invoke\('connect-model'/.test(modelPicker) && /action: 'connect'/.test(modelPicker) && /action: 'disconnect'/.test(modelPicker) && !/localStorage/.test(modelPicker))
check('provider administration is admin-gated and has no demo key storage', /profileResolved/.test(providersPage) && /!isAdmin/.test(providersPage) && /Navigate to="\/app\/integrations"/.test(providersPage) && !/localStorage/.test(providersPage))
check('standalone Results navigation is removed with a safe legacy redirect', !/to: '\/app\/results'/.test(appLayout) && /path="results" element=\{<Navigate to="\/app" replace \/>\}/.test(appRoutes))
check('Google uses one single-use OAuth consent flow for Gmail, Sheets, Calendar, Docs and Drive',
  /google_oauth_transactions/.test(googleOauth) && /consume_google_oauth_transaction/.test(googleOauth) &&
  ['gmail.send', 'spreadsheets', 'calendar.events', 'documents', 'drive.file'].every((scope) => googleOauth.includes(scope)))
check('shared Nemo Google app hides per-customer credential setup and goes straight to authorization',
  googleSetup.includes('{!configured && (') && googleSetup.includes('(accountConfigured || configured)'))

const implementedConsumers = {
  github: "github_create_issue",
  stripe: "stripe_create_customer",
  hubspot: "hubspot_create_contact",
  amocrm: "amocrm_create_lead",
  bitrix24: "bitrix24_create_lead",
  notion: "notion_create_page",
  slack: "slack_send_message",
  hyperbrowser: "browser_task",
  elevenlabs: "provider === 'elevenlabs'",
  heygen: "eq('provider', 'heygen')",
  replicate: "provider: 'replicate'",
  wildberries: "wb_products",
  ozon: "ozon_products",
  airtable: "airtable_create_record",
  bland: "eq('provider', 'bland')",
}
const runtimeText = [
  read('supabase/functions/_shared/tools.ts'),
  read('supabase/functions/generate-voice/index.ts'),
  read('supabase/functions/generate-avatar/index.ts'),
  read('supabase/functions/generate-video/index.ts'),
  read('supabase/functions/make-call/index.ts'),
].join('\n')
check('Uzum has a real read-only executor and credential smoke before it can connect',
  /id: 'uzum'[^\n]+implemented: false/.test(toolsPage) === false &&
  /provider === 'uzum'[\s\S]{0,300}uzumShops\(key\)/.test(provider) &&
  /uzum_shops/.test(runtimeText) && /uzumProducts/.test(runtimeText))
for (const [id, needle] of Object.entries(implementedConsumers)) check(`${id} has a real runtime consumer`, runtimeText.includes(needle))

// ─── Public claims must match the code that backs them ───────────────────────
// A prospect checks the landing page against the product in about ten minutes. Every
// number promised outside the app is derived here from the file that implements it.
const landing = read('src/pages/LandingPage.tsx')
const plans = read('src/lib/plans.ts')
const models = read('src/lib/models.ts')
const extra = read('src/i18n/extra.ts')

const catalogEntries = [...data.matchAll(/\{\s*id:\s*'([^']+)'[^}]*?status:\s*'(live|beta|soon)'/g)]
const liveIds = catalogEntries.filter(([, , status]) => status === 'live').map(([, id]) => id)
// `live` is a claim about production, `beta` a claim about the code. Both must connect.
const connectableIds = catalogEntries.filter(([, , status]) => status !== 'soon').map(([, id]) => id)

const blockAfter = (text, marker, closer) => {
  const start = text.indexOf(marker)
  if (start < 0) return ''
  const end = text.indexOf(closer, start)
  return end < 0 ? '' : text.slice(start, end)
}
// Разделитель — СТРОКА, а не регулярка: blockAfter ищет через indexOf, и регулярка превратилась бы
// в текст «/\r?\n\}/», который не находится никогда. Тогда блок пуст, ключей ноль, и все интеграции
// объявляются недостижимыми. Строка здесь верна, потому что read выше приводит файл к \n.
const providerKeys = [...blockAfter(page, 'const PROVIDER_UI_TO_KEY', '\n}').matchAll(/^\s+(\w+):/gm)].map((m) => m[1])
const connectableKeys = [...blockAfter(page, 'const CONNECTABLE', '\n  }').matchAll(/^\s+(\w+): \{/gm)].map((m) => m[1])
const googleIds = [...(page.match(/GOOGLE_IDS = \[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
const reachable = new Set([...providerKeys, ...connectableKeys, ...googleIds])
const orphanLive = connectableIds.filter((id) => !reachable.has(id))
check('every live or beta integration has a working connect path', orphanLive.length === 0, `unreachable: ${orphanLive.join(', ')}`)
// `live` claims a verified production run, which no static check can prove — so the set is
// pinned here. Promoting an integration must be a deliberate edit to this list, with a real
// production verification behind it, not a status flipped because the executor exists.
const VERIFIED_LIVE = ['telegram', 'widget', 'gmail', 'gsheets', 'gdocs', 'slack', 'browser', 'amocrm', 'bitrix24', 'hubspot', 'uzum', 'google']
const unpinned = liveIds.filter((id) => !VERIFIED_LIVE.includes(id))
const missing = VERIFIED_LIVE.filter((id) => !liveIds.includes(id))
check('nothing is marked live without a deliberate, production-verified promotion',
  unpinned.length === 0 && missing.length === 0,
  `unpinned: ${unpinned.join(', ') || 'none'}; demoted: ${missing.join(', ') || 'none'}`)
check('Stripe secret keys are not solicited before an owned domain and encrypted storage',
  /id: 'stripe'[^\n]+implemented: false/.test(toolsPage) && /id: 'stripe'[^\n]+status: 'soon'/.test(data))

const statOf = (labels) => [...landing.matchAll(new RegExp(`\\["(\\d+)", "[^"]*(?:${labels})"\\]`, 'g'))].map((m) => Number(m[1]))
const liveStats = statOf('интеграций работают|integratsiya ishlaydi|integrations live')
check('landing states the real live-integration count in all three languages',
  liveStats.length === 3 && liveStats.every((n) => n === liveIds.length),
  `landing says ${liveStats.join('/')}, catalog has ${liveIds.length}`)
const catalogStats = statOf('сервисов в каталоге|katalogdagi xizmat|services catalogued')
check('landing states the real catalog size in all three languages',
  catalogStats.length === 3 && catalogStats.every((n) => n === catalogEntries.length),
  `landing says ${catalogStats.join('/')}, catalog has ${catalogEntries.length}`)

check('landing never lists an unavailable Meta channel among working ones',
  !/Telegram, WhatsApp/.test(landing) && !/WhatsApp, Instagram, (веб-виджет|saytdagi|website|web widget)/.test(landing))
check('landing does not sell credits the billing system does not implement',
  !/кредит|kredit|credits/i.test(landing))

// Витрина считает в ДИАЛОГАХ, а не в токенах: токены остались внутренним потолком
// злоупотребления и клиенту не показываются нигде, включая лендинг. Поэтому сверяем обещание
// лендинга с полем dialogues, а не tokens — иначе контракт защищал бы число, которого
// покупатель не видит, и пропускал бы расхождение в том, которое видит.
const freeDialogues = Number((plans.match(/free:\s*\{[^}]*dialogues:\s*([\d_]+)/)?.[1] ?? '0').replace(/_/g, ''))
// `[{,]\s*` требует, чтобы `price` был СВОИМ свойством объекта, а не хвостом чужого имени.
// Рядом теперь лежит priceUzs со ЧЕТЫРЁХЗНАЧНО большими числами (690 000 против 59): он не
// совпадает лишь потому, что после `price` у него идёт `U`, а не `:`. Любое будущее поле вида
// `listprice:` совпало бы — и dearestPaid стал бы суммой в сумах, а лендинг с честной ценой
// упал бы как «расходящийся с прайсом». Граница слева стоит дешевле такого разбора.
const paidPrices = [...plans.matchAll(/[{,]\s*price:\s*(\d+)/g)].map((m) => Number(m[1])).filter((n) => n > 0)
const cheapestPaid = Math.min(...paidPrices)
const dearestPaid = Math.max(...paidPrices)
check('landing quotes the real free-plan grant',
  freeDialogues > 0 &&
  landing.includes(freeDialogues.toLocaleString('ru-RU').replace(/ /g, ' ')) &&
  landing.includes(freeDialogues.toLocaleString('en-US')) &&
  // Число само по себе слишком слабое условие: голое includes('50') прошло бы на любой
  // странице, где встретится любое число, оканчивающееся на 50. Требуем, чтобы оно стояло
  // рядом со словом «диалог» в каждой из трёх локалей.
  [`${freeDialogues} диалог`, `${freeDialogues} dialog`, `${freeDialogues} dialogue`]
    .every((s) => landing.includes(s)),
  `plans.ts grants ${freeDialogues} dialogues`)
check('landing quotes the cheapest paid plan that actually exists',
  Number.isFinite(cheapestPaid) &&
  [`$${cheapestPaid}/мес`, `$${cheapestPaid}/oy`, `$${cheapestPaid}/mo`].every((s) => landing.includes(s)),
  `plans.ts starts at $${cheapestPaid}`)

const pitch = read('src/pages/PitchPage.tsx')
check('the investor pitch quotes the same prices as the billing code',
  pitch.includes(`$${cheapestPaid}-$${dearestPaid}/mo`) && !/credits/i.test(pitch),
  `plans.ts spans $${cheapestPaid}-$${dearestPaid}`)

check('the product exposes one model registry, not a per-screen list',
  /PROVIDERS\.flatMap/.test(models) && !/id: 'openai\/gpt-4\.1-mini'/.test(models))

const preflightLines = extra.split(/\r?\n/).filter((line) => /marketplaceDataRequired|marketplacePlanningWithoutData/.test(line))
check('the generic marketplace preflight is not hardcoded to one marketplace',
  preflightLines.length === 6 && preflightLines.every((line) => !/Uzum/.test(line)),
  `${preflightLines.filter((line) => /Uzum/.test(line)).length} of ${preflightLines.length} lines still name Uzum`)

if (failed) {
  console.error(`${failed} integration contract(s) failed.`)
  process.exit(1)
}
console.log('Integration truthfulness contracts passed.')
