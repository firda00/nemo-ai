// Ловит ли сканер секретов настоящие секреты.
//
// Проверка, которая всегда отвечает «чисто», хуже отсутствующей: она даёт уверенность там, где её
// нет. Это не выдумка — первая версия сканера прошла файл с доступами и отчиталась зелёным, потому
// что в её собственный код попал настоящий нулевой байт, и всякий текст считался двоичным.
//
// Поэтому здесь проверяется не то, что сканер молчит на чистом коде, а то, что он КРИЧИТ на
// подделках. Все значения ниже — синтетические, сгенерированы для теста и никуда не ведут.

import assert from 'node:assert/strict'
import { KNOWN_SAFE, knownSafe } from './scan-secrets.mjs'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const scanner = path.join(root, 'agent-hub/scan-secrets.mjs')

/** Прогон сканера по одному временному файлу. Возвращает код выхода и текст отчёта. */
function scan(content, extension = '.md') {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-secrets-')), `sample${extension}`)
  fs.writeFileSync(file, content, 'utf8')
  try {
    execFileSync('node', [scanner, file], { encoding: 'utf8', stdio: 'pipe' })
    return { caught: false, report: '' }
  } catch (error) {
    return { caught: true, report: String(error.stderr ?? '') }
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  }
}

// --- Формы, которые обязаны ловиться ------------------------------------------------------------
// Значения синтетические: правильной формы, но не действующие.

const SAMPLES = [
  ['закрытый ключ', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----'],
  ['ключ OpenRouter', 'const key = "sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef"'],
  ['токен GitHub', 'GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyzAB'],
  ['ключ Anthropic', 'ANTHROPIC=sk-ant-0123456789abcdefghijklmnop'],
  ['служебный ключ Supabase', 'SUPABASE_SECRET_KEY=sb_secret_0123456789abcdefghij'],
  ['ключ AWS', 'aws_access_key_id = AKIA0123456789ABCDEF'],
  ['строка подключения с паролем', 'DATABASE_URL=postgresql://admin:hunter2secret@db.example.com:5432/app'],
  ['пароль в документации', 'Пароль: kX9-mn21-Qw77'],
  ['password in docs', 'password = correcthorsebattery'],
]

for (const [name, content] of SAMPLES) {
  const result = scan(content)
  assert.equal(result.caught, true, `не пойман: ${name}`)
  assert.ok(result.report.includes('Коммит остановлен'), `отчёт без объяснения: ${name}`)
}

// --- Значение НЕ печатается ------------------------------------------------------------------------
// Отчёт о найденном ключе, где напечатан сам ключ, — это второй канал утечки: он уходит в консоль,
// в журнал сборки и в переписку с поддержкой.

const leaky = scan('GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyzAB')
assert.equal(leaky.report.includes('ghp_0123456789'), false, 'значение секрета в отчёте не печатается')
assert.ok(leaky.report.includes('токен GitHub'), 'но вид секрета назван')
assert.ok(/sample\.md:1/.test(leaky.report), 'и место указано файлом со строкой')

// --- Чистое проходит ----------------------------------------------------------------------------------
// Проверка, срабатывающая на обычном коде, будет отключена в первый же день, и вместе с ней уйдёт
// защита от настоящих утечек.

for (const [name, content] of [
  ['обычный код', 'const url = "https://example.com/api"\nconst limit = 50'],
  ['имя переменной без значения', 'const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")'],
  ['публичный ключ Supabase', 'VITE_SUPABASE_ANON_KEY=sb_publishable_QvdG3S1oMAgXWv53R2'],
  ['слово «пароль» в прозе', 'Пароль хранится в менеджере паролей и в репозиторий не попадает.'],
  ['инструкция про ключи', 'ssh-keygen -p -f ~/.ssh/nemo_deploy_ed25519'],
]) {
  assert.equal(scan(content).caught, false, `ложное срабатывание: ${name}`)
}


// --- Список известных безопасных совпадений -----------------------------------------------------
//
// Исключение существует потому, что в словаре интерфейса есть строка `password: 'Parol'` — подпись
// поля ввода, а не пароль. Опасность списка не в самом исключении, а в том, во что он превращается
// через полгода: «добавь сюда, чтобы прошло». Поэтому проверяется не только что исключение работает,
// но и что оно узкое и что правило под ним живо.

{
  // Проверяется ПОВЕДЕНИЕ функции, а не текст файла. Структурная проверка («в исходнике есть слово
  // reason») пропускала снятие самой проверки причины — это показал мутационный прогон.
  const RULE = 'пароль в документации'
  const FILE = 'src/i18n/translations.ts'
  const LINE = "password: 'Parol',"

  assert.equal(knownSafe(FILE, RULE, LINE), true, 'известное безопасное совпадение перестало распознаваться')

  // Исключается СТРОКА, а не файл: соседняя строка того же файла обязана ловиться.
  assert.equal(knownSafe(FILE, RULE, 'password: RealLeak12345'), false,
    'исключение распространилось на весь файл — настоящий ключ в нём проедет молча')
  // И не весь файл, и не любое правило: другое правило по той же строке не исключается.
  assert.equal(knownSafe(FILE, 'ключ OpenAI', LINE), false, 'исключение сняло чужое правило')
  // И не любой файл: та же строка в другом файле не исключается.
  assert.equal(knownSafe('src/other.ts', RULE, LINE), false, 'исключение распространилось на чужой файл')

  // Запись БЕЗ ПРИЧИНЫ не действует. Список, куда добавляют «чтобы прошло», перестаёт быть защитой.
  const noReason = [{ file: FILE, rule: RULE, line: LINE, reason: '   ' }]
  assert.equal(knownSafe(FILE, RULE, LINE, noReason), false, 'запись без причины сработала как исключение')
  const withReason = [{ file: FILE, rule: RULE, line: LINE, reason: 'подпись поля' }]
  assert.equal(knownSafe(FILE, RULE, LINE, withReason), true)

  // Каждая запись в настоящем списке названа причиной.
  for (const entry of KNOWN_SAFE) {
    assert.ok(entry.reason?.trim().length > 10, `запись ${entry.file} без внятной причины`)
    assert.ok(entry.line?.trim().length > 0, `запись ${entry.file} без точной строки`)
  }

  // Словарь не в общем списке пропуска: там исключается файл целиком.
  const scanner = fs.readFileSync(path.join(root, 'agent-hub/scan-secrets.mjs'), 'utf8')
  const skipBlock = scanner.split('const SKIP = [')[1]?.split(']')[0] ?? ''
  assert.equal(skipBlock.includes('i18n'), false, 'словарь попал в общий список пропуска')
}
// Правило под исключением ЖИВО: настоящий пароль рядом со словом «password» по-прежнему ловится.
assert.equal(scan('password: SuperSecret123').caught, true, 'исключение погасило всё правило целиком')
assert.equal(scan('пароль: Xk9mQ2zPlmn').caught, true)
// И даже в том же самом файле: исключена одна строка, а не файл.
assert.equal(
  scan(["password: 'Parol',", 'password: RealLeak12345'].join('\n'), '.ts').caught,
  true,
  'соседняя строка в том же файле проехала вместе с исключением',
)

console.log('[OK] Secrets scan behaviour: пройдено')
