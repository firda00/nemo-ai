import { describe, expect, test } from 'vitest'
import {
  executeWithSelfHealing,
  sanitizeSelfHealingError,
  SelfHealingExhaustedError,
} from '../agent-hub/orchestration/self-healing-loop.ts'

describe('Continuous Self-Healing Loop', () => {
  test('returns valid structured output on the first isolated execution', async () => {
    const result = await executeWithSelfHealing({
      source: 'console.log(JSON.stringify({ total: parameters.a + parameters.b }));',
      parameters: { a: 19, b: 23 },
    })

    expect(result.status).toBe('completed')
    expect(result.output).toEqual({ total: 42 })
    expect(result.attempts).toBe(1)
    expect(result.manifest.exit_code).toBe(0)
    expect(result.history).toHaveLength(1)
  })

  test('does not misclassify a JSON timestamp as a phone number', async () => {
    const result = await executeWithSelfHealing({
      source: 'console.log(JSON.stringify({ ts: 1766650000000, id: 12345678 }));',
    })

    expect(result.output).toEqual({ ts: 1766650000000, id: 12345678 })
    expect(result.attempts).toBe(1)
  })

  test('uses a structured correction prompt and succeeds on the second attempt', async () => {
    const prompts: string[] = []
    const result = await executeWithSelfHealing({
      source: 'throw new Error("broken runtime");',
      parameters: { value: 7 },
    }, {
      corrector: async (request) => {
        prompts.push(request.prompt)
        expect(request.errorCode).toBe('SANDBOX_EXECUTION_FAILED')
        return 'console.log(JSON.stringify({ fixed: true, value: parameters.value }));'
      },
    })

    expect(result.output).toEqual({ fixed: true, value: 7 })
    expect(result.attempts).toBe(2)
    expect(result.history.map((iteration) => iteration.status)).toEqual(['failed', 'completed'])
    expect(JSON.parse(prompts[0])).toMatchObject({
      contract: 'nemo-self-healing-correction-v1',
      profile: 'PROFILE_A_WASI',
      failed_attempt: 1,
    })
  })

  test('throws typed history after the configured three-attempt limit', async () => {
    let corrections = 0
    const execution = executeWithSelfHealing({
      source: 'throw new Error("still broken");',
    }, {
      maxRetries: 3,
      corrector: async () => {
        corrections += 1
        return 'throw new Error("still broken");'
      },
    })

    await expect(execution).rejects.toBeInstanceOf(SelfHealingExhaustedError)
    try {
      await execution
    } catch (error) {
      expect(error).toBeInstanceOf(SelfHealingExhaustedError)
      const exhausted = error as SelfHealingExhaustedError
      expect(exhausted.code).toBe('SELF_HEALING_EXHAUSTED')
      expect(exhausted.history).toHaveLength(3)
      expect(exhausted.history.every((iteration) => iteration.status === 'failed')).toBe(true)
    }
    expect(corrections).toBe(2)
  })

  test('redacts host paths and tokens before correction context', () => {
    const token = ['sk', 'or', 'v1', 'abcdefghijklmnopqrstuvwxyz'].join('-')
    const sanitized = sanitizeSelfHealingError(
      `at file:///C:/Users/firda/AppData/Local/Temp/nemo-wasi/job.ts:4:2\n`
      + `at /tmp/nemo-wasi-123/job.ts:5:1 api_key=${token}`,
    )

    expect(sanitized).not.toContain('C:/Users/firda')
    expect(sanitized).not.toContain('/tmp/nemo-wasi-123')
    expect(sanitized).not.toContain(token)
    expect(sanitized).toContain('[HOST_PATH]')
    expect(sanitized).toContain('[REDACTED]')
  })
})
