// Extracts seller fees from the plain text the read-only browser extension captured on the
// Uzum seller cabinet.
//
// Deliberately NOT an LLM call. A commission percentage multiplies into every margin the
// platform reports; a model that "helpfully" rounds or infers one would corrupt Price Guard
// silently and invisibly. This reads only numbers that sit next to a label it recognises,
// and returns nothing when it is unsure — an empty result is a correct answer that sends the
// owner to type three numbers by hand, which is far cheaper than a wrong one.

export type UzumFees = {
  commission_percent: number | null
  fulfillment_tiyin: number | null
  returns_reserve_percent: number | null
  /** The exact substrings the numbers came from, echoed back so the owner can check them. */
  evidence: string[]
}

// Uzbek and Russian labels as they appear in the cabinet. Kept as separate alternatives
// rather than one loose pattern so an unrelated percentage elsewhere on the page cannot be
// mistaken for a commission.
// `(?<!\d)` matters more than it looks: without it a 1-2 digit capture reads "350 %" as
// "50 %" — a plausible-looking commission that would poison every margin downstream. Capture
// up to three digits so an out-of-range value is seen whole and then rejected.
const COMMISSION = /(комисси[яию][^.\n]{0,40}?|komissiya[^.\n]{0,40}?)(?<!\d)(\d{1,3}(?:[.,]\d{1,2})?)\s*%/i
const RETURNS = /((?:резерв|возврат)[^.\n]{0,40}?|(?:qaytar|rezerv)[^.\n]{0,40}?)(?<!\d)(\d{1,3}(?:[.,]\d{1,2})?)\s*%/i
// U+2018 and U+2019 both show up as the apostrophe in "so‘m", depending on who typed it.
const FULFILLMENT = /((?:фулфилмент|логистик|доставк|обработк)[^.\n]{0,40}?|(?:fulfilment|fulfillment|logistik|yetkaz)[^.\n]{0,40}?)(?<!\d)(\d[\d\s\u00a0]{2,12})\s*(?:сум|so['‘’]m|uzs)/i

const num = (raw: string) => Number(raw.replace(/[\s\u00a0]/g, '').replace(',', '.'))

function pick(text: string, re: RegExp, max: number): { value: number; evidence: string } | null {
  const hit = text.match(re)
  if (!hit) return null
  const value = num(hit[2])
  if (!Number.isFinite(value) || value < 0 || value > max) return null
  return { value, evidence: hit[0].trim().slice(0, 120) }
}

export function extractUzumFees(pageText: string): UzumFees {
  const text = String(pageText ?? '').replace(/\u00a0/g, ' ')
  const commission = pick(text, COMMISSION, 100)
  const returns = pick(text, RETURNS, 100)
  const fulfillment = pick(text, FULFILLMENT, 100_000_000)

  return {
    commission_percent: commission?.value ?? null,
    // Cabinet fees are quoted in so'm; commerce stores integer tiyin.
    fulfillment_tiyin: fulfillment ? Math.round(fulfillment.value * 100) : null,
    returns_reserve_percent: returns?.value ?? null,
    evidence: [commission?.evidence, fulfillment?.evidence, returns?.evidence].filter(Boolean) as string[],
  }
}

export function hasAnyFee(fees: UzumFees): boolean {
  return fees.commission_percent !== null || fees.fulfillment_tiyin !== null || fees.returns_reserve_percent !== null
}
