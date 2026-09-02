import assert from 'node:assert/strict'
import { isStoreSnapshotIntent } from '../src/lib/storeArtifactIntent.ts'

for (const query of [
  'как обстоят дела с магазином',
  'покажи мне дашборд продаж',
  'дай краткую сводку по остаткам',
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
