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

export interface GoalCriterionResult {
  criterion: string
  achieved: boolean
  evidence: string
}

export interface GoalEvaluation {
  achieved: boolean
  checked_at: string
  criteria: GoalCriterionResult[]
}

export function defaultDefinitionOfDone(goal: string): string[] {
  const compact = goal.replace(/\s+/g, ' ').trim().slice(0, 180)
  return [
    `Сформирован конкретный результат по цели: ${compact}`,
    'Результат проверен на полноту и фактическую обоснованность',
    'Финальный материал содержит применимые следующие действия',
  ]
}
