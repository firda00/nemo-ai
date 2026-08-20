/*
 * Выпуск ключей anon и service_role для самостоятельного контура Supabase.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ. Эти «ключи» — не случайные строки, а JWT, подписанные тем же JWT_SECRET,
 * которым проверяет подписи GoTrue и PostgREST. Сгенерировать их `openssl rand` нельзя: PostgREST
 * читает из полезной нагрузки поле role и по нему выбирает роль в базе. Неверная нагрузка означает
 * не отказ в доступе, а доступ НЕ ТОТ — например, anon с правами service_role. Такое не заметно
 * ничем, кроме утечки.
 *
 * Запуск:
 *   node deploy/make-keys.mjs "<JWT_SECRET не короче 32 знаков>"
 *   node deploy/make-keys.mjs --secret-from-env      # возьмёт JWT_SECRET из окружения
 *
 * Печатает две строки для .env.server. Сам секрет НЕ печатается.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const b64url = (input) => Buffer.from(input).toString('base64url')

/** Подпись HS256 без зависимостей: заголовок и нагрузка — base64url, подпись — HMAC-SHA256. */
function signJwt(payload, secret) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  const mac = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${mac}`
}

const arg = process.argv[2]
const secret = arg === '--secret-from-env' ? (process.env.JWT_SECRET ?? '') : (arg ?? '')

if (!secret) {
  console.error('Укажите секрет: node deploy/make-keys.mjs "<JWT_SECRET>"')
  console.error(`Если секрета ещё нет, вот пригодный: ${randomBytes(32).toString('hex')}`)
  process.exit(1)
}
/*
 * Не короче 32 знаков — это требование самого GoTrue, а не осторожность. С коротким секретом он
 * поднимется и будет выпускать токены, которые подбираются перебором за часы.
 */
if (secret.length < 32) {
  console.error(`JWT_SECRET длиной ${secret.length}: нужно не меньше 32 знаков.`)
  process.exit(1)
}

// Десять лет: ключ проекта, а не сессия пользователя. Короткий срок означал бы, что фронтенд
// перестанет работать в тихий день без единой правки кода.
const iat = Math.floor(Date.parse('2026-01-01T00:00:00Z') / 1000)
const exp = iat + 10 * 365 * 24 * 60 * 60

const anon = signJwt({ role: 'anon', iss: 'supabase', iat, exp }, secret)
const service = signJwt({ role: 'service_role', iss: 'supabase', iat, exp }, secret)

// Самопроверка: подпись обязана сходиться, а роли — различаться. Дешевле, чем узнать об ошибке
// по тому, что анонимный запрос получил права служебного.
const verify = (token) => {
  const [head, body, mac] = token.split('.')
  const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  const a = Buffer.from(mac), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b) && JSON.parse(Buffer.from(body, 'base64url'))
}
const anonClaims = verify(anon)
const serviceClaims = verify(service)
if (!anonClaims || !serviceClaims || anonClaims.role !== 'anon' || serviceClaims.role !== 'service_role') {
  console.error('Самопроверка не прошла — ключи не выпущены.')
  process.exit(1)
}

console.log('# Вставьте в .env.server. Секрет здесь НЕ печатается — храните его отдельно.')
console.log(`ANON_KEY=${anon}`)
console.log(`SERVICE_ROLE_KEY=${service}`)
console.log()
console.log(`# роли: ${anonClaims.role} / ${serviceClaims.role}; действительны до ${new Date(exp * 1000).toISOString().slice(0, 10)}`)
console.log('# ANON_KEY публичен — он уезжает в браузер как VITE_SUPABASE_ANON_KEY.')
console.log('# SERVICE_ROLE_KEY обходит RLS целиком. В браузер он попасть не должен никогда.')
