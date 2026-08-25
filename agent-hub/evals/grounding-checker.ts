export type GroundingDomain = 'deal' | 'schedule' | 'inventory'
export type GroundingScalar = string | number | boolean | null

export interface SensorEntityObservation {
  domain: GroundingDomain
  /** Stable CRM/order/resource key. Free-form OCR text must never be used as an entity key. */
  entity_id: string
  confidence: number
  attributes: Record<string, GroundingScalar>
}

export interface ConfirmedTenantEntity {
  domain: GroundingDomain
  entity_id: string
  active: boolean
  attributes: Record<string, GroundingScalar>
}

export type GroundingMismatchCode =
  | 'FALSE_DETECTION'
  | 'INACTIVE_ENTITY'
  | 'HALLUCINATED_ATTRIBUTE'
  | 'ATTRIBUTE_MISMATCH'
  | 'INVALID_CONFIDENCE'

export interface GroundingMismatch {
  domain: GroundingDomain
  entity_id: string
  attribute?: string
  code: GroundingMismatchCode
}

export interface GroundingResult {
  grounding_score: number
  matched_weight: number
  total_weight: number
  grounded: boolean
  false_detection: boolean
  mismatches: GroundingMismatch[]
}

export interface GroundingOptions {
  minimumScore?: number
  /** Numeric attributes may differ only by this absolute amount. Default is exact agreement. */
  numericTolerance?: number
}

function normalize(value: GroundingScalar): GroundingScalar {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase('en-US') : value
}

function valuesAgree(left: GroundingScalar, right: GroundingScalar, tolerance: number): boolean {
  if (typeof left === 'number' && typeof right === 'number') {
    return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance
  }
  return normalize(left) === normalize(right)
}

/**
 * Compares only structured identifiers/attributes against tenant-authoritative facts. Sensor text
 * remains data: this module never builds prompts and never interprets an attribute as an instruction.
 */
export function checkSensorGrounding(input: {
  observations: SensorEntityObservation[]
  confirmedEntities: ConfirmedTenantEntity[]
  options?: GroundingOptions
}): GroundingResult {
  const minimumScore = input.options?.minimumScore ?? 0.95
  const tolerance = input.options?.numericTolerance ?? 0
  if (minimumScore < 0 || minimumScore > 1 || tolerance < 0 || !Number.isFinite(tolerance)) {
    throw new Error('GROUNDING_POLICY_INVALID')
  }

  const confirmed = new Map(
    input.confirmedEntities.map((entity) => [`${entity.domain}:${entity.entity_id}`, entity]),
  )
  const mismatches: GroundingMismatch[] = []
  let matchedWeight = 0
  let totalWeight = 0
  let falseDetection = false

  for (const observation of input.observations) {
    const confidence = observation.confidence
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      mismatches.push({
        domain: observation.domain,
        entity_id: observation.entity_id,
        code: 'INVALID_CONFIDENCE',
      })
      totalWeight += 1
      continue
    }

    const authoritative = confirmed.get(`${observation.domain}:${observation.entity_id}`)
    const attributeEntries = Object.entries(observation.attributes)
    const entityWeight = Math.max(attributeEntries.length, 1) * Math.max(confidence, 0.01)
    totalWeight += entityWeight
    if (!authoritative) {
      falseDetection = true
      mismatches.push({
        domain: observation.domain,
        entity_id: observation.entity_id,
        code: 'FALSE_DETECTION',
      })
      continue
    }
    if (!authoritative.active) {
      falseDetection = true
      mismatches.push({
        domain: observation.domain,
        entity_id: observation.entity_id,
        code: 'INACTIVE_ENTITY',
      })
      continue
    }
    if (attributeEntries.length === 0) {
      matchedWeight += entityWeight
      continue
    }

    const perAttributeWeight = entityWeight / attributeEntries.length
    for (const [attribute, observed] of attributeEntries) {
      if (!Object.hasOwn(authoritative.attributes, attribute)) {
        mismatches.push({
          domain: observation.domain,
          entity_id: observation.entity_id,
          attribute,
          code: 'HALLUCINATED_ATTRIBUTE',
        })
      } else if (!valuesAgree(observed, authoritative.attributes[attribute], tolerance)) {
        mismatches.push({
          domain: observation.domain,
          entity_id: observation.entity_id,
          attribute,
          code: 'ATTRIBUTE_MISMATCH',
        })
      } else {
        matchedWeight += perAttributeWeight
      }
    }
  }

  const groundingScore = totalWeight === 0 ? 0 : matchedWeight / totalWeight
  return {
    grounding_score: Number(groundingScore.toFixed(6)),
    matched_weight: Number(matchedWeight.toFixed(6)),
    total_weight: Number(totalWeight.toFixed(6)),
    grounded: input.observations.length > 0
      && !falseDetection
      && mismatches.length === 0
      && groundingScore >= minimumScore,
    false_detection: falseDetection,
    mismatches,
  }
}
