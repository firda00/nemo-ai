// Выгрузка лидов в файл и питча в буфер обмена.
//
// Смысл — забрать результат прогона туда, где с ним работают: в таблицу, в CRM, в сообщение клиенту.
// Без этого «горячих 3» на экране приходится переписывать руками, а переписанный руками телефон
// однажды окажется набран не туда.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Одна ячейка CSV.
 *
 * Кавычки удваиваются, а не экранируются обратным слешем: так требует RFC 4180, и именно так их
 * ждёт Excel — единственная программа, в которой этот файл откроют. Перевод строки внутри поля
 * (он бывает в питче) обязывает взять ячейку в кавычки, иначе одна строка превратится в две.
 */
export function csvCell(value) {
  const text = value == null ? '' : String(value)
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const COLUMNS = [
  ['name', (lead) => lead.name],
  ['city', (lead) => lead.city],
  ['status', (lead) => lead.score?.status ?? ''],
  ['score', (lead) => lead.score?.score ?? ''],
  ['phone', (lead) => lead.phone ?? ''],
  ['website', (lead) => lead.website ?? ''],
  ['email', (lead) => (lead.enrichment?.emails ?? []).join(' ')],
  ['telegram', (lead) => lead.enrichment?.socials?.telegram ?? ''],
  ['instagram', (lead) => lead.enrichment?.socials?.instagram ?? ''],
  ['decision_maker', (lead) => lead.score?.key_decision_maker ?? ''],
  ['reason', (lead) => lead.score?.reason ?? ''],
  ['icebreaker', (lead) => lead.score?.icebreaker_pitch ?? ''],
  ['address', (lead) => lead.address ?? ''],
  ['rating', (lead) => lead.rating ?? ''],
  ['reviews', (lead) => lead.reviews ?? ''],
]

export function toCsv(leads) {
  const rows = [COLUMNS.map(([header]) => header).join(',')]
  for (const lead of leads ?? []) rows.push(COLUMNS.map(([, pick]) => csvCell(pick(lead))).join(','))
  // BOM в начале: без него Excel на Windows читает UTF-8 как ANSI, и весь русский текст
  // превращается в вопросительные знаки ещё до того, как владелец успеет что-то заподозрить.
  return `﻿${rows.join('\r\n')}\r\n`
}

export function toJson(leads) {
  return `${JSON.stringify(leads ?? [], null, 2)}\n`
}

/** Имя файла с отметкой времени: второй прогон не должен затирать первый. */
export function exportFileName(format, at = new Date()) {
  const stamp = at.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `sdr-leads-${stamp}.${format}`
}

export function writeExport(leads, format, directory = process.cwd(), at = new Date()) {
  const name = exportFileName(format, at)
  const full = path.join(directory, name)
  fs.writeFileSync(full, format === 'csv' ? toCsv(leads) : toJson(leads), 'utf8')
  return full
}

/**
 * Команда копирования для этой системы.
 *
 * Своей у Node нет, поэтому берём системную. Список короткий и проверяемый: на Windows clip есть
 * всегда, на macOS pbcopy тоже, а на Linux — только если кто-то поставил xclip, и это надо честно
 * пережить, а не считать поломкой.
 */
export function clipboardCommand(platform = process.platform) {
  if (platform === 'win32') return { command: 'clip', args: [] }
  if (platform === 'darwin') return { command: 'pbcopy', args: [] }
  return { command: 'xclip', args: ['-selection', 'clipboard'] }
}

/**
 * Копирует текст в буфер. Возвращает признак успеха, а НЕ бросает.
 *
 * Отсутствие xclip — не повод рушить интерактивный сеанс: вызывающий покажет текст для копирования
 * руками, и человек всё равно получит то, за чем пришёл.
 */
export function copyToClipboard(text) {
  const { command, args } = clipboardCommand()
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] })
    } catch {
      resolve({ ok: false, error: `${command} недоступен` })
      return
    }
    child.on('error', () => resolve({ ok: false, error: `${command} недоступен` }))
    child.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: `${command} вернул ${code}` }))
    child.stdin.on('error', () => {})
    child.stdin.end(text)
  })
}
