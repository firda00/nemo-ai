/*
 * Ввод в терминале, в том числе БЕЗ ЭХА — для пароля.
 *
 * readline здесь не годится: он печатает всё, что набирают. Пароль, оставшийся на экране, увидит
 * сосед, камера в переговорной и запись демонстрации экрана — и он же уедет в буфер прокрутки
 * терминала, откуда его достанут через час.
 *
 * Поэтому для пароля терминал переводится в «сырой» режим: знаки читаются по одному, на экран
 * ничего не выводится. Возврат режима обратно стоит в finally — без него терминал остаётся
 * молчащим после Ctrl+C, и человек чинит это перезапуском окна.
 */
import type { Interface } from 'node:readline'
import readline from 'node:readline'

export interface Tty {
  input: NodeJS.ReadStream
  output: NodeJS.WriteStream
}

/** Обычный вопрос с эхом. */
export function ask(tty: Tty, question: string): Promise<string> {
  const rl: Interface = readline.createInterface({ input: tty.input, output: tty.output })
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()) })
  })
}

/**
 * Вопрос БЕЗ эха.
 *
 * Возвращает набранное. Пустой ответ — законный: вызывающий сам решает, переспрашивать ли.
 */
export function askHidden(tty: Tty, question: string): Promise<string> {
  const { input, output } = tty
  if (!input.isTTY) {
    // Не терминал (конвейер, CI): сырого режима нет. Читаем строку как есть и ПРЕДУПРЕЖДАЕМ —
    // молчаливое чтение пароля из конвейера выглядит как работающая защита, которой нет.
    output.write(`${question}`)
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input, output })
      rl.question('', (answer) => { rl.close(); resolve(answer.trim()) })
    })
  }

  return new Promise((resolve, reject) => {
    output.write(question)
    const wasRaw = input.isRaw === true
    let value = ''
    const done = (finish: () => void) => {
      input.removeListener('data', onData)
      try { input.setRawMode(wasRaw) } catch { /* поток мог закрыться */ }
      input.pause()
      output.write('\n')
      finish()
    }
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) return done(() => reject(new Error('ввод прерван')))          // Ctrl+C
        if (byte === 13 || byte === 10) return done(() => resolve(value.trim()))      // Enter
        if (byte === 127 || byte === 8) { value = value.slice(0, -1); continue }      // Backspace
        if (byte < 32) continue                                                       // прочие управляющие
        value += String.fromCharCode(byte)
      }
    }
    try { input.setRawMode(true) } catch { /* нет прав на режим — читаем как есть */ }
    input.resume()
    input.on('data', onData)
  })
}
