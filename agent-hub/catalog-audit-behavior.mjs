import assert from 'node:assert/strict'
import { catalogAudit, catalogAuditBlock, catalogAuditOwnerReport, catalogueOwnerReport } from '../supabase/functions/_shared/catalogAudit.ts'

const audit = catalogAudit([
  { sku: 'OUT', name: 'Хит', price: 100, stock: 0, units: 9 },
  { sku: 'FIX', name: 'Медленный товар', price: 200, stock: 6, units: 0 },
  { sku: 'KEEP', name: 'Стабильный товар', price: 300, stock: 8, units: 3 },
  { sku: 'UNKNOWN', name: 'Без сопоставления', price: 400, stock: 4, units: null },
])

assert.deepEqual(audit.map((item) => item.class), ['scale', 'fix', 'keep', 'insufficient_data'])
assert.match(audit[1].recommendation, /не менять карточку без подтверждения владельца/)
assert.match(audit[3].recommendation, /Не делать вывод, что товар не продаётся/)
const block = catalogAuditBlock(audit, 7)
assert.match(block, /АУДИТ АССОРТИМЕНТА UZUM: 7 ДНЕЙ/)
assert.match(block, /\[fix\] Медленный товар/)
assert.match(block, /не придумывай материал, размер, сертификаты/i)

const ownerReport = catalogAuditOwnerReport(audit, 7)
assert.match(ownerReport, /Проверить карточки: 1/)
assert.match(ownerReport, /остаток 6/, 'the owner report must preserve the actual positive stock')
assert.match(ownerReport, /Отзывы и комментарии текущий доступ Uzum API не возвращает/)
const catalogue = catalogueOwnerReport(audit, 7)
assert.match(catalogue, /Каталог Uzum: получено 4 позиций/)
assert.match(catalogue, /SKU FIX/)

console.log('Catalog audit behavior passed: classifications are evidence-based and listing edits remain approval-gated.')
