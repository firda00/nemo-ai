// Поиск секретов в том, что вот-вот уедет в репозиторий.
//
// Утечка ключа — не такая ошибка, которую можно исправить следующим коммитом. История git не
// забывает: удалённый файл остаётся в объектах, доступен по хешу и попадает в каждый клон. Ключ,
// однажды попавший в открытый репозиторий, считается скомпрометированным навсегда, и починка — это
// не `git rm`, а перевыпуск ключа и переписывание всей ветки.
//
// Поэтому проверка стоит ДО коммита, а не в обзоре кода.

import { execSync } from 'node:child_process'
import fs from 'node:fs'

/**
 * Признаки секретов. Каждый — по ФОРМЕ значения, а не по имени переменной.
 *
 * Имя обманывает: ключ кладут в `const x = 'sk-...'` и в комментарий «пример». Форма — нет:
 * приватный ключ выглядит как приватный ключ, где бы он ни лежал.
 */
const RULES = [
  { name: 'закрытый ключ (PEM)', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'ключ OpenRouter', re: /\bsk-or-v1-[A-Za-z0-9]{32,}/ },
  { name: 'ключ OpenAI', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'токен GitHub', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'ключ Anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{24,}/ },
  { name: 'сервисный ключ Supabase', re: /\bsb_secret_[A-Za-z0-9_-]{20,}/ },
  { name: 'служебный JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'токен Telegram-бота', re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { name: 'ключ AWS', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'пароль в строке подключения', re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]{4,}@/ },
  // Пароль, записанный рядом со словом «пароль», — самый частый вид утечки в документации.
  { name: 'пароль в документации', re: /(?:^|\s)(?:пароль|password|passwd|пароль\s+ssh)\s*[:=]\s*\S{6,}/i },
]

/** Что проверять бессмысленно: там секретов нет, а совпадений по форме много. */
const SKIP = [
  /^package-lock\.json$/,
  /^deno\.lock$/,
  // Два файла, где образцы секретов лежат ПО НАЗНАЧЕНИЮ: список признаков и тест на него. Оба
  // исключены поимённо, а не по маске «тесты» — иначе под исключение попал бы любой файл со
  // словом test в имени, и настоящий ключ, положенный в такой файл, проехал бы молча.
  /^agent-hub\/scan-secrets\.mjs$/,
  /^agent-hub\/secrets-scan-behavior\.mjs$/,
  /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|woff2?)$/i,
]

/** Файлы, помеченные к коммиту. Именно они уедут, а не то, что лежит рядом в рабочей папке. */
function stagedFiles() {
  const out = execSync('git diff --cached --name-only --diff-filter=ACMR', { encoding: 'utf8' })
  return out.split(/\r?\n/).filter(Boolean)
}

function scan(files) {
  const findings = []
  for (const file of files) {
    if (SKIP.some((one) => one.test(file))) continue
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    // Двоичное содержимое пропускаем: совпадение по форме там почти всегда случайно. Признак —
    // нулевой байт, записанный ESCAPE-ПОСЛЕДОВАТЕЛЬНОСТЬЮ. Записанный буквально, он делает
    // двоичным сам этот файл, а проверку — бессмысленной: первый прогон дал зелёный отчёт на
    // файле с настоящими доступами к серверу.
    if (text.includes('\0')) continue

    const lines = text.split(/\r?\n/)
    for (const rule of RULES) {
      for (const [index, line] of lines.entries()) {
        if (!rule.re.test(line)) continue
        // Значение НЕ печатается. Отчёт о найденном ключе, где напечатан сам ключ, — это второй
        // канал утечки: он уходит в консоль, в CI и в переписку.
        findings.push({ file, line: index + 1, rule: rule.name })
        break
      }
    }
  }
  return findings
}

const explicit = process.argv.slice(2).filter((one) => !one.startsWith('--'))
const files = explicit.length ? explicit : stagedFiles()
const findings = scan(files)

if (findings.length) {
  console.error('\nКоммит остановлен: похоже на секреты.\n')
  for (const one of findings) console.error(`  ${one.file}:${one.line} — ${one.rule}`)
  console.error('\nЗначения намеренно не показаны: отчёт с ключом внутри — это второй канал утечки.')
  console.error('Уберите секрет из файла или добавьте файл в .gitignore, затем `git restore --staged <файл>`.')
  console.error('Если это ложное срабатывание — скажите об этом в обзоре, а не отключайте проверку.\n')
  process.exit(1)
}

console.log(`[OK] Secrets scan: ${files.length} файлов, находок нет`)
