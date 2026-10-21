import { describe, expect, test } from 'vitest'
import { classifyTaskArtifact } from '../src/lib/smartArtifactIntent'

describe('plain explanations stay in direct chat', () => {
  test.each([
    'Что такое cash flow?',
    'Объясни разницу между доходом и прибылью',
    'Что такое видеомонтаж?',
    'Как работает видеомонтаж?',
    'Пожалуйста, объясни что такое контент',
    'What is HTTP POST?',
    'Explain how audio compression works',
    'How do research notebooks work?',
    'Please explain the difference between cash flow and profit',
    'Cash flow nima?',
    'Kontent nima degani?',
    'Audio qanday ishlaydi?',
    'Daromad va xarajat o‘rtasidagi farq nima?',
  ])('%s', (prompt) => {
    expect(classifyTaskArtifact(prompt)).toBeNull()
  })
})

describe('execution requests retain specialized workflows', () => {
  test.each([
    ['Проанализируй расходы по выписке', 'finance'],
    ['Создай контент-план на неделю', 'marketing'],
    ['Смонтируй это видео', 'video-edit'],
    ['Найди товары на https://seller.uzum.uz', 'browser'],
    ['Build a React website', 'code'],
    ['Research competitors', 'research'],
    ['Kontent reja tuz', 'marketing'],
    ['Xarajatlarni hisobla', 'finance'],
    ['Что такое cash flow? Затем проанализируй расходы', 'finance'],
    ['Объясни как работает контент и создай контент-план', 'marketing'],
    ['What is HTTP POST? Then send this post to Telegram', 'marketing'],
    ['Explain how audio compression works and edit this audio', 'research'],
    ['Kontent nima? Keyin kontent reja yarat', 'marketing'],
    ['What is on https://example.com?', 'browser'],
    ['Какие мои расходы?', 'finance'],
    ['What are my cash flow transactions?', 'finance'],
    ['What is the latest research on audio?', 'research'],
  ])('%s → %s', (prompt, artifact) => {
    expect(classifyTaskArtifact(prompt)).toBe(artifact)
  })

  test.each([
    ['Что такое cash flow?', 'finance'],
    ['What is HTTP POST?', 'marketing'],
    ['Audio qanday ishlaydi?', 'research'],
  ])('attached data keeps the original route: %s', (prompt, artifact) => {
    expect(classifyTaskArtifact(prompt, { hasAttachments: true })).toBe(artifact)
  })

  test('an unrelated greeting remains a direct answer', () => {
    expect(classifyTaskArtifact('Привет')).toBeNull()
  })
})
