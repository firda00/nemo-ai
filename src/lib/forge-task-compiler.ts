import {
  ProjectExecutionPlanSchema,
  type ExecutionStep,
  type ForgeStepType,
  type ProjectExecutionPlan,
} from '../types/forge-contracts.ts'

const PROMPT_LIMIT = 16_384

const SIGNALS = {
  research: /\b(research|analyse|analyze|competitor|market|monitor|watch|source|evidence)\b|исслед|анализ|конкурент|рынок|монитор|наблюд|источник|доказатель|raqobat|bozor|tadqiq/i,
  documents: /\b(document|report|proposal|presentation|slides|pdf|plan|article|copy|caption)\b|документ|отч[её]т|предложен|презентац|слайд|контент.?план|стать|текст|пост|reja|hisobot/i,
  media: /\b(image|video|media|reel|shorts|avatar|voice|audio|storyboard)\b|изображен|картин|видео|ролик|рилс|аватар|озвуч|аудио|раскадров|tasvir|rasm|ovoz/i,
  publish: /\b(publish|send|email|schedule|post to|upload to|update crm|write to crm)\b|опублик|отправ|размест|запланир|запис.*crm|обнов.*crm|jo['’]?nat|nashr/i,
} as const

const STEP_DEFINITIONS: Record<ForgeStepType, Omit<ExecutionStep, 'stepId' | 'dependsOn'>> = {
  research: {
    title: 'Собрать и проверить источники', type: 'research', status: 'pending',
    assignedSkillId: 'evidence-research', computeProfile: 'PROFILE_A_WASI', evidenceRefs: [],
    artifactRefs: [], costTokens: 0, estimatedCostUsd: 0.02, requiresApproval: false,
  },
  documents: {
    title: 'Подготовить структурированный материал', type: 'documents', status: 'pending',
    assignedSkillId: 'document-authoring', computeProfile: 'PROFILE_B_DOCS', evidenceRefs: [],
    artifactRefs: [], costTokens: 0, estimatedCostUsd: 0.03, requiresApproval: false,
  },
  media: {
    title: 'Создать медиа-артефакты', type: 'media', status: 'pending',
    assignedSkillId: 'media-generation', computeProfile: 'PROFILE_C_BROWSER', evidenceRefs: [],
    artifactRefs: [], costTokens: 0, estimatedCostUsd: 0.25, requiresApproval: false,
  },
  quality_check: {
    title: 'Проверить факты, качество и ограничения', type: 'quality_check', status: 'pending',
    assignedSkillId: 'grounding-quality-gate', computeProfile: 'PROFILE_A_WASI', evidenceRefs: [],
    artifactRefs: [], costTokens: 0, estimatedCostUsd: 0.01, requiresApproval: false,
  },
  approval: {
    title: 'Получить подтверждение человека', type: 'approval', status: 'waiting_approval',
    assignedSkillId: 'human-approval', computeProfile: 'PROFILE_A_WASI', evidenceRefs: [],
    artifactRefs: [], costTokens: 0, estimatedCostUsd: 0, requiresApproval: true,
  },
  publish: {
    title: 'Выполнить подтверждённое действие', type: 'publish', status: 'pending',
    assignedSkillId: 'approved-delivery', computeProfile: 'PROFILE_A_WASI', evidenceRefs: [],
    artifactRefs: [], costTokens: 0, estimatedCostUsd: 0.01, requiresApproval: true,
  },
}

export interface CompileTaskOptions {
  projectId?: string
  title?: string
  totalBudgetCapUsd?: number
}

// A small deterministic non-cryptographic hash is sufficient here: these UUIDs are stable
// DAG identifiers, not secrets or authorization tokens. Keeping it pure makes the exact same
// compiler runnable in Node workers and in the browser preview without bundling node:crypto.
function hash32(value: string, seed: number): number {
  let hash = (2166136261 ^ seed) >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function deterministicUuid(seed: string): string {
  const hex = [0, 1, 2, 3].map((salt) => hash32(seed, salt * 0x9e3779b1).toString(16).padStart(8, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function newProjectId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  throw new Error('FORGE_SECURE_RANDOM_UNAVAILABLE')
}

function normalizePrompt(rawPrompt: string): string {
  const normalized = rawPrompt.trim().replace(/\s+/g, ' ')
  if (normalized.length > PROMPT_LIMIT) throw new Error('FORGE_PROMPT_TOO_LONG')
  return normalized
}

function inferTypes(prompt: string): ForgeStepType[] {
  const types: ForgeStepType[] = []
  if (SIGNALS.research.test(prompt)) types.push('research')
  if (SIGNALS.documents.test(prompt)) types.push('documents')
  if (SIGNALS.media.test(prompt)) types.push('media')
  if (!types.length) types.push('research')
  types.push('quality_check')
  if (SIGNALS.publish.test(prompt)) types.push('approval', 'publish')
  return types
}

function defaultTitle(prompt: string): string {
  const compact = prompt.replace(/[\r\n]+/g, ' ').trim()
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`
}

export function compileTask(rawPrompt: string, options: CompileTaskOptions = {}): ProjectExecutionPlan {
  const prompt = normalizePrompt(rawPrompt)
  if (prompt.length < 3) throw new Error('FORGE_PROMPT_TOO_SHORT')
  const projectId = options.projectId ?? newProjectId()
  const steps: ExecutionStep[] = []

  for (const [index, type] of inferTypes(prompt).entries()) {
    const stepId = deterministicUuid(`${projectId}:${index}:${type}`)
    const previous = steps.at(-1)
    steps.push({ ...STEP_DEFINITIONS[type], stepId, dependsOn: previous ? [previous.stepId] : [] })
  }

  const estimatedCostUsd = Number(steps.reduce((sum, step) => sum + step.estimatedCostUsd, 0).toFixed(4))
  const totalBudgetCapUsd = options.totalBudgetCapUsd ?? Math.max(1, estimatedCostUsd)
  return ProjectExecutionPlanSchema.parse({
    schemaVersion: '1.0', projectId, title: options.title?.trim() || defaultTitle(prompt),
    rawUserPrompt: prompt, steps, totalBudgetCapUsd, estimatedCostUsd, currentStageIndex: 0,
  })
}

export class TaskCompiler {
  compile(rawPrompt: string, options: CompileTaskOptions = {}): ProjectExecutionPlan {
    return compileTask(rawPrompt, options)
  }
}
