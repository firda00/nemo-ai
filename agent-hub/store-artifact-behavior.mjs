import assert from 'node:assert/strict'
import { isStoreSnapshotIntent } from '../src/lib/storeArtifactIntent.ts'
import { readFileSync } from 'node:fs'

for (const query of [
  'как обстоят дела с магазином',
  'покажи мне дашборд продаж',
  'дай краткую сводку по остаткам',
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

const root = new URL('../', import.meta.url)
const artifact = readFileSync(new URL('src/components/platform/StoreSnapshotArtifact.tsx', root), 'utf8')
const commerce = readFileSync(new URL('supabase/functions/commerce-control/index.ts', root), 'utf8')
assert.match(artifact, /24 \* 60 \* 60 \* 1000/, 'open dashboards refresh their source snapshot every 24 hours')
assert.match(artifact, /catalogs\.slice\(0, 12\)/, 'the dashboard must aggregate connected stores, not silently show only the first')
assert.match(artifact, /action: 'save_snapshot_run'/, 'fast dashboards must remain in durable team history')
assert.match(commerce, /kind: 'store_snapshot'/)
assert.match(commerce, /eq\('account_id', profile\.account_id\)/, 'snapshot history must remain tenant scoped')
