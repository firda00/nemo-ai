// Контракты V5: соответствие миграции, схем и кода — по ИСХОДНОМУ ТЕКСТУ.
//
// Поведенческие наборы проверяют, что код делает. Здесь проверяется другое: что он СВЯЗАН правильно и
// что решения, принятые осознанно, не отменятся тихой правкой. Такие вещи поведением не проверить —
// например, «журнал звонков недоступен клиенту на запись» видно только в наборе политик RLS, а
// «значения в CHECK совпадают со значениями в Zod» — только сверкой двух файлов.
//
// Отдельно защищается ОТСТУПЛЕНИЕ ОТ ТЗ: миграция ссылается на public.accounts, а не на tenants,
// потому что таблицы tenants в этой базе нет. Кто-нибудь однажды «исправит» это по спецификации, и
// миграция перестанет применяться. Контракт ниже поймает это до деплоя.

import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

/**
 * Файл БЕЗ комментариев — для отрицательных утверждений.
 *
 * Ловушка, на которую этот набор уже попался при первом прогоне: комментарии в исходниках ЦИТИРУЮТ те
 * самые анти-образцы, от которых предупреждают. Заголовок миграции объясняет, почему нельзя писать
 * `references tenants(id)`; заголовок bot-service.ts приводит вариант из ТЗ с
 * `recordingUrl || 'https://nemo.ai'`. Утверждение вида «этой строки в файле нет» ловило собственную
 * документацию и падало на верном коде. Отрицания обязаны смотреть на КОД, а не на прозу о нём.
 */
const code = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|\s)\/\/[^\n]*/g, '$1')
  .replace(/(^|\s)--[^\n]*/g, '$1')

const migration = read('supabase/migrations/20260817220000_v5_core_schema.sql')
const amoWebhookMigration = read('supabase/migrations/20260824160000_amocrm_native_webhook_identity.sql')
const v5 = read('agent-hub/contracts/v5.ts')
const amoNative = read('agent-hub/server/amocrm-native.ts')
const gateway = read('agent-hub/server/gateway.ts')
const bot = read('agent-hub/telegram/bot-service.ts')
const bridge = read('agent-hub/telegram/lead-card-bridge.ts')
const registry = read('agent-hub/tools/registry.ts')
const mcp = read('agent-hub/tools/mcp-client.ts')
const browser = read('agent-hub/tools/browser.ts')
const enrichBrowser = read('agent-hub/tools/enrich-browser.ts')
const enricher = read('supabase/functions/_shared/leadgen/enricher.ts')
const schemas = read('supabase/functions/_shared/leadgen/schemas.ts')
const sdrRun = read('agent-hub/sdr-run.mjs')
const worker = read('agent-hub/sdr-worker.mjs')
const packageJson = read('package.json')

const cases = [
  // ── Миграция V5: изоляция тенантов ────────────────────────────────────────────────────────────
  ['all four V5 tables exist with tenant isolation',
    ['telephony_trunks', 'telephony_calls', 'crm_integrations', 'crm_sync_logs'].every((table) =>
      migration.includes(`create table if not exists public.${table}`)
      && migration.includes(`alter table public.${table} enable row level security`))],

  // Отступление от ТЗ, сделанное вынужденно: таблицы tenants в базе НЕТ, на неё указывать нельзя.
  // «Исправление» по букве спецификации сделает миграцию неприменимой.
  ['tenant_id points at public.accounts, never at the non-existent tenants table',
    (migration.match(/tenant_id uuid not null references public\.accounts\(id\) on delete cascade/g) ?? []).length === 4
    && !/references\s+tenants\s*\(/.test(code(migration))],

  // Имена колонок при этом сохранены как в ТЗ — чтобы Zod-контракты и SQL совпадали поле в поле.
  ['column names follow the V5 spec so contracts and SQL need no adapter',
    migration.includes('trunk_type varchar(20)') && migration.includes('auth_password_encrypted text not null')
    && migration.includes('sip_hangup_cause varchar(64)') && migration.includes('full_transcript jsonb')
    && migration.includes('credentials_encrypted jsonb not null') && migration.includes('stage_mappings jsonb not null')],

  /*
   * Аудит нельзя переписать из клиента.
   *
   * telephony_calls — основание для счёта, crm_sync_logs — доказательство доставки. Клиент, способный
   * изменить длительность звонка или статус синхронизации, обесценивает и то, и другое. Поэтому у этих
   * двух таблиц политика ТОЛЬКО на select, а у настроечных (trunks, integrations) — for all.
   */
  ['audit tables are readable but not writable by the tenant',
    migration.includes('create policy telephony_calls_tenant_read on public.telephony_calls for select')
    && migration.includes('create policy crm_sync_logs_tenant_read on public.crm_sync_logs for select')
    && !/create policy telephony_calls\w* on public\.telephony_calls for (all|insert|update)/.test(migration)
    && !/create policy crm_sync_logs\w* on public\.crm_sync_logs for (all|insert|update)/.test(migration)],

  ['configuration tables are fully writable by their owner',
    migration.includes('create policy telephony_trunks_tenant on public.telephony_trunks for all')
    && migration.includes('create policy crm_integrations_tenant on public.crm_integrations for all')
    && (migration.match(/with check \(tenant_id = public\.current_account_id\(\)\)/g) ?? []).length === 2],

  /*
   * КЛЮЧ ИДЕМПОТЕНТНОСТИ несёт логику, а не гигиену.
   *
   * Вебхуки CRM приходят повторно: amoCRM переспрашивает при таймауте, HubSpot дублирует доставку. Без
   * UNIQUE повторный вебхук создаёт ВТОРУЮ сделку по тому же звонку, и менеджер звонит человеку дважды.
   * Проверка «а нет ли уже такой записи» перед вставкой проигрывает гонку при нескольких воркерах —
   * работает только ограничение на уровне базы.
   */
  ['the CRM idempotency key is unique at the database level',
    /idempotency_key varchar\(128\) not null unique/.test(migration)],

  // Журнал звонков не должен исчезать вместе с настройкой транка: это основание для счёта и для разбора
  // жалоб. Поэтому RESTRICT, а не CASCADE — в отличие от tenant_id, где CASCADE как раз уместен.
  ['deleting a trunk cannot erase its call history',
    migration.includes('trunk_id uuid not null references public.telephony_trunks(id) on delete restrict')],

  // updated_at триггером, а не значением по умолчанию: default срабатывает только на вставке, и строка,
  // изменённая через год, продолжала бы показывать дату создания.
  ['updated_at is maintained by a trigger, not by a default',
    migration.includes('create or replace function public.v5_touch_updated_at()')
    && (migration.match(/execute function public\.v5_touch_updated_at\(\)/g) ?? []).length === 2
    // Имена триггеров проверяются отдельно: одного счёта вызовов функции недостаточно, потому что
    // переименованный триггер вешается на другую таблицу (или ни на какую) и счёт при этом не меняется.
    // Перевод строки ищется как \r?\n: рабочее дерево здесь CRLF, и проверка с голым \n объявляла
    // дефект на исправной миграции — сразу после `git checkout`, когда git нормализует окончания.
    && /create trigger telephony_trunks_set_updated_at\r?\n\s*before update on public\.telephony_trunks/.test(migration)
    && /create trigger crm_integrations_set_updated_at\r?\n\s*before update on public\.crm_integrations/.test(migration)],

  ['native amoCRM webhook identity is hashed, unique and service-role only',
    amoWebhookMigration.includes('inbound_webhook_secret_hash text')
    && amoWebhookMigration.includes('crm_integrations_webhook_secret_hash_unique')
    && amoWebhookMigration.includes("inbound_webhook_secret_hash ~ '^[0-9a-f]{64}$'")
    && amoWebhookMigration.includes('security definer')
    && amoWebhookMigration.includes("set search_path = ''")
    && amoWebhookMigration.includes('revoke all on function public.resolve_amocrm_webhook(text, text) from public, anon, authenticated')
    && amoWebhookMigration.includes('grant execute on function public.resolve_amocrm_webhook(text, text) to service_role')],

  ['native amoCRM form ingestion is bounded, tenant-bound and shadow-only',
    amoNative.includes("FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])")
    && amoNative.includes('MAX_RUNTIME_PAYLOAD_BYTES = 60 * 1024')
    && amoNative.includes("workflowType: 'amocrm_native_enrichment'")
    && amoNative.includes("executionMode: 'shadow'")
    && gateway.includes("p_subdomain: parsed.accountSubdomain")
    // Перенос строки ищется как \r?\n: рабочее дерево на Windows хранится в CRLF,
    // и литерал с одним \n не совпадает с файлом, который на самом деле в порядке.
    // Проверка падала именно на разметке строк, а не на разборе формы.
    && /app\.addContentTypeParser\(\r?\n\s*'application\/x-www-form-urlencoded'/.test(gateway)],

  // ── Согласие CHECK-ограничений и Zod ─────────────────────────────────────────────────────────
  //
  // Расхождение здесь означает запись, которая проходит проверку схемы и падает на вставке — то есть
  // звонок состоялся, а сохранить его нечем.
  ['SQL CHECK values and Zod enums agree',
    migration.includes("check (trunk_type in ('CUSTOM_SIP', 'NEMO_RENTED'))")
    && v5.includes("trunk_type: z.enum(['CUSTOM_SIP', 'NEMO_RENTED'])")
    && migration.includes("check (direction in ('INBOUND', 'OUTBOUND'))")
    && v5.includes("CrmSyncDirectionSchema = z.enum(['INBOUND', 'OUTBOUND'])")
    && migration.includes("check (status in ('PROCESSED', 'FAILED', 'RETRYING'))")
    && v5.includes("CrmSyncStatusSchema = z.enum(['PROCESSED', 'FAILED', 'RETRYING'])")
    && migration.includes("check (provider in ('AMOCRM', 'HUBSPOT'))")
    && v5.includes("provider: z.enum(['AMOCRM', 'HUBSPOT'])")],

  ['the E.164 pattern is the same in SQL and in Zod',
    migration.includes("check (caller_id ~ '^\\+?[1-9][0-9]{1,14}$')")
    && v5.includes('export const E164 = /^\\+?[1-9]\\d{1,14}$/')],

  // ── Ключ идемпотентности: свёртка, а не обрезка ──────────────────────────────────────────────
  //
  // Обрезка теряла РАЗЛИЧИЕ между событиями: приставка занимает 34 знака, от внешнего id оставалось 94,
  // и два разных события давали один ключ. Второе, настоящее, база отвергала как дубль — обновление
  // сделки ТЕРЯЛОСЬ. Дубль видно, потерю нет.
  ['a long idempotency key is folded with a hash, never truncated',
    v5.includes("const digest = createHash('sha256').update(full, 'utf8').digest('hex')")
    && v5.includes('if (full.length <= IDEMPOTENCY_KEY_LIMIT) return full')
    && !/return full\.slice\(0, IDEMPOTENCY_KEY_LIMIT\)/.test(v5)
    && v5.includes('const IDEMPOTENCY_KEY_LIMIT = 128')],

  // ── Экранирование ────────────────────────────────────────────────────────────────────────────
  //
  // Содержимое карточки чужое, а parse_mode: 'HTML'. Каждая вставка обязана быть экранирована; разметку
  // задаёт только сам файл. Неэкранированная вставка даёт либо отказ 400 (карточка не приходит вовсе),
  // либо чужую ссылку в сообщении менеджеру.
  ['every foreign value in the lead card goes through escapeHtml',
    bot.includes('${escapeHtml(payload.leadName') && bot.includes('${escapeHtml(payload.customerPhone)}')
    && bot.includes('${escapeHtml(pain)}') && bot.includes('escapeHtml(summary)')
    && bot.includes('${escapeHtml(payload.recommendedAction)}')
    // Амперсанд ПЕРВЫМ, иначе &lt; из < сам станет &amp;lt;.
    && bot.indexOf("replace(/&/g, '&amp;')") < bot.indexOf("replace(/</g, '&lt;')")],

  ['MarkdownV2 escaping covers the full Bot API list',
    ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!']
      .every((ch) => bot.includes('escapeMarkdownV2') && new RegExp(`\\${ch}`).test(
        bot.split('export function escapeMarkdownV2')[1]?.split(/\r?\n/).slice(0, 3).join('\n') ?? '',
      ))],

  // ── Отступление от ТЗ по кнопке записи ───────────────────────────────────────────────────────
  //
  // В спецификации: .url('🎧 Слушать запись', payload.recordingUrl || 'https://nemo.ai') — то есть при
  // отсутствии записи менеджеру показывают кнопку, ведущую на главную страницу. Человек нажимает,
  // попадает не туда и перестаёт доверять кнопкам вообще.
  ['the recording button appears only when a recording exists',
    bot.includes('if (payload.recordingUrl) {')
    && !code(bot).includes("payload.recordingUrl || 'https://nemo.ai'")],

  // callback_data приходит от клиента Telegram и подделывается тривиально: кто угодно с ботом может
  // послать send_offer с любым идентификатором.
  ['callback data is validated by prefix AND by UUID shape',
    bot.includes('if (action !== CALLBACK_SEND_OFFER && action !== CALLBACK_MANUAL_CALL) return null')
    && bot.includes('if (!z.string().uuid().safeParse(callId).success) return null')],

  // answerCallbackQuery вызывается во ВСЕХ ветках, включая отказ. Без него клиент двадцать секунд крутит
  // часики, и менеджер жмёт кнопку второй раз — то есть оффер уходит дважды.
  ['every callback branch answers the query',
    (bot.match(/answerCallbackQuery\(/g) ?? []).length >= 3
    && bot.split('bot.on(\'callback_query:data\'')[1]?.includes('catch (error)')],

  // ── Карточка найденного лида не врёт ─────────────────────────────────────────────────────────
  //
  // Лид из SDR-прогона — компания, которой ещё не звонили. Три поля LeadCardNotification описывают
  // событие, которого не было. CALL_LATER — единственное значение из четырёх, которое не врёт;
  // INTERESTED_DEMO утверждало бы, что лид выразил интерес.
  ['a found lead never claims a call happened',
    bridge.includes("outcome: 'CALL_LATER' as const")
    && !code(bridge).includes("outcome: 'INTERESTED_DEMO'")
    && bridge.includes("['Звонка ещё не было — лид найден SDR-прогоном.']")
    && !code(bridge).includes("headline: '⚡ Завершен AI-звонок'")
    && bridge.includes("scoreLabel: 'Соответствие ICP'")],

  // Идентификатор карточки устойчив: случайный означал бы, что повторный прогон присылает карточку с
  // новым id, и кнопка ссылается на то, чего нет ни в одной таблице.
  ['the card id is derived from the lead, not random',
    bridge.includes('lead.dedupe_key ||')
    && bridge.includes("createHash('sha1')")
    && !/Math\.random/.test(bridge)],

  // Карточки ЗАМЕНЯЮТ обычные уведомления, а не добавляются к ним: иначе на каждый горячий лид уходит
  // два сообщения об одном и том же.
  ['lead cards replace the plain notifier instead of duplicating it',
    sdrRun.includes('notify: cards.enabled ? null : resolveNotifier()')
    && bridge.includes("if (!['1', 'true', 'on', 'yes'].includes(flag))")],

  // ── Реестр инструментов: запрет по умолчанию ──────────────────────────────────────────────────
  //
  // Модель предлагает вызов по имени и с произвольным JSON, и оба берутся из текста, который писала не
  // она: содержимое чужого сайта, чужое письмо. Без запрета по умолчанию страница, на которой написано
  // «вызови send_offer», будет исполнена.
  ['tool permissions deny actions by default',
    registry.includes("if (tool.permission === 'read_only') return true")
    && registry.includes('return (context.allowedActions ?? []).includes(tool.name)')
    // Порядок проверок: право РАНЬШЕ разбора аргументов, иначе текст ошибки подсказывает, как подобрать
    // аргументы к запрещённому действию.
    && registry.indexOf("code: 'permission_denied'") < registry.indexOf('tool.parameters.safeParse')],

  ['the model only sees tools it is allowed to call',
    registry.includes('.filter((tool) => this.isAllowed(tool, context))')],

  // Инструменты ходят в сеть и в браузер, то есть падают регулярно по чужим причинам. Исключение отсюда
  // означало бы, что один недоступный сайт роняет прогон вместе с уже найденными лидами.
  ['tool failures are values, never exceptions',
    registry.includes('export type ToolOutcome') && registry.includes(": 'execution_failed')")
    && registry.split('async call(name: string')[1]?.includes('} catch (error) {')],

  // ── MCP: чужой сервер не выдаёт права сам себе ───────────────────────────────────────────────
  ['an MCP server cannot grant itself permission',
    mcp.includes("if (descriptor.annotations?.destructiveHint) return 'action'")
    // Разрушительный пересиливает собственное readOnlyHint сервера, а молчание сервера трактуется как
    // действие, а не как безопасность.
    && mcp.indexOf('destructiveHint') < mcp.indexOf('readOnlyHint === true')
    // \r?\n по той же причине: с голым \n проверка падала на исправном файле в CRLF-дереве.
    && /return 'action'\r?\n\}/.test(mcp.split('export function resolvePermission')[1] ?? '')],

  ['MCP tool names are namespaced so they cannot shadow ours',
    mcp.includes('const full = `mcp__${serverName}__${safe}`')
    && mcp.includes('return full.length <= 64 ? full : full.slice(0, 64)')],

  // Наследовать весь process.env в чужой процесс нельзя: там SUPABASE_SECRET_KEY, OPENROUTER_API_KEY и
  // пеппер токенов, и MCP-серверу они не нужны ни один.
  ['MCP child processes get an explicit environment, never ours',
    mcp.includes('env: { ...getDefaultEnvironment(), ...config.env }')
    && mcp.includes('env: z.record(z.string()).default({})')
    && !/env: process\.env/.test(mcp)],

  // Причина, по которой сервер не поднялся, лежит в его stderr. Без неё отказ выглядит как
  // «Connection closed» — сообщение, по которому нельзя понять ничего.
  ['a failed MCP server reports why, not just that it closed',
    mcp.includes('const details = await readStderr(transport)')
    && mcp.includes('Сервер сказал:')],

  // ── Браузер ──────────────────────────────────────────────────────────────────────────────────
  //
  // Незакрытый Chromium остаётся зомби-процессом; через сутки такого воркера машина уходит в свап.
  ['the browser is closed in finally on every path',
    // По ОДНОМУ закрытию на каждый метод, открывающий контекст: harvest и screenshot. Проверять «хотя бы
    // одно» недостаточно — забытое закрытие во втором методе оставляет процесс рендерера навсегда.
    (browser.match(/await context\?\.close\(\)\.catch\(\(\) => \{\}\)/g) ?? []).length === 2
    && (browser.match(/} finally \{/g) ?? []).length >= 2
    && sdrRun.includes('await browser.close()')
    && worker.includes('await browser.close()')
    && sdrRun.split('const browser = createBrowserBridge()')[1]?.includes('} finally {')
    && worker.split('const browser = createBrowserBridge()')[1]?.includes('} finally {')],

  ['heavy resources and analytics never load',
    browser.includes("BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media', 'stylesheet'])")
    && browser.includes('if (BLOCKED_RESOURCE_TYPES.has(resourceType)) return true')
    && browser.includes('googletagmanager.com') && browser.includes('mc.yandex.ru')],

  // networkidle ОТДЕЛЬНЫМ ожиданием с мягким отказом: сайт со счётчиком, опрашивающим сервер по таймеру,
  // не затихает никогда, и goto({waitUntil:'networkidle'}) на нём падает целиком, выбрасывая уже
  // отрисованную страницу.
  ['networkidle failure does not discard an already rendered page',
    browser.includes("await page.waitForLoadState('networkidle', { timeout: options.idleMs })")
    && browser.includes(".catch(() => { /* сеть не затихла — забираем то, что уже отрисовано */ })")
    && browser.includes("waitUntil: 'domcontentloaded'")],

  // Мы не обходим защиту от роботов. Страница-заслон РАСПОЗНАЁТСЯ и возвращается признаком, чтобы
  // вызывающий код не принял «Checking your browser» за описание компании.
  ['a challenge page is reported, never mistaken for content',
    browser.includes('const blocked = looksLikeChallenge(harvest.title, harvest.text)')
    && enricher.includes("failed.push('browser_blocked')")],

  ['browser tools are read-only so they run without confirmation',
    (browser.match(/permission: 'read_only'/g) ?? []).length === 2
    && !/permission: 'action'/.test(code(browser))],

  // ── Обогащение: браузер внедряется, а не импортируется ───────────────────────────────────────
  //
  // Этот слой выполняется и в Deno (Edge Functions), где Playwright не существует. Статический импорт
  // сломал бы его целиком.
  ['the enricher receives the browser as a parameter, never importing it',
    enricher.includes('browserFallback: BrowserFallback | null = null')
    && !/from '.*playwright/.test(code(enricher))
    && !/agent-hub/.test(code(enricher))
    && enrichBrowser.includes("from '../../supabase/functions/_shared/leadgen/enricher.ts'")],

  // Браузер запускается только когда простой способ ДОКАЗАННО не сработал: он стоит секунды и полторы
  // сотни мегабайт, а компания с телефоном в обычной разметке не должна за это платить.
  ['the browser runs only after the plain fetch demonstrably failed',
    enricher.includes('const verdict = needsBrowserFallback({')
    && enricher.includes("if (foundPhones > 0 || foundEmails > 0 || foundSocials > 0)")
    // 404 браузером не лечится: страницы просто нет, и второй заход её не создаст.
    && enricher.includes('страницы нет, браузер не поможет')
    && enrichBrowser.includes('export function browserFallbackEnabled')],

  // Найденный WhatsApp обязан иметь куда лечь: в регионе это основной канал малого бизнеса, и раньше
  // ссылка wa.me находилась и молча выбрасывалась.
  ['a discovered WhatsApp link has a field to live in and a place to show',
    schemas.includes('whatsapp: z.string().url().max(300).nullable().default(null)')
    && enricher.includes("if (kind === 'whatsapp' && !out.whatsapp) out.whatsapp = url")
    && read('supabase/functions/_shared/leadgen/notifier.ts').includes('WhatsApp</a>')],

  // Новые поля обогащения обязаны иметь значения по умолчанию: записи, сохранённые до их появления,
  // должны продолжать проходить проверку при чтении из базы.
  ['new enrichment fields default so old rows still validate',
    schemas.includes('booking_widgets: z.array(z.string().max(40)).max(20).default([])')
    && schemas.includes('rendered_by_browser: z.boolean().default(false)')],

  // ── Наборы подключены к гейту ────────────────────────────────────────────────────────────────
  /*
   * Наборы обязаны запускаться гейтом.
   *
   * Сверка идёт по ПОЛНОЙ команде с закрывающей скобкой, а не по подстроке: `npm run test:v5` входит и в
   * `npm run test:v5-contracts`, поэтому проверка подстрокой проходила даже когда первого набора в гейте
   * не было вовсе. Мутационный прогон это и показал.
   */
  ['the new suites run in the quality gate',
    ['test:tools', 'test:v5', 'test:v5-contracts'].every((script) => packageJson.includes(`"${script}":`))
    && ['test:tools', 'test:v5', 'test:v5-contracts'].every((script) =>
      read('agent-hub/quality-gate.ps1').includes(`{ npm run ${script} }`))],
]

let failed = 0
for (const [name, passed] of cases) {
  if (!passed) { console.log(`FAIL ${name}`); failed++ }
}
console.log(`V5 and agent-tool contracts: ${cases.length - failed}/${cases.length}`)
if (failed) process.exit(1)
