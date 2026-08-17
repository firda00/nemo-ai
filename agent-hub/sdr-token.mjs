// Выдача и отзыв платформенных токенов Nemo.
//
//   npm run sdr:token -- --issue --account <uuid> --name "CLI ноутбук" [--actions sdr:trigger,sdr:read]
//                        [--rate 30] [--days 90]
//   npm run sdr:token -- --list --account <uuid>
//   npm run sdr:token -- --revoke <token-id>
//
// ТОКЕН ПОКАЗЫВАЕТСЯ РОВНО ОДИН РАЗ. В базу уходит только HMAC-отпечаток, и восстановить строку из
// него нельзя — это и есть смысл хранения отпечатка. Потерянный токен не «вспоминается», а
// отзывается и выдаётся заново.

import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { loadLocalEnv } from './load-local-env.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..')
loadLocalEnv(repoRoot)

const { generateToken, hashToken, SDR_ACTIONS } = await import('../supabase/functions/_shared/apiTokens.ts')

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const next = process.argv[index + 1]
  return next && !next.startsWith('--') ? next : true
}

const ref = process.env.SUPABASE_PROJECT_REF
const serviceKey = process.env.SUPABASE_SECRET_KEY
const pepper = process.env.NEMO_TOKEN_PEPPER
if (!ref || !serviceKey) {
  console.error('Нужны SUPABASE_PROJECT_REF и SUPABASE_SECRET_KEY (подхватываются из .secrets.local).')
  process.exit(1)
}
if (!pepper) {
  console.error(
    'Нужен NEMO_TOKEN_PEPPER — тот же секрет, что задан функции sdr-api.\n'
    + 'Без него отпечаток посчитается другим, и выданный токен шлюз не узнает.',
  )
  process.exit(1)
}
const admin = createClient(`https://${ref}.supabase.co`, serviceKey)

if (arg('issue')) {
  const accountId = arg('account')
  const name = arg('name')
  if (typeof accountId !== 'string' || typeof name !== 'string') {
    console.error('Нужны --account <uuid> и --name "<как называется>"')
    process.exit(1)
  }
  const actionsRaw = arg('actions')
  const actions = typeof actionsRaw === 'string'
    ? actionsRaw.split(',').map((one) => one.trim()).filter(Boolean)
    : [...SDR_ACTIONS]
  // Разрешать здесь что-то за пределами действий шлюза бессмысленно и опасно: шлюз о них не знает,
  // а в базе они выглядели бы как выданные права.
  const unknown = actions.filter((one) => !SDR_ACTIONS.includes(one))
  if (unknown.length) {
    console.error(`Неизвестные действия: ${unknown.join(', ')}. Доступны: ${SDR_ACTIONS.join(', ')}`)
    process.exit(1)
  }

  const days = Number(arg('days', '90'))
  const token = generateToken()
  const { data, error } = await admin.from('nemo_api_tokens').insert({
    account_id: accountId,
    token_hash: await hashToken(token, pepper),
    name,
    allowed_actions: actions,
    rate_limit_per_minute: Number(arg('rate', '30')),
    expires_at: Number.isFinite(days) && days > 0
      ? new Date(Date.now() + days * 86_400_000).toISOString()
      : null,
  }).select('id, expires_at').single()

  if (error) { console.error(`Не удалось создать токен: ${error.message}`); process.exit(1) }

  console.log('\nТокен создан. ПОКАЗЫВАЕТСЯ ОДИН РАЗ — сохраните сейчас:\n')
  console.log(`  ${token}\n`)
  console.log(`  id:        ${data.id}`)
  console.log(`  действия:  ${actions.join(', ')}`)
  console.log(`  истекает:  ${data.expires_at ?? 'без срока'}`)
  console.log('\nИспользование:  NEMO_API_KEY=<токен> npm run sdr:run -- --query "..." --city "..."\n')
  process.exit(0)
}

if (arg('list')) {
  const accountId = arg('account')
  if (typeof accountId !== 'string') { console.error('Нужен --account <uuid>'); process.exit(1) }
  const { data, error } = await admin.from('nemo_api_tokens')
    .select('id, name, allowed_actions, rate_limit_per_minute, is_active, created_at, expires_at, last_used_at')
    .eq('account_id', accountId).order('created_at', { ascending: false })
  if (error) { console.error(error.message); process.exit(1) }
  // Отпечаток не печатается: он бесполезен владельцу и полезен тому, кто заглянет через плечо.
  for (const row of data ?? []) {
    console.log(`${row.is_active ? '●' : '○'} ${row.id}  ${row.name}`)
    console.log(`   действия: ${(row.allowed_actions ?? []).join(', ') || '(нет — токен ничего не может)'}`)
    console.log(`   лимит: ${row.rate_limit_per_minute}/мин | истекает: ${row.expires_at ?? '—'} | использован: ${row.last_used_at ?? 'ни разу'}`)
  }
  if (!data?.length) console.log('Токенов нет.')
  process.exit(0)
}

const revokeId = arg('revoke')
if (typeof revokeId === 'string') {
  // Отзыв — это is_active = false, а не удаление строки: удалив, мы потеряли бы связь с задачами,
  // которые этот токен успел создать, — то есть именно тот след, который нужен после утечки.
  const { error } = await admin.from('nemo_api_tokens').update({ is_active: false }).eq('id', revokeId)
  if (error) { console.error(error.message); process.exit(1) }
  console.log(`Токен ${revokeId} отозван. Задачи, созданные им, остались в журнале.`)
  process.exit(0)
}

console.log(`Использование:
  npm run sdr:token -- --issue --account <uuid> --name "CLI ноутбук" [--actions ${SDR_ACTIONS.join(',')}] [--rate 30] [--days 90]
  npm run sdr:token -- --list --account <uuid>
  npm run sdr:token -- --revoke <token-id>`)
process.exit(1)
