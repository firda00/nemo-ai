// Шесть модулей платформы как инструменты агента.
//
// ЗДЕСЬ НЕТ ЛОГИКИ — только описания и переходники. Вся работа уже написана и проверена в своих
// модулях: пайплайн SDR, браузер на Playwright, сервис Telegram на grammY, синхронизация с CRM, рендер
// на FFmpeg, выгрузка файлов. Дублировать её здесь значило бы завести вторую реализацию, которая
// разойдётся с первой при первой правке.
//
// ── ПРАВА: ГЛАВНОЕ РЕШЕНИЕ ЭТОГО ФАЙЛА ─────────────────────────────────────────────────────────
//
// Инструмент помечается 'action', если его результат ВЫХОДИТ ЗА ПРЕДЕЛЫ этого разговора — то есть его
// нельзя отменить, закрыв терминал. По этому признаку, а не по «опасности вообще»:
//
//   search_leads      read_only  — читает чужие открытые данные, ничего не меняет
//   browser_navigate  read_only  — то же, открывает страницу
//   fs_export         read_only  — пишет НА СВОЙ диск, в свой каталог; отменяется удалением файла
//   render_video      read_only  — собирает файл у себя; никто снаружи его не увидит
//   telegram_send     ACTION     — сообщение живому человеку, отозвать нельзя
//   crm_sync          ACTION     — запись в чужую систему, где её увидит менеджер и начнёт звонить
//
// fs_export и render_video помечены чтением НАМЕРЕННО, и это стоит объяснить: они создают файлы, то
// есть побочный эффект у них есть. Но эффект ЛОКАЛЬНЫЙ и обратимый, а требовать подтверждения на
// каждое сохранение отчёта — верный способ приучить человека жать «да» не глядя. Тогда он так же
// нажмёт «да» на отправке карточки не тому клиенту. Подтверждение имеет смысл ровно до тех пор, пока
// его просят редко.

import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { defineTool, type ToolDefinition } from './registry.ts'
import { ToolRegistry } from './registry.ts'
import { buildAnalyzeCallTool, buildDialerQueueTool, buildDialerStatusTool, type AskModel } from './sales-tools.ts'
import type { Dialer } from '../modules/dialer/queue.ts'
import type { PlaybookCatalog } from '../modules/sales-qa/playbook.ts'
import { buildNavigateAndExtractTool, buildScreenshotTool, type BrowserEngine } from './browser.ts'
import { buildQaAuditTool, type QaProbe } from './qa-runner.ts'

// ── search_leads ──────────────────────────────────────────────────────────────────────────────────

export const SearchLeadsParams = z.object({
  query: z.string().min(2).max(200)
    .describe('Ниша или тип бизнеса: «стоматология», «автосервис», «кофейни»'),
  city: z.string().min(2).max(120)
    .describe('Город. Можно в разговорной форме: «в Ташкенте» — падеж снимается сам'),
  limit: z.number().int().min(1).max(200).default(15)
    .describe('Сколько компаний искать. Больше — дольше и дороже'),
  icp: z.string().max(2000).optional()
    .describe('Описание целевого клиента для оценки. Без него оценка пропускается'),
})

/**
 * Поиск и оценка лидов.
 *
 * Таймаут в десять минут, а не пятнадцать секунд по умолчанию: прогон на пятьдесят компаний — это
 * запрос к Overpass, полсотни загрузок чужих сайтов и полсотни вызовов модели. Стандартный предел
 * реестра обрывал бы его на первой же компании.
 */
export function buildSearchLeadsTool(deps: {
  runPipeline: (input: { query: string; city: string; limit: number; icp?: string }) => Promise<unknown>
}): ToolDefinition {
  return defineTool({
    name: 'search_leads',
    description: 'Найти компании по нише и городу через OpenStreetMap, собрать их контакты с сайтов и '
      + 'оценить соответствие профилю клиента. Возвращает список лидов с телефонами, сайтами, '
      + 'мессенджерами, баллом и готовым первым касанием. Применять на запросы вида «найди клиники в '
      + 'Ташкенте», «нужны автосервисы».',
    permission: 'read_only',
    parameters: SearchLeadsParams,
    timeoutMs: 10 * 60 * 1000,
    execute: async (args) => await deps.runPipeline({
      query: args.query, city: args.city, limit: args.limit, icp: args.icp,
    }),
  }) as ToolDefinition
}

// ── telegram_send_lead ────────────────────────────────────────────────────────────────────────────

export const TelegramSendParams = z.object({
  leadName: z.string().min(1).max(200).describe('Название компании'),
  phone: z.string().max(64).optional().describe('Телефон лида'),
  website: z.string().max(300).optional(),
  score: z.number().min(0).max(100).describe('Балл соответствия профилю клиента, 0-100'),
  reason: z.string().max(1000).optional().describe('Чем компания подходит'),
  pitch: z.string().max(2000).optional().describe('Готовый текст первого касания'),
  city: z.string().max(120).optional(),
})

/**
 * Карточка лида менеджеру.
 *
 * ДЕЙСТВИЕ. Сообщение уходит живому человеку и отзыву не подлежит: удалённое в Telegram сообщение он
 * уже увидел в уведомлении. Модель предлагает отправку на основании текста, который писала не она, —
 * решение принимает человек.
 */
export function buildTelegramSendTool(deps: {
  sendCard: (lead: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>
}): ToolDefinition {
  return defineTool({
    name: 'telegram_send_lead',
    description: 'Отправить карточку горячего лида менеджеру в Telegram с кнопками действий. '
      + 'ДЕЙСТВИЕ: сообщение уйдёт живому человеку, отменить нельзя.',
    permission: 'action',
    parameters: TelegramSendParams,
    timeoutMs: 30_000,
    execute: async (args) => {
      const outcome = await deps.sendCard(args as Record<string, unknown>)
      if (!outcome.ok) throw new Error(outcome.error ?? 'Telegram не принял сообщение')
      return { sent: true, lead: args.leadName }
    },
  }) as ToolDefinition
}

// ── crm_sync_lead ─────────────────────────────────────────────────────────────────────────────────

export const CrmSyncParams = z.object({
  leadName: z.string().min(1).max(200),
  phone: z.string().max(64).optional(),
  website: z.string().max(300).optional(),
  city: z.string().max(120).optional(),
  score: z.number().min(0).max(100).optional(),
  note: z.string().max(2000).optional().describe('Комментарий к сделке'),
})

/**
 * Выгрузка лида в CRM.
 *
 * ДЕЙСТВИЕ. Запись появляется в чужой системе, её видит менеджер и начинает по ней звонить. Ошибочная
 * запись стоит звонка не тому человеку, а удалить её из нашего кода нельзя.
 */
export function buildCrmSyncTool(deps: {
  syncLead: (lead: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>
}): ToolDefinition {
  return defineTool({
    name: 'crm_sync_lead',
    description: 'Выгрузить лид в CRM через вебхук. ДЕЙСТВИЕ: запись появится в системе продаж, и по '
      + 'ней начнут звонить.',
    permission: 'action',
    parameters: CrmSyncParams,
    timeoutMs: 30_000,
    execute: async (args) => {
      const outcome = await deps.syncLead(args as Record<string, unknown>)
      if (!outcome.ok) throw new Error(outcome.error ?? 'CRM не приняла запись')
      return { synced: true, lead: args.leadName }
    },
  }) as ToolDefinition
}

// ── render_video_pitch ────────────────────────────────────────────────────────────────────────────

export const RenderVideoParams = z.object({
  scenes: z.array(z.object({
    mediaUrl: z.string().url().describe('Адрес картинки или видео сцены'),
    durationSec: z.number().min(0.3).max(120),
  })).min(1).max(20).describe('Сцены ролика по порядку'),
  voiceoverUrl: z.string().url().describe('Адрес аудиодорожки диктора'),
  bgmUrl: z.string().url().optional(),
  subtitles: z.array(z.object({
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    text: z.string().min(1).max(200),
    highlightWord: z.string().max(60).optional(),
  })).max(200).optional().describe('Кинетические субтитры с подсветкой ключевого слова'),
})

/**
 * Сборка вертикального ролика.
 *
 * Чтение, а не действие: файл появляется на своём диске и никому не отправляется. Но таймаут большой —
 * рендер минутного ролика занимает минуты, и обычный предел реестра убил бы его на середине, оставив
 * недописанный файл.
 */
export function buildRenderVideoTool(deps: {
  render: (task: Record<string, unknown>) => Promise<unknown>
}): ToolDefinition {
  return defineTool({
    name: 'render_video_pitch',
    description: 'Собрать вертикальный ролик 9:16 (1080x1920) из сцен, озвучки и музыки с кинетическими '
      + 'субтитрами. Возвращает путь к готовому файлу.',
    permission: 'read_only',
    parameters: RenderVideoParams,
    timeoutMs: 20 * 60 * 1000,
    execute: async (args) => await deps.render(args as Record<string, unknown>),
  }) as ToolDefinition
}

// ── fs_export ─────────────────────────────────────────────────────────────────────────────────────

export const FsExportParams = z.object({
  format: z.enum(['csv', 'json', 'markdown']).describe('Формат файла'),
  filename: z.string().min(1).max(120)
    .describe('Имя файла без пути. Каталог выбирает система'),
  content: z.string().min(1).max(5_000_000).describe('Содержимое файла'),
})

/** Расширения по формату: имя без расширения или с чужим — обычное дело в ответе модели. */
const EXTENSION_BY_FORMAT: Record<string, string> = { csv: '.csv', json: '.json', markdown: '.md' }

/**
 * Безопасное имя файла.
 *
 * Модель предлагает имя по тексту, который писала не она. `../../.secrets.local` или
 * `C:\Windows\system32\x` в этом поле — не теория: имя попадает в путь на диске, и без обрезки
 * инструмент записи отчётов превращается в запись куда угодно.
 *
 * Берётся ТОЛЬКО базовое имя, из него вычищается всё, кроме букв, цифр, дефиса и подчёркивания, и
 * добавляется расширение по формату.
 */
export function safeExportName(filename: string, format: string): string {
  const base = path.basename(String(filename ?? '').trim())
  const stem = base.replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 80)
  return `${stem || 'export'}${EXTENSION_BY_FORMAT[format] ?? '.txt'}`
}

/**
 * Сохранение отчёта.
 *
 * Чтение по правам: файл ложится в СВОЙ каталог и отменяется удалением. Требовать подтверждения на
 * каждое сохранение значит приучить человека жать «да» не глядя — и тем обесценить подтверждение там,
 * где оно действительно нужно.
 */
/**
 * Атрибуция источника данных.
 *
 * ЭТО ТРЕБОВАНИЕ ЛИЦЕНЗИИ, А НЕ ВЕЖЛИВОСТЬ. Компании ищутся через OpenStreetMap, чьи данные под ODbL:
 * производные наборы обязаны называть источник. Выгруженный файл уходит в почту, в чат и в CRM
 * заказчика, то есть распространяется, — и без строки об источнике это нарушение условий, по которым
 * данные вообще разрешено использовать.
 *
 * Формат разный: в CSV и Markdown — комментарий, который человек прочитает; в JSON — поле, потому что
 * комментариев в JSON нет, а сломанный разбором файл хуже отсутствующей строки.
 */
export const OSM_ATTRIBUTION = 'Data © OpenStreetMap contributors (ODbL)'

export function withAttribution(content: string, format: string): string {
  const text = String(content ?? '')
  if (text.includes(OSM_ATTRIBUTION)) return text

  if (format === 'json') {
    try {
      const parsed = JSON.parse(text)
      // Массив нельзя дополнить полем, не сломав его форму для читателя: оборачиваем в объект.
      if (Array.isArray(parsed)) return JSON.stringify({ attribution: OSM_ATTRIBUTION, data: parsed }, null, 2)
      if (parsed && typeof parsed === 'object') {
        return JSON.stringify({ attribution: OSM_ATTRIBUTION, ...parsed as Record<string, unknown> }, null, 2)
      }
    } catch {
      // Негодный JSON не чиним и не портим: пишем как прислали, атрибуцию добавить некуда.
      return text
    }
    return text
  }

  if (format === 'markdown') return `${text.trimEnd()}\n\n---\n\n_${OSM_ATTRIBUTION}_\n`
  // CSV: строка комментария СВЕРХУ. Снизу её съедают программы, читающие файл до первой пустой строки.
  return `# ${OSM_ATTRIBUTION}\n${text}`
}

export function buildFsExportTool(deps: { directory: string }): ToolDefinition {
  return defineTool({
    name: 'fs_export',
    description: 'Сохранить отчёт в файл (CSV, JSON или Markdown) в рабочем каталоге. Применять, когда '
      + 'просят «выгрузи», «сохрани в файл», «сделай отчёт».',
    permission: 'read_only',
    parameters: FsExportParams,
    timeoutMs: 30_000,
    execute: async (args) => {
      const name = safeExportName(args.filename, args.format)
      const target = path.join(deps.directory, name)
      await fs.mkdir(deps.directory, { recursive: true })
      await fs.writeFile(target, withAttribution(args.content, args.format), 'utf8')
      const stat = await fs.stat(target)
      return { path: target, bytes: stat.size, format: args.format }
    },
  }) as ToolDefinition
}

// ── Сборка реестра ────────────────────────────────────────────────────────────────────────────────

export interface PlatformToolDeps {
  runPipeline?: Parameters<typeof buildSearchLeadsTool>[0]['runPipeline']
  browserEngine?: BrowserEngine
  sendCard?: Parameters<typeof buildTelegramSendTool>[0]['sendCard']
  syncLead?: Parameters<typeof buildCrmSyncTool>[0]['syncLead']
  render?: Parameters<typeof buildRenderVideoTool>[0]['render']
  /** Зонд аудита. Отдельно от browserEngine: аудиту нужны консоль и сеть, которых нет у движка. */
  qaProbe?: QaProbe
  /** Кто спрашивает модель для разбора звонка. Нет — инструмент не регистрируется. */
  askModel?: AskModel
  playbooks?: PlaybookCatalog
  /** Автодозвон. Нет — ни очереди, ни состояния: инструмента, которому некуда звонить, быть не должно. */
  dialer?: Dialer
  qaScreenshotDir?: string
  qaWriteFile?: (path: string, data: Uint8Array) => Promise<void>
  exportDirectory?: string
}

/**
 * Реестр под то, что действительно настроено.
 *
 * Инструмент, у которого нет зависимости, НЕ РЕГИСТРИРУЕТСЯ вовсе. Это важнее, чем кажется:
 * зарегистрированный, но неработающий инструмент модель увидит, предложит человеку и вызовет — а
 * получит отказ. Дальше она попробует ещё раз, потом объяснит человеку, что «сервис недоступен», и всё
 * это стоит токенов и времени. Чего нет — того модель и не видит.
 */
export function buildPlatformRegistry(deps: PlatformToolDeps): { registry: ToolRegistry; skipped: string[] } {
  const registry = new ToolRegistry()
  const skipped: string[] = []

  if (deps.runPipeline) registry.register(buildSearchLeadsTool({ runPipeline: deps.runPipeline }))
  else skipped.push('search_leads (нет пайплайна поиска)')

  if (deps.browserEngine) {
    registry.register(buildNavigateAndExtractTool(deps.browserEngine) as unknown as ToolDefinition)
    registry.register(buildScreenshotTool(deps.browserEngine) as unknown as ToolDefinition)
  } else skipped.push('browser_navigate_and_extract (браузер выключен, см. SDR_BROWSER)')

  if (deps.sendCard) registry.register(buildTelegramSendTool({ sendCard: deps.sendCard }))
  else skipped.push('telegram_send_lead (нет SDR_TELEGRAM_BOT_TOKEN/CHAT_ID)')

  if (deps.syncLead) registry.register(buildCrmSyncTool({ syncLead: deps.syncLead }))
  else skipped.push('crm_sync_lead (нет CRM_WEBHOOK_URL)')

  if (deps.render) registry.register(buildRenderVideoTool({ render: deps.render }))
  else skipped.push('render_video_pitch (нет ffmpeg или он непригоден)')

  // Аудит доступен и МОДЕЛИ, а не только команде /qa. Иначе на «проверь, почему сайт клиента тормозит»
  // модель отвечает пересказом общих советов вместо замеров: инструмент есть, но он ей не показан.
  if (deps.qaProbe) {
    registry.register(buildQaAuditTool({
      probe: deps.qaProbe,
      screenshotDir: deps.qaScreenshotDir,
      writeFile: deps.qaWriteFile,
    }))
  } else skipped.push('run_qa_audit (нет браузера для аудита)')

  // Разбор звонка не требует браузера — только модель. Поэтому он не привязан к qaProbe.
  if (deps.askModel) registry.register(buildAnalyzeCallTool({ ask: deps.askModel, catalog: deps.playbooks }))
  else skipped.push('analyze_sales_call (некому спросить модель)')

  /*
   * Автодозвон регистрируется ТОЛЬКО когда он передан.
   *
   * Инструмент постановки в очередь без самой очереди — худший вид заглушки: модель отчитается
   * человеку, что лиды поставлены на обзвон, а не поставлено ничего, и узнают об этом по
   * несостоявшимся продажам.
   */
  if (deps.dialer) {
    registry.register(buildDialerQueueTool({ dialer: deps.dialer }))
    registry.register(buildDialerStatusTool({ dialer: deps.dialer }))
  } else skipped.push('dialer_queue_lead (автодозвон не подключён)')

  registry.register(buildFsExportTool({ directory: deps.exportDirectory ?? process.cwd() }))

  return { registry, skipped }
}

export { EXTENSION_BY_FORMAT }
