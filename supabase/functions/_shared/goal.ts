import { z } from 'zod'

export const GoalStatusSchema = z.enum(['running', 'goal_achieved', 'max_iterations', 'stopped'])

export const GoalSchema = z.object({
  goal_statement: z.string().trim().min(4).max(20_000),
  goal_description: z.string().trim().min(4).max(20_000).optional(),
  definition_of_done: z.array(z.string().trim().min(3).max(500)).min(2).max(5),
  max_iterations: z.number().int().min(1).max(10).default(3),
  current_iteration: z.number().int().min(0).max(10).default(0),
  status: GoalStatusSchema.default('running'),
})

export type GoalContract = z.infer<typeof GoalSchema>

export type GoalCriterionResult = { criterion: string; achieved: boolean; evidence: string }
export type GoalEvaluation = { achieved: boolean; checked_at: string; criteria: GoalCriterionResult[] }

const STOP_WORDS = new Set(['для', 'или', 'как', 'что', 'это', 'the', 'and', 'with', 'from', 'your', 'нужно', 'результат', 'цели', 'goal'])

function terms(value: string): string[] {
  return [...new Set(value.toLowerCase().replace(/[^a-zа-яё0-9]+/giu, ' ').split(/\s+/).filter((word) => word.length >= 4 && !STOP_WORDS.has(word)))].slice(0, 12)
}

/**
 * Deterministic, conservative checklist evaluator. The model never decides whether it
 * may stop: it only produces work. This function checks observable output/source facts.
 */
export function evaluateGoalConditions(goal: GoalContract, output: string, sources: string[] = []): GoalEvaluation {
  const normalized = output.toLowerCase()
  const hasSubstance = output.trim().length >= 240
  const hasActions = /(?:следующ|действ|шаг|рекоменд|action|next step|todo|reja|qadam)|(?:^|\n)\s*(?:[-*]|\d+[.)])\s+/imu.test(output)
  const hasGrounding = sources.length > 0 || /(?:источник|source|подтвержд|evidence|данн|факт|не подтвержден)/iu.test(output)
  const goalTerms = terms(goal.goal_statement)

  const criteria = goal.definition_of_done.map((criterion) => {
    const criterionTerms = terms(criterion)
    const matched = criterionTerms.filter((term) => normalized.includes(term))
    const asksActions = /(?:действ|шаг|рекоменд|action|next|qadam|reja)/iu.test(criterion)
    const asksGrounding = /(?:источник|факт|данн|обосн|подтвержд|source|evidence)/iu.test(criterion)
    const asksOutcome = /(?:результат|сформирован|готов|deliverable|outcome|tayyor)/iu.test(criterion)
    const termCoverage = criterionTerms.length === 0 ? 0 : matched.length / criterionTerms.length
    const goalCoverage = goalTerms.length === 0 ? 1 : goalTerms.filter((term) => normalized.includes(term)).length / goalTerms.length
    const achieved = hasSubstance && (
      (asksActions && hasActions) ||
      (asksGrounding && hasGrounding) ||
      (asksOutcome && goalCoverage >= 0.25) ||
      termCoverage >= 0.45
    )
    const evidence = achieved
      ? asksActions ? 'В результате найдены конкретные действия/шаги.' : asksGrounding ? `Обнаружено обоснование${sources.length ? ` и ${sources.length} источник(ов)` : ''}.` : `Совпало ${matched.length} проверяемых признака(ов).`
      : asksActions ? 'Нет конкретного списка действий.' : asksGrounding ? 'Нет проверяемого обоснования или источников.' : 'Недостаточно признаков выполнения условия.'
    return { criterion, achieved, evidence }
  })

  return { achieved: criteria.every((item) => item.achieved), checked_at: new Date().toISOString(), criteria }
}
