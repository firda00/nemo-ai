/*
 * Проверка DNS домена против того, чего ждёт Vercel.
 *
 * ЗАЧЕМ. Между «домен куплен» и «сайт открывается» лежит шаг, на котором ошибаются чаще всего:
 * записи прописаны, но не те, или не там, или ещё не разошлись. Снаружи это выглядит одинаково —
 * сайт не открывается, — а причины разные и лечатся по-разному. Панель Vercel показывает
 * «Invalid Configuration» без подробностей о том, что именно видит DNS прямо сейчас.
 *
 * Скрипт спрашивает DNS напрямую и говорит, что стоит и чего не хватает.
 *
 * Запуск:  node deploy/check-domain.mjs nemoai.uz
 */
import process from 'node:process'

/*
 * ЗАПРОСЫ ИДУТ ПО HTTPS, А НЕ ЧЕРЕЗ node:dns. ЭТО НЕ ПРИЧУДА.
 *
 * dns.resolve* открывает соединение на 53-й порт напрямую, и в закрытых сетях — корпоративных,
 * контейнерных, у части провайдеров — он отклоняется. Отказ выглядит как ОТСУТСТВИЕ ЗАПИСЕЙ:
 * функция бросает исключение, скрипт пишет «домен не делегирован» и уверенно врёт.
 *
 * Поймано контрольным прогоном: первая редакция этого скрипта объявила vercel.com
 * незарегистрированным. Без такой проверки скрипт всегда отвечал бы одинаково — и выглядел бы
 * работающим ровно до того дня, когда его ответу поверят.
 *
 * DNS-over-HTTPS идёт по 443 и отвечает одинаково отовсюду, откуда вообще есть интернет.
 */
const DOH = 'https://cloudflare-dns.com/dns-query'

async function query(name, type) {
  const control = new AbortController()
  const timer = setTimeout(() => control.abort(), 10_000)
  try {
    const r = await fetch(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { accept: 'application/dns-json' }, signal: control.signal,
    })
    if (!r.ok) return { error: `DoH ответил ${r.status}` }
    const body = await r.json()
    // Status 0 — успех, 3 — NXDOMAIN (имени нет). Остальное — не ответ, и выдавать его за
    // «записей нет» нельзя: это разные вещи.
    if (body.Status === 3) return { values: [], nxdomain: true }
    if (body.Status !== 0) return { error: `DNS вернул статус ${body.Status}` }
    return { values: (body.Answer ?? []).filter((a) => a.type !== 5 || type === 'CNAME').map((a) => String(a.data).replace(/\.$/, '')) }
  } catch (error) {
    return { error: String(error.message).slice(0, 60) }
  } finally { clearTimeout(timer) }
}

const dns = {
  resolve: async (name, type) => {
    const r = await query(name, type)
    if (r.error) throw new Error(r.error)
    return r.values
  },
}

// Адреса Vercel для апексного домена. В зоне .uz CNAME на апексе обычно не поддерживается —
// стандарт этого не позволяет, — поэтому корень настраивается A-записями, а www отдельным CNAME.
const APEX_IPS = ['216.198.79.1', '64.29.17.1', '76.76.21.21']
const WWW_CNAME = /vercel-dns/i

const domain = process.argv[2] ?? 'nemoai.uz'
const apex = domain.replace(/^www\./, '')

/*
 * Отказ СПРАШИВАНИЯ и отсутствие ЗАПИСИ — разные исходы, и молча сводить их к пустому списку
 * нельзя: именно так первая редакция и объявляла живые домены мёртвыми.
 */
let unreachable = false
const ask = async (name, type) => {
  const r = await query(name, type)
  if (r.error) { unreachable = true; console.log(`  ${type.padEnd(6)}  не удалось спросить: ${r.error}`); return [] }
  return r.values
}

console.log(`Проверка ${apex}\n`)

const ns = await ask(apex, 'NS')
if (unreachable) {
  console.log('\n  DNS опросить не удалось. Это НЕ значит, что домен не настроен — значит, что')
  console.log('  проверка не состоялась. Повторите при рабочей сети.')
  process.exit(2)
}
if (!ns.length) {
  console.log('  NS      — НЕТ ДЕЛЕГИРОВАНИЯ')
  console.log()
  console.log('  Домен не отвечает ни одной записью. Обычно это значит одно из двух:')
  console.log('    — он ещё не зарегистрирован;')
  console.log('    — зарегистрирован, но серверы имён у регистратора не прописаны.')
  console.log()
  console.log('  Пока делегирования нет, ЛЮБЫЕ записи ниже настроить невозможно: их некому отдавать.')
  process.exit(1)
}
console.log(`  NS      ${ns.join(', ')}`)

const a = await ask(apex, 'A')
const apexOk = a.length > 0 && a.some((ip) => APEX_IPS.includes(ip))
console.log(`  A ${apex.padEnd(20)} ${a.length ? a.join(', ') : '—'} ${apexOk ? '✓' : '✗'}`)

const wwwCname = await ask(`www.${apex}`, 'CNAME')
const wwwA = await ask(`www.${apex}`, 'A')
const wwwOk = wwwCname.some((v) => WWW_CNAME.test(v)) || wwwA.some((ip) => APEX_IPS.includes(ip))
console.log(`  www ${('.' + apex).padEnd(18)} ${wwwCname.join(', ') || wwwA.join(', ') || '—'} ${wwwOk ? '✓' : '✗'}`)

// Живая проверка: записи могут быть верными, а сертификат ещё не выпущенным.
const reach = async (url) => {
  const control = new AbortController()
  const timer = setTimeout(() => control.abort(), 10_000)
  try {
    const r = await fetch(url, { redirect: 'manual', signal: control.signal })
    const body = await r.text().catch(() => '')
    const title = (body.match(/<title>([^<]*)<\/title>/i) ?? [])[1] ?? ''
    return `${r.status}${title ? ` | ${title.slice(0, 50)}` : ''}`
  } catch (error) { return `нет ответа (${String(error.message).slice(0, 40)})` } finally { clearTimeout(timer) }
}
console.log()
console.log(`  https://${apex}/`.padEnd(34), await reach(`https://${apex}/`))
console.log(`  https://www.${apex}/`.padEnd(34), await reach(`https://www.${apex}/`))

if (apexOk && wwwOk) {
  console.log('\nЗаписи на месте. Сертификат Vercel выпускает сам; если сайт ещё не открывается —')
  console.log('подождите распространения DNS (до часа) и проверьте снова.')
  process.exit(0)
}

console.log('\nЧего не хватает — добавьте у регистратора:')
if (!apexOk) console.log(`  ${apex.padEnd(22)} A      ${APEX_IPS.slice(0, 2).join('  и  ')}`)
if (!wwwOk) console.log(`  www.${apex.padEnd(18)} CNAME  cname.vercel-dns.com.`)
process.exit(1)
