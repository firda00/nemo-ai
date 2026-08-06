import assert from 'node:assert/strict'
import { PRIOR_UNITS, observedRate, pool, reserveRate, reservesForCatalogue } from '../supabase/functions/_shared/returnsReserve.ts'

// The case that started this: a scarf with six lifetime sales and five returns. Uzum reports 83%,
// which is true about those six units and useless as a reserve.
const scarf = { sold: 6, returned: 5 }
assert.equal(Math.round(observedRate(scarf)), 83, 'the raw rate is what Uzum reports')

// Alone in a catalogue that returns ~10%, the scarf keeps most of the catalogue's rate.
const shrunk = reserveRate(scarf, 10)
assert.ok(shrunk > 10 && shrunk < 35, `six sales must not carry an 83% verdict, got ${shrunk}`)

// The same ratio on real volume is a real signal and survives almost intact.
const proven = reserveRate({ sold: 600, returned: 500 }, 10)
assert.ok(proven > 78, `600 sales must speak for themselves, got ${proven}`)

// No cap: a genuinely terrible product is still allowed to look terrible.
assert.ok(reserveRate({ sold: 5000, returned: 4800 }, 5) > 90, 'a real disaster must not be smoothed away')

// A SKU that never sold gets the population rate, not a zero that would flatter its margin.
assert.equal(reserveRate({ sold: 0, returned: 0 }, 12), 12, 'no history means the population rate')
assert.equal(reserveRate({ sold: null, returned: null }, 12), 12, 'unknown counts behave like no history')

// With nothing to borrow from, Nemo declines to invent a number.
assert.equal(reserveRate({ sold: 0, returned: 0 }, null), null, 'no history and no population means no reserve')
assert.equal(observedRate({ sold: 0, returned: 0 }), null)

// The prior is worth exactly PRIOR_UNITS sales: at that volume the SKU and the population weigh
// the same, so the answer sits halfway between them.
const halfway = reserveRate({ sold: PRIOR_UNITS, returned: PRIOR_UNITS }, 0)
assert.equal(halfway, 50, `at ${PRIOR_UNITS} sales the SKU and the population must weigh equally`)

// Returns cannot exceed sales; a payload claiming otherwise must not push the rate past 100%.
assert.ok(reserveRate({ sold: 2, returned: 99 }, 10) <= 100, 'a nonsense payload must stay bounded')
assert.equal(pool([{ sold: 10, returned: 1 }, { sold: null, returned: 7 }]).sold, 10, 'unknown counts are skipped, not read as zero')

// Whole-catalogue pass: two categories, one calm and well-sold, one thin and noisy. The thin
// category's SKU must land near its own category, not near the catalogue and not at its own 100%.
const reserves = reservesForCatalogue([
  { key: 'calm-a', category: 'Socks', observation: { sold: 400, returned: 20 } },
  { key: 'calm-b', category: 'Socks', observation: { sold: 300, returned: 15 } },
  { key: 'noisy-a', category: 'Swimwear', observation: { sold: 2, returned: 2 } },
  { key: 'noisy-b', category: 'Swimwear', observation: { sold: 3, returned: 2 } },
  { key: 'noisy-c', category: 'Swimwear', observation: { sold: 120, returned: 48 } },
])
assert.ok(Math.abs(reserves.get('calm-a') - 5) < 1.5, `a well-sold SKU keeps its own rate, got ${reserves.get('calm-a')}`)
assert.ok(
  reserves.get('noisy-a') > reserves.get('calm-a'),
  'a swimwear SKU must still inherit swimwear returns, not sock returns',
)
assert.ok(reserves.get('noisy-a') < 60, `two sales must not read as 100%, got ${reserves.get('noisy-a')}`)
assert.ok(
  Math.abs(reserves.get('noisy-a') - reserves.get('noisy-c')) < 20,
  'SKUs in one category must not disagree wildly on the strength of two sales',
)

// Every key comes back, so the worker can never silently drop a SKU from the write.
assert.equal(reserves.size, 5)

console.log('[OK] Return reserve behaviour: 15 assertions')
