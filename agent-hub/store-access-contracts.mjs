// Live store access for autonomous teams (e-commerce stage 1).
//
// Before this, `orchestrate` imported no tool executor at all. A team asked "how is my shop doing"
// produced four specialists planning how to obtain data, a peer review of those plans, and a
// checklist — while the account's Uzum key sat connected. These contracts pin the parts that made
// the difference, and the honesty rules that keep the fix from becoming a new source of invented
// numbers.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const uzum = read('supabase/functions/_shared/uzum.ts')
const snapshot = read('supabase/functions/_shared/marketplaceSnapshot.ts')
const orchestrate = read('supabase/functions/orchestrate/index.ts')
const runner = read('src/components/platform/AutonomousRunner.tsx')

// ---- the executor must return data, not a sentence -------------------------------------------
assert.match(uzum, /export async function uzumShopList/, 'the shop list must be available as structured rows')
assert.match(uzum, /export async function uzumProductRows/, 'products must be available as structured rows')
assert.match(uzum, /id: String\(pick\(shop, \['id', 'shopId', 'shop_id'\]\)/,
  'the shop id is what uzum_products requires next — it must be extracted, not dropped')
assert.match(uzum, /\(ID \$\{s\.shop\.id\}\)/, 'the chat tool must surface the id so the two-step chain can complete')
assert.match(uzum, /const PRICE_KEYS = \[/, 'price must be resolved through candidate keys')
assert.match(uzum, /const STOCK_KEYS = \[/, 'stock must be resolved through candidate keys')
assert.match(uzum, /\['shops', 'productList', 'orders', 'orderItems', 'products', 'rows', 'list'\]/,
  'current Uzum AllProducts.productList and FinanceOrderItemsDto.orderItems containers must be parsed')
assert.match(uzum, /Array\.isArray\(product\?\.skuList\)/,
  'current Uzum product cards must be flattened into their sellable SKU rows')
assert.match(uzum, /\['sellerItemCode', 'article', 'skuId', 'skuTitle', 'barcode'\]/,
  'SKU identity must use fields documented on SkuForTable')
// A field the API did not return must be reported, never defaulted to zero.
assert.match(uzum, /if \(rows\.length && rows\.every\(\(row\) => row\.price == null\)\) missing\.push/)
assert.match(uzum, /if \(rows\.length && rows\.every\(\(row\) => row\.stock == null\)\) missing\.push/)
assert.doesNotMatch(uzum, /price:\s*num\([^)]*\)\s*\?\?\s*0/, 'an absent price must stay null, never become 0')
assert.doesNotMatch(uzum, /stock:\s*num\([^)]*\)\s*\?\?\s*0/, 'an absent stock must stay null, never become 0')

// ---- the snapshot must be honest about what it does not have ---------------------------------
assert.match(snapshot, /продажи за период/, 'sales are not available from the implemented endpoints and must be named')
assert.match(snapshot, /возвраты/)
assert.match(snapshot, /комиссии/)
assert.match(snapshot, /срок поставки/)
assert.match(snapshot, /Не оценивай отсутствующие величины/,
  'the team must be forbidden from estimating fields the API never returned')
assert.match(snapshot, /НЕ придумывай/, 'a failed fetch must forbid inventing the catalogue')
// A connected key that returns nothing is a distinct state from "no integration".
assert.match(snapshot, /Ключ принят, но магазинов не вернулось/)
assert.match(snapshot, /openSecret/, 'the token must come from encrypted storage, never plaintext')
assert.doesNotMatch(snapshot, /console\.log\(token|result: token/, 'the token must never be logged or returned')
assert.match(snapshot, /from\('browser_observations'\)/, 'saved Browser snapshots must be read only for their owning account')
assert.match(snapshot, /eq\('account_id', accountId\)/, 'Browser evidence must be tenant-scoped')
assert.match(snapshot, /не API и не разрешение на действие/, 'Browser snapshots must never be treated as authority to mutate a marketplace')

// ---- the team run must actually receive it ----------------------------------------------------
assert.match(orchestrate, /import \{ storeSnapshot/, 'orchestrate must import the store reader')
assert.match(orchestrate, /await storeSnapshot\(admin, accountId\)/)
assert.match(orchestrate, /store\.browserEvidence/, 'Browser evidence must satisfy the marketplace source preflight without claiming an API connection')
assert.match(orchestrate, /STORE_GOAL_RE\.test\(goalText\)/, 'an unrelated run must not pay for a store API call')
const evidenceCalls = [...orchestrate.matchAll(/marketplaceEvidence\(goal, artifacts, store\.block\)/g)]
assert.equal(evidenceCalls.length, 3, 'step, review and synth must all see the same store facts')
assert.match(orchestrate, /function marketplaceEvidence\(goal: string, artifacts: InputArtifact\[\], storeBlock = ''\)/)

// ---- the screen must stop demanding a file the owner does not need ----------------------------
assert.match(runner, /!storeConnected && marketplaceInputMissing\(/,
  'the upload warning must not fire when the store is connected')
assert.match(runner, /\['uzum', 'wildberries', 'ozon'\]\.includes\(provider\)/)

// ---- sales (stage 2) -------------------------------------------------------------------------
// Endpoint and field names come from Uzum's published OpenAPI (GET /v1/finance/orders ->
// orderItems[].{productId,skuTitle,productTitle,amount,amountReturns,cancelled}), not guesswork.
assert.match(uzum, /export async function uzumSalesRows/, 'sales must be readable')
assert.match(uzum, /\/v1\/finance\/orders\?/, 'the whole-store finance sales endpoint must be used')
assert.match(uzum, /dateFrom=\$\{from\}&dateTo=\$\{to\}/, 'sales must be bounded by an explicit window')
assert.match(uzum, /pick\(item, \['amount'\]\)/, 'units come from the documented amount field')
assert.match(uzum, /pick\(item, \['amountReturns'\]\)/, 'returns must be removed from sales units')
assert.match(uzum, /pick\(item, \['cancelled'\]\)/, 'cancelled units must be removed from sales units')
assert.match(uzum, /Math\.max\(0, amount - returned - cancelled\)/, 'net units must never count returns or cancellations as sales')
assert.match(uzum, /size=50/, 'finance sales must use a bounded page size')
assert.match(uzum, /batch\.length < 50/, 'pagination must use the same bounded page size')
// Finance item price semantics are not per-unit/line documented, so per-SKU revenue must not exist.
assert.doesNotMatch(uzum, /revenueBySku|unitRevenue/, 'per-SKU revenue must not be invented from an ambiguous field')
assert.match(uzum, /revenue: null/, 'ambiguous revenue must stay unavailable, never be invented')

// The live table must flow through the same verifier that checks an uploaded file.
assert.match(snapshot, /marketplaceEvidenceBlock\(table\)/, 'live rows must be server-calculated, not model-computed')
assert.match(snapshot, /'sku,sales_7d,stock,price'/, 'the canonical header must match the 7-day window actually queried')
assert.match(snapshot, /uzumSalesRows\(token, entry\.shop\.id, 7\)/, 'every readable shop must use the same seven-day sales window')
assert.match(snapshot, /catalogAuditBlock\(priced, 7\)/, 'the server must classify listing-improvement candidates from live facts')
assert.match(snapshot, /Promise\.all\(open\.map/, 'multi-shop analysis must read the order feed for every accessible shop')
assert.match(snapshot, /row\.units != null && row\.stock != null/, 'a row missing either side must not enter the calculation')
assert.match(snapshot, /Пустая клетка означает «неизвестно», а не ноль/, 'blank must never read as zero')
assert.match(snapshot, /себестоимость/, 'cost is still unavailable and must be named')
assert.match(snapshot, /без себестоимости и комиссий прибыль посчитать нельзя/,
  'the team must be told profit cannot be derived, not left to improvise it')

// ---- multi-shop access (a seller with 4 shops who granted the key 2) ------------------------
// Uzum's OpenAPI marks `size` and `page` REQUIRED on GET /v1/product/shop/{shopId}. Omitting them
// returned HTTP 400 for every shop, which the agent reported as "Bad request" — indistinguishable
// from a broken store. And a shop the key was never granted is a permission boundary, not a fault.
assert.match(uzum, /const size = Math\.min\(wanted, 50\)/, 'catalogue pages must use a bounded page size')
assert.match(uzum, /\?size=\$\{size\}&page=\$\{page\}/, 'the required size and page params must be sent for every page')
assert.match(uzum, /for \(let page = 0; products\.length < wanted; page\+\+\)/, 'the catalogue must not silently stop after page zero')
assert.match(uzum, /export type ShopAccess = 'ok' \| 'no_access' \| 'rate_limited' \| 'error'/,
  'access must be classified, not collapsed into one error')
assert.match(uzum, /if \(status === 401 \|\| status === 403\) return 'no_access'/)
assert.match(uzum, /not available\|нет доступа\|no access\|forbidden\|not found/i,
  'Uzum\'s own "Shop is not available" must read as no-access')
assert.match(uzum, /export async function uzumStoreReport/, 'every shop needs its own verdict')
assert.match(uzum, /Магазинов у продавца: \$\{report\.shops\.length\}\. Ключ читает: \$\{open\.length\}/,
  'the answer must state the split between owned and readable shops')
assert.match(uzum, /Это ограничение ключа, а не сбой/,
  'a scoped key must not be described to the owner as a malfunction')

// One 429 on one shop must not erase the whole report.
assert.match(uzum, /response\.status === 429 \|\| response\.status >= 500\) && attempt === 0/,
  'a rate-limited shop must be retried once')

// The team snapshot must read every readable shop, not just the first of four.
assert.match(snapshot, /uzumStoreReport\(token, maxRows\)/)
assert.match(snapshot, /open\.flatMap\(\(s\) => s\.rows\)/, 'rows from all accessible shops must be combined')
assert.match(snapshot, /ключу не выдан доступ/, 'the team must be told which shops it cannot see and why')
assert.doesNotMatch(snapshot, /const shop = listed\.shops\[0\]/, 'reading only the first shop is the bug being fixed')

console.log('Store access contracts passed.')
