export interface ShadowEvalCase {
  workflow_id: string
  predicted_action: boolean
  expected_action: boolean
  grounding_score: number
}

export interface EvalThresholds {
  minimumPrecision: number
  maximumFalseActionRate: number
  minimumSamples: number
  minimumGroundingScore: number
}

export interface PrecisionEvalResult {
  sample_count: number
  true_positives: number
  false_positives: number
  false_negatives: number
  true_negatives: number
  precision: number
  recall: number
  false_action_rate: number
  average_grounding_score: number
  eligible_for_live: boolean
  rejection_reasons: string[]
}

export const DEFAULT_LIVE_THRESHOLDS: Readonly<EvalThresholds> = Object.freeze({
  minimumPrecision: 0.95,
  maximumFalseActionRate: 0.01,
  minimumSamples: 100,
  minimumGroundingScore: 0.95,
})

const safeRatio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : numerator / denominator

export function runPrecisionEval(
  cases: ShadowEvalCase[],
  thresholds: EvalThresholds = DEFAULT_LIVE_THRESHOLDS,
): PrecisionEvalResult {
  if (
    thresholds.minimumPrecision < 0 || thresholds.minimumPrecision > 1
    || thresholds.maximumFalseActionRate < 0 || thresholds.maximumFalseActionRate > 1
    || thresholds.minimumGroundingScore < 0 || thresholds.minimumGroundingScore > 1
    || !Number.isInteger(thresholds.minimumSamples) || thresholds.minimumSamples < 1
  ) throw new Error('EVAL_THRESHOLDS_INVALID')

  let truePositives = 0
  let falsePositives = 0
  let falseNegatives = 0
  let trueNegatives = 0
  let groundingTotal = 0
  for (const item of cases) {
    if (!Number.isFinite(item.grounding_score) || item.grounding_score < 0 || item.grounding_score > 1) {
      throw new Error('EVAL_CASE_INVALID')
    }
    groundingTotal += item.grounding_score
    if (item.predicted_action && item.expected_action) truePositives++
    else if (item.predicted_action && !item.expected_action) falsePositives++
    else if (!item.predicted_action && item.expected_action) falseNegatives++
    else trueNegatives++
  }

  const precision = safeRatio(truePositives, truePositives + falsePositives)
  const recall = safeRatio(truePositives, truePositives + falseNegatives)
  // Operational FAR answers: what fraction of all observed workflows would trigger a wrong action?
  const falseActionRate = safeRatio(falsePositives, cases.length)
  const averageGrounding = safeRatio(groundingTotal, cases.length)
  const rejectionReasons: string[] = []
  if (cases.length < thresholds.minimumSamples) rejectionReasons.push('INSUFFICIENT_SAMPLES')
  if (precision < thresholds.minimumPrecision) rejectionReasons.push('PRECISION_BELOW_THRESHOLD')
  if (falseActionRate > thresholds.maximumFalseActionRate) rejectionReasons.push('FALSE_ACTION_RATE_ABOVE_THRESHOLD')
  if (averageGrounding < thresholds.minimumGroundingScore) rejectionReasons.push('GROUNDING_BELOW_THRESHOLD')

  return {
    sample_count: cases.length,
    true_positives: truePositives,
    false_positives: falsePositives,
    false_negatives: falseNegatives,
    true_negatives: trueNegatives,
    precision: Number(precision.toFixed(6)),
    recall: Number(recall.toFixed(6)),
    false_action_rate: Number(falseActionRate.toFixed(6)),
    average_grounding_score: Number(averageGrounding.toFixed(6)),
    eligible_for_live: rejectionReasons.length === 0,
    rejection_reasons: rejectionReasons,
  }
}
