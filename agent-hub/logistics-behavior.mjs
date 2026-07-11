import assert from 'node:assert/strict'
import { parseShipmentRows, strictDateOnly } from '../supabase/functions/_shared/logisticsInput.ts'

const csv = `order_id,customer,carrier,status,shipped_at,promised_date,last_event_at,owner
ORD-1,"Karimov, Aziz",Express24,shipped,2026-07-08,2026-07-11,2026-07-09 10:20,Dilshod
ORD-2,Madina,BTS,доставлен,2026-07-08,2026-07-10,2026-07-10T16:40:00+05:00,Akmal
ord-1,Duplicate,BTS,delayed,2026-07-01,2026-07-02,2026-07-03,Madina
ORD-3,Bekzod,Fargo,unknown,11/07/2026,2026-99-99,yesterday,Madina`

const parsed = parseShipmentRows(csv)
assert.equal(parsed.error, undefined)
assert.equal(parsed.rows.length, 3, 'duplicate order IDs must be ignored case-insensitively')
assert.equal(parsed.rows[0].customer, 'Karimov, Aziz', 'quoted delimiters must be preserved')
assert.equal(parsed.rows[0].status, 'shipped')
assert.equal(parsed.rows[0].last_event_at, '2026-07-09T05:20:00.000Z', 'timezone-less timestamps use explicit Asia/Tashkent offset')
assert.equal(parsed.rows[1].status, 'delivered', 'Russian status is normalized deterministically')
assert.equal(parsed.rows[2].shipped_at, null, 'ambiguous dates must not be accepted')
assert.equal(parsed.rows[2].promised_date, null, 'invalid ISO dates must not be accepted')
assert.equal(parsed.rows[2].last_event_at, null, 'relative dates must not be accepted')
assert.ok(parsed.warnings.some((warning) => /duplicate order_id ord-1/i.test(warning)), 'duplicate rows must be reported')
assert.ok(parsed.warnings.filter((warning) => /not valid ISO/.test(warning)).length >= 3, 'invalid dates must be reported')

const russian = parseShipmentRows(`заказ;клиент;перевозчик;статус;срок доставки;последнее событие;ответственный
RU-10;Азиза;BTS;задержан;2026-07-12;2026-07-10 09:00;Мадина`)
assert.equal(russian.rows.length, 1)
assert.equal(russian.rows[0].order_id, 'RU-10')
assert.equal(russian.rows[0].status, 'delayed')
assert.equal(russian.rows[0].promised_date, '2026-07-12')

const headerError = parseShipmentRows('customer,status\nAziza,shipped')
assert.equal(headerError.rows.length, 0)
assert.match(headerError.error ?? '', /order_id/)
assert.equal(strictDateOnly('2026-02-29'), null)
assert.equal(strictDateOnly('2028-02-29'), '2028-02-29')
const tooMany = parseShipmentRows(`order_id,status\n${Array.from({ length: 41 }, (_, i) => `BATCH-${i + 1},pending`).join('\n')}`)
assert.equal(tooMany.rows.length, 0)
assert.match(tooMany.error ?? '', /Maximum 40/)

console.log('Logistics parser behavior: 20/20 assertions passed.')
