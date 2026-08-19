// Подключения CLI: проверка зависимостей, баланс, состояние MCP, ярлыки инструментов.
//
// ОТДЕЛЬНО ОТ nemo.mjs, потому что каждая из этих функций молчит по-своему при отказе, и молчание надо
// проверять вызовом, а не запуском терминала. Точка входа их только соединяет.

import { spawn } from 'node:child_process'

/** Короткие ярлыки для строки состояния. Без них в дашборде было бы шесть длинных имён в две строки. */
const TOOL_BADGES: Array<{ match: RegExp; badge: string }> = [
  { match: /^search_leads$/, badge: 'OSM' },
  { match: /^browser_/, badge: 'Browser' },
  { match: /^telegram_/, badge: 'Telegram' },
  { match: /^crm_/, badge: 'CRM' },
  { match: /^render_/, badge: 'FFmpeg' },
  { match: /^fs_/, badge: 'FS' },
  { match: /^mcp__/, badge: 'MCP' },
]

/**
 * Строка состояния инструментов для дашборда.
 *
 * ЗАМЕНЯЕТ СПИСОК «недоступно: …» ПРИ СТАРТЕ. Пять красных строк о том, чего нет, читаются как пять
 * поломок и заставляют искать причину там, где её нет: браузер выключен настройкой, ffmpeg не нужен
 * для поиска клиентов. Что есть — важнее, чем чего нет. Чего нет, покажет /health по запросу.
 */
export function toolBadges(names: readonly string[]): string {
  const badges: string[] = []
  for (const name of names) {
    const found = TOOL_BADGES.find((one) => one.match.test(name))
    const badge = found?.badge ?? name
    if (!badges.includes(badge)) badges.push(badge)
  }
  return badges.length ? `${names.length} активны [${badges.join(', ')}]` : 'ни одного'
}

/** Есть ли исполняемый файл и отвечает ли он на --version. */
export function probeBinary(
  command: string,
  args: string[] = ['-version'],
  spawnImpl: typeof spawn = spawn,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    /*
     * Побеждает ПЕРВЫЙ ответ, и отдельного охранника для этого не нужно: промис разрешается один раз,
     * последующие вызовы resolve ничего не делают. Важно другое — снять таймер, иначе процесс
     * держится живым лишние три секунды после того, как всё уже выяснено.
     *
     * Порядок событий тут не случаен: отсутствующая программа даёт и 'error', и 'close', и первым
     * приходит 'error' — по нему видно причину («ENOENT»), а из кода выхода её не восстановить.
     */
    const finish = (value: { ok: boolean; detail: string }) => {
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish({ ok: false, detail: 'не ответил за 3 с' }), 3_000)
    try {
      /*
       * БЕЗ shell.
       *
       * С `shell: true` аргументы не экранируются, а склеиваются в командную строку — Node предупреждает
       * об этом отдельно. Здесь аргументы свои и безопасны, но привычка запускать проверки через
       * оболочку однажды встретит имя из настроек. Плюс без оболочки отсутствующий файл даёт внятный
       * ENOENT вместо «вышел с кодом 1».
       *
       * Цена отказа от оболочки на Windows — расширение .cmd у программ, поставленных через npm.
       */
      const resolved = process.platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(command) && command === 'npx'
        ? 'npx.cmd'
        : command
      const child = spawnImpl(resolved, args, { stdio: 'ignore' })
      child.on('error', (error: Error) => finish({ ok: false, detail: error.message.split('\n')[0] }))
      child.on('close', (code: number | null) => finish(
        code === 0 ? { ok: true, detail: 'найден' } : { ok: false, detail: `вышел с кодом ${code}` },
      ))
    } catch (error) {
      finish({ ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  })
}

/**
 * Файл, куда класть ключи.
 *
 * Названием, а не описанием: «настройте окружение» отправляет искать, где это окружение задаётся, а
 * `.secrets.local` — прямо в нужный файл. Он же первый в списке автозагрузки при старте.
 */
export const SECRETS_FILE = '.secrets.local'

export interface HealthCheck { name: string; ok: boolean; detail: string }

/**
 * Состояние зависимостей.
 *
 * Каждая проверка отвечает ЗА СЕБЯ и не роняет остальные: «Supabase не настроен» не повод скрыть, что
 * ffmpeg на месте. Проверки, требующие сети, здесь не делаются — /health не должен висеть полминуты,
 * когда человек просто хочет понять, почему не работает браузер.
 */
export async function collectHealth(
  env: Record<string, string | undefined> = process.env,
  probe: typeof probeBinary = probeBinary,
): Promise<HealthCheck[]> {
  const configured = (name: string, keys: string[], hint: string): HealthCheck => {
    const missing = keys.filter((key) => !env[key]?.trim())
    return {
      name,
      ok: missing.length === 0,
      // Отказ называет НЕДОСТАЮЩИЙ КЛЮЧ И ФАЙЛ, куда его писать. «Не настроен» без имени переменной
      // заставляет читать код; имя переменной без файла — искать, где этот файл вообще лежит.
      detail: missing.length === 0 ? 'настроен' : `задайте ${missing.join(', ')} в ${SECRETS_FILE} — ${hint}`,
    }
  }

  /*
   * Playwright проверяется РАЗРЕШЕНИЕМ МОДУЛЯ, а не запуском `npx playwright --version`.
   *
   * Запустить `npx.cmd` без оболочки Node отказывается начиная с исправления безопасности 2024 года
   * (spawn EINVAL), а с оболочкой аргументы не экранируются. Разрешение модуля отвечает на тот же
   * вопрос — установлен ли пакет — мгновенно и без подпроцесса.
   */
  const playwrightInstalled = await import('playwright')
    .then(() => ({ ok: true, detail: 'установлен' }))
    .catch((error: Error) => ({ ok: false, detail: `не установлен: ${error.message.split('\n')[0].slice(0, 60)}` }))

  const ffmpeg = await probe('ffmpeg', ['-version'])
  const chromium = playwrightInstalled

  return [
    configured('OpenRouter', ['OPENROUTER_API_KEY'], 'без него модель недоступна'),
    configured('Supabase', ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'], 'лиды не сохраняются'),
    configured('Telegram', ['SDR_TELEGRAM_BOT_TOKEN', 'SDR_TELEGRAM_MANAGER_CHAT_ID'], 'карточки не уходят'),
    configured('CRM', ['CRM_WEBHOOK_URL'], 'выгрузка в CRM отключена'),
    configured('Dragonfly', ['DRAGONFLY_URL'], 'очередь задач отключена'),
    {
      name: 'FFmpeg',
      ok: ffmpeg.ok,
      // Про ffmpeg говорим ПОСЛЕДСТВИЕ, а не только факт: «spawn ENOENT» ничего не сообщает тому,
      // кто не знает, зачем в этом проекте ffmpeg.
      detail: ffmpeg.ok ? ffmpeg.detail : `системный бинарник не найден (видеорендер отключён): ${ffmpeg.detail}`,
    },
    {
      name: 'Browser',
      ok: chromium.ok && env.SDR_BROWSER !== 'off',
      detail: env.SDR_BROWSER === 'off' ? 'выключен настройкой SDR_BROWSER=off' : chromium.detail,
    },
    configured('MCP', ['NEMO_MCP_SERVERS'], 'внешние серверы не подключены'),
  ]
}

/**
 * Остаток на счёте OpenRouter.
 *
 * Отказ возвращается ЗНАЧЕНИЕМ и называет причину: показать «$0.00» вместо «запрос не прошёл» значит
 * отправить человека пополнять счёт, на котором деньги есть.
 */
export async function fetchBalance(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (!apiKey?.trim()) return { ok: false, error: 'нет OPENROUTER_API_KEY' }
  try {
    const response = await fetchImpl('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!response.ok) return { ok: false, error: `OpenRouter ответил ${response.status}` }
    const body = await response.json() as { data?: { total_credits?: number; total_usage?: number } }
    const granted = body.data?.total_credits
    const used = body.data?.total_usage
    if (typeof granted !== 'number' || typeof used !== 'number') {
      return { ok: false, error: 'ответ без полей total_credits/total_usage' }
    }
    const left = granted - used
    return { ok: true, text: `остаток $${left.toFixed(2)} (начислено $${granted.toFixed(2)}, потрачено $${used.toFixed(2)})` }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export { TOOL_BADGES }
