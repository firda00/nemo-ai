import assert from 'node:assert/strict'
import { isStoreSnapshotIntent } from '../src/lib/storeArtifactIntent.ts'
import { readFileSync } from 'node:fs'

for (const query of [
  'как обстоят дела с магазином',
  'покажи мне дашборд продаж',
  'сделай мне дашборд моего магазина',
  'построй дашборд продаж магазина',
  'дай краткую сводку по остаткам',
  'предоставь мне недельный отчет и что можно улучшить',
  'покажи недельные итоги продаж',
  'а другие магазины',
  'store health',
  "do'kon holatini ko'rsat",
]) assert.equal(isStoreSnapshotIntent(query), true, query)

for (const query of [
  'проведи полный аудит и составь план на 7 дней',
  'измени цену товара',
  'загрузи фотографии и отправь карточку на модерацию',
  'привет',
]) assert.equal(isStoreSnapshotIntent(query), false, query)

console.log('store artifact intent behavior passed')

const { isAnalyticalArtifactIntent } = await import('../src/lib/analyticalArtifactIntent.ts')
for (const query of [
  'предоставь недельный отчет и что можно улучшить',
  'покажи KPI маркетинга за месяц',
  'сделай dashboard по задачам команды',
]) assert.equal(isAnalyticalArtifactIntent(query), true, query)
for (const query of ['привет', 'напиши письмо клиенту']) assert.equal(isAnalyticalArtifactIntent(query), false, query)

const { isTeamQuickReplyIntent } = await import('../src/lib/teamQuickReplyIntent.ts')
for (const query of ['привет', 'кто вы', 'что ты умеешь', 'как это работает?', 'спасибо', 'сделай заголовок короче', 'дай 3 идеи']) {
  assert.equal(isTeamQuickReplyIntent(query), true, query)
}
for (const query of ['сделай дашборд магазина', 'проанализируй файл', 'найди последние цены в интернете', 'измени цену товара']) {
  assert.equal(isTeamQuickReplyIntent(query), false, query)
}

const root = new URL('../', import.meta.url)
const artifact = readFileSync(new URL('src/components/platform/StoreSnapshotArtifact.tsx', root), 'utf8')
const commerce = readFileSync(new URL('supabase/functions/commerce-control/index.ts', root), 'utf8')
const teamDetail = readFileSync(new URL('src/pages/app/TeamDetailPage.tsx', root), 'utf8')
assert.match(artifact, /24 \* 60 \* 60 \* 1000/, 'open dashboards refresh their source snapshot every 24 hours')
assert.match(artifact, /catalogs\.slice\(0, 12\)/, 'the dashboard must aggregate connected stores, not silently show only the first')
assert.match(artifact, /action: 'save_snapshot_run'/, 'fast dashboards must remain in durable team history')
assert.match(commerce, /kind: 'store_snapshot'/)
assert.match(commerce, /eq\('account_id', profile\.account_id\)/, 'snapshot history must remain tenant scoped')
assert.match(teamDetail, /functions\.invoke\('cli-chat'/, 'short conversational questions must use one direct model call')
assert.match(teamDetail, /isTeamQuickReplyIntent/, 'quick replies must fail closed through a deterministic classifier')
assert.doesNotMatch(teamDetail, /isMarketplaceWorkspace && isStoreSnapshotIntent\(task\)/, 'store dashboards must use the fast artifact from every team room')
assert.match(teamDetail, /quick_reply_timeout[\s\S]*20_000/, 'a quick reply must fail visibly instead of spinning for minutes')
