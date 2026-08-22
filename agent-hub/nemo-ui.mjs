// Отрисовка агентного цикла в терминале: бейджи вызовов и потоковый текст.
//
// ОТДЕЛЬНО ОТ ТОЧКИ ВХОДА, потому что это чистые функции над событиями: их проверяют сравнением строк,
// а не запуском агента с настоящей моделью. Точка входа занимается подключениями и вводом.
//
// ЧТО ЗАМЕНИЛО РАМКИ. Каждый вызов инструмента рисовался коробом в четыре строки. На цепочке из пяти
// вызовов экран занимали двадцать строк служебной графики, среди которых терялся ответ модели —
// то есть единственное, ради чего всё это запускали. Теперь вызов — одна строка, и появляется она
// ПОСЛЕ завершения, когда есть что сказать: имя, итог, время.
//
// ПОКА ВЫЗОВ ИДЁТ, крутится спиннер с именем инструмента. Он транзитный: строка стирается и на её
// месте появляется бейдж. Это заодно снимает старую беду рамок — открытый короб, который некому
// закрыть при раннем выходе.

import { c, stopActiveSpinner, visibleWidth, Spinner } from './tui.mjs'
import { agentBadge, groupSummary, reasoningLine, thoughtBadge, toolBadge, shortUrl, GROUP_THRESHOLD } from './cli/hud.ts'

// Байт ESC собирается из кода намеренно: литеральный символ escape в исходнике невидим, и его уже
// трижды теряли при правках — строка молча переставала стирать, а бегущий текст оставался на экране.
const ESC = String.fromCharCode(27)

/**
 * Стереть текущую строку целиком и вернуть каретку в начало.
 *
 * `\r` без стирания недостаточен: он лишь возвращает каретку, и остаток прежней, более длинной строки
 * виден справа от новой.
 */
export const CLEAR_LINE = `\r${ESC}[2K`

/** Человеческие подписи частых полей. Незнакомое поле показывается своим именем — это не ошибка. */
const LABELS = {
  query: 'Ниша', city: 'Город', limit: 'Лимит', icp: 'Профиль клиента',
  url: 'Адрес', leadName: 'Лид', phone: 'Телефон', website: 'Сайт',
  score: 'Балл', format: 'Формат', filename: 'Файл', scenes: 'Сцены',
}

/** Значения аргументов одной строкой — то, что человек прочитает, не вчитываясь в JSON. */
export function formatArgs(args) {
  const parts = []
  for (const [key, value] of Object.entries(args ?? {})) {
    if (value === undefined || value === null || value === '') continue
    const shown = Array.isArray(value)
      ? `${value.length} шт.`
      : typeof value === 'object'
        ? JSON.stringify(value).slice(0, 40)
        : String(value)
    parts.push(`${LABELS[key] ?? key}: ${shown.length > 60 ? `${shown.slice(0, 60)}…` : shown}`)
  }
  return parts.join(' | ') || 'без параметров'
}

/** Что показывать в бегущей строке, пока инструмент работает. Коротко: строка живёт секунды. */
export function runningLabel(name, args) {
  // Город через разделитель, а не «в <город>»: подставлять предлог к имени в именительном падеже
  // значит печатать «в Ташкент» — мелкая неряшливость, которую видно каждому носителю языка.
  if (name === 'search_leads') return `Ищу ${args?.query ?? 'компании'}${args?.city ? ` · ${args.city}` : ''}`
  if (name.startsWith('browser_')) return `Открываю ${shortUrl(String(args?.url ?? ''))}`
  if (name === 'run_qa_audit') return `Проверяю ${shortUrl(String(args?.url ?? ''))}`
  if (name === 'fs_export') return 'Сохраняю файл'
  if (name === 'telegram_send_lead') return 'Отправляю карточку'
  if (name === 'crm_sync_lead') return 'Пишу в CRM'
  if (name === 'render_video_pitch') return 'Собираю ролик'
  return name
}

/** Запрос подтверждения действия. Показывает ИМЕННО то, что будет сделано. */
export function confirmationPrompt(name, args) {
  return [
    '',
    c.yellow(`  ⚠ ${name} изменит данные за пределами этого разговора.`),
    `  ${c.dim(formatArgs(args))}`,
    `  ${c.bold('Выполнить?')} ${c.dim('(д/нет)')}`,
  ].join('\n')
}

/**
 * Подписчик на события агента, печатающий их в поток.
 *
 * Состояние здесь минимальное и всё нужное: шёл ли текст последним (иначе бейдж приклеится к слову),
 * когда начался ход (для «Думал N с») и что уже вызвали (для сводки цепочки).
 */
export function createRenderer(
  write = (text) => process.stdout.write(text),
  silenceSpinner = stopActiveSpinner,
  /*
   * Как заводить бегущую строку.
   *
   * ЗАВИСИМОСТЬЮ, а не прямым вызовом new Spinner(): спиннер по умолчанию пишет в process.stdout, а
   * не в поток, переданный этому подписчику. В проверках, где вывод собирается в строку, он писал
   * мимо — прямо в терминал того, кто запустил тесты, и в собранном выводе его не было вовсе.
   */
  makeSpinner = (label) => new Spinner().start(label),
) {
  let textFlowing = false
  let turnStartedAt = null
  let thoughtShown = false
  let badgeShown = false
  let turnRole = null
  let calls = []
  let spinner = null
  let thinkingTimer = null
  let pendingArgs = new Map()

  /**
   * Освободить строку под собственный вывод.
   *
   * Порядок обратный очевидному: стирание убирает ВСЁ на текущей строке, включая текст, который
   * модель только что выдала потоком и который ещё не закрыт переводом строки. Сначала закрываем свой
   * текст, потом стираем — на новой строке стирать уже нечего, кроме остатков спиннера.
   */
  const takeLine = () => {
    silenceSpinner()
    if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null }
    if (spinner) { spinner.silence(); spinner = null }
    if (textFlowing) { write('\n'); textFlowing = false }
    write(CLEAR_LINE)
  }

  /** «Думал N с» печатается ОДИН раз за ход, до первого текста или первого вызова. */
  const showThought = () => {
    if (thoughtShown || turnStartedAt === null) return
    thoughtShown = true
    const elapsed = Date.now() - turnStartedAt
    // Меньше трёхсот миллисекунд — не размышление, а сетевая задержка. Печатать её значит выдавать
    // задержку канала за работу мысли.
    if (elapsed >= 300) write(`${thoughtBadge(elapsed)}\n`)
  }

  return {
    /**
     * Начало хода: сбрасываем счётчики и запоминаем роль для бейджа.
     *
     * ВЫЗОВ ОБЯЗАТЕЛЕН, И ЕГО ОТСУТСТВИЕ НЕ ВИДНО. Пока точка входа этот метод не вызывала,
     * turnStartedAt оставался null — и showThought выходил на первом же условии. Бейдж «✦ Думал N с»
     * был написан, покрыт тестами через прямой вызов beginTurn и при этом не появлялся в терминале
     * ни разу: тест звал метод, а живой цикл — нет. Контракт на связку добавлен в agent-loop.
     */
    beginTurn(roleName = null, options = {}) {
      turnStartedAt = Date.now()
      thoughtShown = false
      badgeShown = false
      turnRole = roleName
      calls = []
      pendingArgs = new Map()

      /*
       * БЕГУЩАЯ СТРОКА РАЗМЫШЛЕНИЯ ЗАВОДИТСЯ ЗДЕСЬ, А НЕ ПРИ ПЕРВОМ ТЕКСТЕ.
       *
       * Ждать первого фрагмента значило бы молчать ровно то время, ради которого строка и нужна:
       * между отправкой запроса и первым токеном проходят секунды, и неподвижный экран в этот
       * момент неотличим от зависшего процесса. Человек жмёт Ctrl+C за миг до ответа.
       *
       * Строка транзитная: её стирает takeLine, как только появляется что печатать.
       */
      spinner = makeSpinner(reasoningLine({ elapsedMs: 0, temperature: options.temperature ?? null }))
      thinkingTimer = setInterval(() => {
        if (!spinner || turnStartedAt === null) return
        /*
         * ТИКАЕМ ТОЛЬКО В ЖИВОМ ТЕРМИНАЛЕ.
         *
         * Spinner.update в не-анимированном режиме печатает НОВУЮ строку, а не переписывает
         * текущую. Десять раз в секунду это две тысячи строк «✳ Reasoning…» в журнале за минуту
         * работы — и настоящий вывод в нём уже не найти.
         */
        if (spinner.animated === false) return
        spinner.update?.(reasoningLine({
          elapsedMs: Date.now() - turnStartedAt,
          temperature: options.temperature ?? null,
        }))
      }, 100)
      // unref: висящий таймер держит процесс живым, и CLI, закончивший работу, не выходит —
      // человек видит зависший терминал вместо приглашения. Эта беда здесь уже случалась.
      thinkingTimer.unref?.()
    },

    onEvent(event) {
      if (event.type === 'text') {
        if (!textFlowing) {
          /*
           * СТРОКУ РАЗМЫШЛЕНИЯ НАДО ПОГАСИТЬ ПЕРЕД ПЕРВЫМ ТЕКСТОМ.
           *
           * Раньше здесь ничего не гасилось, и это было верно: спиннер жил только во время вызова
           * инструмента, а его закрывал tool_end. Теперь спиннер заводится в начале хода — и без
           * этой строки он продолжает переписывать ту же строку терминала, по которой уже течёт
           * ответ модели. На экране получается каша из ответа и «✳ Reasoning…» поверх него.
           */
          takeLine()
          showThought()
          // Бейдж отделяет голос агента от реплики человека: без него ответ начинался голым текстом
          // вплотную к вводу, и в длинной ленте два голоса читались как один.
          if (!badgeShown && turnRole) { write(`${agentBadge(turnRole)}\n`); badgeShown = true }
        }
        write(event.delta)
        textFlowing = true
        return
      }

      if (event.type === 'tool_start') {
        // Только закрываем текст: очищать строку незачем — её тут же займёт бегущая строка спиннера,
        // а лишняя очистка добавляет в вывод управляющую последовательность без единого следствия.
        silenceSpinner()
        if (spinner) { spinner.silence(); spinner = null }
        if (textFlowing) { write('\n'); textFlowing = false }
        showThought()
        pendingArgs.set(`${event.step}:${event.name}`, event.args)
        // Спиннер транзитный: его строка исчезнет, а на её месте встанет бейдж с итогом.
        spinner = makeSpinner(runningLabel(event.name, event.args))
        return
      }

      if (event.type === 'tool_end') {
        if (spinner) { spinner.silence(); spinner = null }
        silenceSpinner()
        write(CLEAR_LINE)
        const badge = {
          name: event.name,
          args: pendingArgs.get(`${event.step}:${event.name}`) ?? {},
          ok: event.outcome.ok,
          result: event.outcome.result,
          error: event.outcome.ok ? undefined : `${event.outcome.code}: ${event.outcome.error}`,
          durationMs: event.outcome.durationMs,
        }
        calls.push(badge)
        write(`${toolBadge(badge)}\n`)
        return
      }

      if (event.type === 'error') {
        takeLine()
        write(`${c.red('  ✖ ')}${event.message}\n`)
      }
    },

    /**
     * Конец хода: закрыть строку текста и, если вызовов было много, подвести итог одной строкой.
     *
     * Сводка на двух вызовах дублировала бы то, что человек уже прочитал двумя строками выше, — она
     * появляется от трёх, где список начинает просить, чтобы его свернули.
     */
    finishTurn() {
      if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null }
      if (spinner) { spinner.silence(); spinner = null }
      if (textFlowing) { write('\n'); textFlowing = false }
      const summary = groupSummary(calls)
      if (summary) write(`${summary}\n`)
      calls = []
    },
  }
}

export { LABELS, GROUP_THRESHOLD, visibleWidth }
