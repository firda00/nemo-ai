// Отрисовка агентного цикла в терминале: рамки вызова инструментов и потоковый текст.
//
// ОТДЕЛЬНО ОТ ТОЧКИ ВХОДА, потому что это чистые функции над событиями: их проверяют сравнением строк,
// а не запуском агента с настоящей моделью. Точка входа занимается подключениями и вводом.
//
// ГЛАВНОЕ ПРАВИЛО ФАЙЛА: рамка, которую открыли, обязана закрыться. Событие tool_start рисует верх
// рамки, tool_end — низ с итогом. Пропущенное закрытие оставляет на экране висящий короб, и человек
// не понимает, идёт работа или всё сломалось. Ровно это и случилось при первом прогоне, когда человек
// отказывался подтвердить действие.

import { c, visibleWidth } from './tui.mjs'

/** Ширина рамки. Уже стандартных 80 колонок: терминал бывает узким, а перенос ломает рамку. */
const BOX_WIDTH = 74

/** Обрезка по ВИДИМОЙ ширине: цвет не занимает места на экране, но занимает в строке. */
function fit(text, width) {
  const visible = visibleWidth(text)
  if (visible <= width) return text + ' '.repeat(width - visible)
  // Обрезаем по знакам, пока видимая ширина не уложится: срез по .length разрежет escape-последова-
  // тельность пополам и раскрасит весь остаток экрана.
  let cut = text
  while (visibleWidth(cut) > width - 1 && cut.length > 0) cut = cut.slice(0, -1)
  return `${cut}…`
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

/** Человеческие подписи частых полей. Незнакомое поле показывается своим именем — это не ошибка. */
const LABELS = {
  query: 'Ниша', city: 'Город', limit: 'Лимит', icp: 'Профиль клиента',
  url: 'Адрес', leadName: 'Лид', phone: 'Телефон', website: 'Сайт',
  score: 'Балл', format: 'Формат', filename: 'Файл', scenes: 'Сцены',
}

/** Верх рамки вызова. */
export function toolBoxTop(name, args) {
  const title = ` ⚙ Вызов инструмента: ${name} `
  const dashes = Math.max(0, BOX_WIDTH - visibleWidth(title))
  return [
    c.dim(`┌${title}${'─'.repeat(dashes)}┐`),
    `${c.dim('│')} ${fit(formatArgs(args), BOX_WIDTH - 2)} ${c.dim('│')}`,
  ].join('\n')
}

/**
 * Низ рамки с итогом.
 *
 * Итог показывается ВСЕГДА, включая отказ и отклонение человеком. Молча закрытая рамка выглядит как
 * успешный вызов, и человек узнаёт правду из следующего ответа модели — если она о нём скажет.
 */
export function toolBoxBottom(outcome) {
  const mark = outcome.ok ? c.green('✓') : c.red('×')
  const summary = outcome.ok ? summarize(outcome.result) : `${outcome.code}: ${outcome.error}`
  const line = `${mark} ${summary} ${c.dim(`(${outcome.durationMs} мс)`)}`
  return [
    `${c.dim('│')} ${fit(line, BOX_WIDTH - 2)} ${c.dim('│')}`,
    c.dim(`└${'─'.repeat(BOX_WIDTH)}┘`),
  ].join('\n')
}

/**
 * Короткое описание результата.
 *
 * Не JSON целиком: результат поиска — это сотня килобайт, и вывалить их в терминал значит стереть
 * весь предыдущий разговор прокруткой. Модель получает полный результат, человек — суть.
 */
export function summarize(result) {
  if (result === null || result === undefined) return 'готово'
  if (Array.isArray(result)) return `${result.length} записей`
  if (typeof result !== 'object') return String(result).slice(0, 60)

  const parts = []
  const record = result
  if (typeof record.found === 'number') parts.push(`найдено ${record.found}`)
  if (Array.isArray(record.leads)) parts.push(`лидов ${record.leads.length}`)
  if (typeof record.hot === 'number') parts.push(`горячих ${record.hot}`)
  if (typeof record.path === 'string') parts.push(record.path)
  if (typeof record.bytes === 'number') parts.push(`${record.bytes} байт`)
  if (typeof record.textLength === 'number') parts.push(`текста ${record.textLength}`)
  if (Array.isArray(record.messengers)) parts.push(`мессенджеров ${record.messengers.length}`)
  if (record.sent === true) parts.push('отправлено')
  if (record.synced === true) parts.push('выгружено')
  return parts.join(', ') || 'готово'
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
 * Состояние всего одно — «печатали ли мы текст последним»: перед рамкой инструмента нужен перевод
 * строки, но только если до этого шёл текст. Без этого рамка приклеивается к последнему слову ответа.
 */
export function createRenderer(write = (text) => process.stdout.write(text)) {
  let textFlowing = false
  return {
    onEvent(event) {
      if (event.type === 'text') {
        write(event.delta)
        textFlowing = true
        return
      }
      if (event.type === 'tool_start') {
        if (textFlowing) { write('\n') ; textFlowing = false }
        write(`\n${toolBoxTop(event.name, event.args)}\n`)
        return
      }
      if (event.type === 'tool_end') {
        write(`${toolBoxBottom(event.outcome)}\n`)
        return
      }
      if (event.type === 'error') {
        if (textFlowing) { write('\n'); textFlowing = false }
        write(`${c.red('  × ')}${event.message}\n`)
      }
    },
    /** Закрыть строку текста после ответа: без этого приглашение ввода приклеивается к последнему слову. */
    finishTurn() {
      if (textFlowing) { write('\n'); textFlowing = false }
    },
  }
}

export { BOX_WIDTH, LABELS }
