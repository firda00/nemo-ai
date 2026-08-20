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
import { pathToFileURL } from 'node:url'

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

/**
 * Известные безопасные совпадения.
 *
 * СОВПАДЕНИЕ ПРОВЕРЯЕТСЯ ДОСЛОВНО, а не маской файла и не ослаблением правила. Файл целиком в SKIP
 * означал бы, что настоящий ключ, положенный в него завтра, проедет молча. Здесь же исключается ровно
 * одна строка ровно в одном файле: любая её правка снова включает проверку.
 *
 * КАЖДАЯ ЗАПИСЬ ОБЯЗАНА НАЗЫВАТЬ ПРИЧИНУ, и причина должна отвечать на вопрос «почему это не секрет»,
 * а не «почему это мешает». Список, куда добавляют «чтобы прошло», перестаёт быть защитой на второй
 * записи — поэтому проверка ниже требует непустого поля reason.
 */
/** Разделитель путей Windows. Собран из кода: обратная косая в литерале — источник ошибок. */
const SEPARATOR = String.fromCharCode(92)

export const KNOWN_SAFE = [
  {
    file: 'src/i18n/translations.ts',
    line: "password: 'Parol',",
    rule: 'пароль в документации',
    reason: 'подпись поля ввода в узбекском словаре интерфейса: «Parol» — это слово «пароль», а не пароль',
  },
  {
    file: 'src/i18n/translations.ts',
    line: "password: 'Пароль',",
    rule: 'пароль в документации',
    reason: 'подпись поля ввода в русском словаре интерфейса',
  },
  {
    file: 'src/i18n/translations.ts',
    line: "password: 'Password', passwordPlaceholder: '••••••••', invite: 'Invite code', invitePlaceholder: 'BETA-XXXX',",
    rule: 'пароль в документации',
    reason: 'подписи полей ввода в английском словаре интерфейса; заполнитель — точки, а не значение',
  },
]

/** Совпадает ли находка с известным безопасным случаем. Сравнение строки — по её содержимому. */
export function knownSafe(file, rule, line, list = KNOWN_SAFE) {
  const normalized = String(line ?? '').trim()
  return list.some((one) => {
    if (!one.reason?.trim()) return false
    // Пути от git приходят через прямую косую, а от аргументов командной строки на Windows — через
    // обратную. Без приведения исключение работало бы через раз, в зависимости от способа запуска.
    const normalizedFile = file.split(SEPARATOR).join('/')
    return one.file === normalizedFile && one.rule === rule && one.line === normalized
  })
}

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
        // Известный безопасный случай пропускается ЗДЕСЬ, после срабатывания правила: так в отчёте
        // видно, что правило работает, а исключение точечное.
        if (knownSafe(file, rule.name, line)) continue
        // Значение НЕ печатается. Отчёт о найденном ключе, где напечатан сам ключ, — это второй
        // канал утечки: он уходит в консоль, в CI и в переписку.
        findings.push({ file, line: index + 1, rule: rule.name })
        break
      }
    }
  }
  return findings
}

/*
 * Прогон только при ПРЯМОМ запуске.
 *
 * Без этого импорт функции из набора проверок запускал бы сканер по индексу git — и проверка
 * поведения превращалась бы в проверку текущего состояния репозитория.
 */
const directRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (!directRun) { /* импортировали ради функций — ничего не сканируем */ }
else {

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

}
