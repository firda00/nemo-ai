// Подхват локальных ключей перед запуском CLI-скриптов.
//
// ПОЧЕМУ НЕ `node --env-file` И НЕ dotenv. Встроенный разбор Node падает, если файла нет (нужен
// отдельный --env-file-if-exists), и не рассчитан на многострочное значение в кавычках — а в
// .secrets.local этого проекта лежит PEM-ключ расширения именно в таком виде. Тот же PEM уже один
// раз обрушил `. ./.secrets.local` в bash и высыпал обрывки приватного ключа в вывод команды.
// Тридцать строк своего разбора предсказуемее, чем обходить эти два ограничения, и не добавляют
// зависимости ради чтения текстового файла.
//
// ЗНАЧЕНИЯ НИКОГДА НЕ ПЕЧАТАЮТСЯ — ни в отладке, ни в ошибке. Наружу уходят только ИМЕНА
// переменных: этого достаточно, чтобы понять, что подхватилось, и нечего показывать через плечо.

import fs from 'node:fs'
import path from 'node:path'

/**
 * Порядок важен: сначала самый специфичный файл.
 *
 * Боевые ключи бэкенда живут в .secrets.local; .env.local в этом репозитории содержит только
 * VITE_-переменные фронтенда. Первый файл, задавший переменную, побеждает — как в dotenv.
 */
const FILES = ['.secrets.local', '.env.local', '.env']

/** Разбор одного файла в пары. Поддерживает многострочное значение в двойных кавычках. */
export function parseEnvFile(text) {
  const out = new Map()
  const lines = String(text ?? '').split(/\r?\n/)

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!line || /^\s*(#|$)/.test(line)) continue

    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    const [, key, rawStart] = match

    let value = rawStart
    // Значение в двойных кавычках может продолжаться на следующих строках — так записан PEM.
    if (value.startsWith('"') && !(value.length > 1 && value.endsWith('"'))) {
      const parts = [value.slice(1)]
      while (++index < lines.length) {
        const next = lines[index]
        if (next.endsWith('"')) { parts.push(next.slice(0, -1)); break }
        parts.push(next)
      }
      value = parts.join('\n')
    } else if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1)
      || (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    } else {
      // Без кавычек комментарий в конце строки значением не является.
      value = value.replace(/\s+#.*$/, '').trim()
    }

    out.set(key, value)
  }
  return out
}

/**
 * Загружает локальные файлы в process.env и возвращает ИМЕНА подхваченных переменных.
 *
 * Уже заданная переменная НЕ перезаписывается: явно переданное в командной строке или в CI всегда
 * важнее файла на диске — иначе `KEY=... npm run ...` молча игнорировался бы.
 */
export function loadLocalEnv(root = process.cwd(), env = process.env) {
  const loaded = []
  const filesSeen = []

  for (const file of FILES) {
    const full = path.join(root, file)
    if (!fs.existsSync(full)) continue
    filesSeen.push(file)
    let parsed
    try {
      parsed = parseEnvFile(fs.readFileSync(full, 'utf8'))
    } catch {
      // Нечитаемый файл — не повод не запускаться: часть ключей может прийти из окружения.
      continue
    }
    for (const [key, value] of parsed) {
      if (env[key] != null && env[key] !== '') continue
      env[key] = value
      loaded.push(key)
    }
  }

  return { files: filesSeen, loaded }
}
