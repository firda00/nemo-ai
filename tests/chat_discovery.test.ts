import { describe, expect, test } from 'vitest'
import { advanceChatDiscovery, discoveryPrompt, isCapabilityQuestion, isExplicitCreation, nextDiscoveryStep, startChatDiscovery } from '../src/lib/chatDiscovery'

describe('capability questions are informational', () => {
  test.each(['что ты умешь', 'Какие у тебя возможности?', 'что умеет Nemo', 'Привет, что ты умеешь?', 'Расскажи о твоих возможностях', 'What can you do?', 'Please, how can you help?', 'Salom, nimalar qila olasan?', 'Nimalarga qodirsan?'])('%s', text => {
    expect(isCapabilityQuestion(text)).toBe(true)
  })
  test.each(['Что ты можешь сделать с этой выпиской?', 'Что ты умеешь? Создай команду', 'Что умеет Nemo и запиши меня на занятие', 'What can you do with this image?', 'Создай команду поддержки'])('does not consume a task: %s', text => {
    expect(isCapabilityQuestion(text)).toBe(false)
  })
})

describe('intake retains explicitly supplied fields', () => {
  test.each(['Объясни, как создать команду для контента в Telegram', 'Не надо создать команду для контента в Telegram', '«Создай команду для Telegram»', 'How to create a team for Telegram', 'Создай инструкцию, как создать команду для контента в Telegram', 'Создай текст «создай команду для контента в Telegram»'])('does not authorize creation: %s', text => {
    expect(isExplicitCreation(text)).toBe(false)
  })
  test.each(['Отмена', 'Не надо', 'Как выбрать источники', 'Что это значит?'])('does not consume cancellation/question as sources: %s', text => {
    const state = startChatDiscovery('team', 'Создай команду для подготовки контента')
    expect(nextDiscoveryStep(advanceChatDiscovery(state, text))).toBe('channels')
  })
  test.each(['Создай команду без интеграций', 'Создай команду с сайтом', 'Создай команду с CSV'])('source-only request asks for an outcome: %s', text => {
    expect(startChatDiscovery('team', text).step).toBe('goal')
  })
  test('a complete team request needs no duplicate questions', () => {
    const text = 'Создай команду для ответов на вопросы клиентов в Telegram'
    const state = startChatDiscovery('team', text)
    expect(nextDiscoveryStep(state)).toBeNull()
    expect(discoveryPrompt(state)).toContain(text)
    expect(state.requestedKind).toBe('team')
  })
  test('a specified outcome asks only for sources, never repeats the team choice', () => {
    const state = startChatDiscovery('team', 'Создай команду для подготовки контента')
    expect(state.step).toBe('channels')
    const ready = advanceChatDiscovery(state, 'Без интеграций, только файлы')
    expect(nextDiscoveryStep(ready)).toBeNull()
    expect(discoveryPrompt(ready)).toContain('подготовки контента')
    expect(discoveryPrompt(ready)).toContain('Без интеграций')
  })
  test('a channel alone is not an outcome', () => {
    const state = startChatDiscovery('team', 'Создай команду в Telegram')
    expect(state.step).toBe('goal')
    const ready = advanceChatDiscovery(state, 'Отвечать на вопросы о расписании')
    expect(nextDiscoveryStep(ready)).toBeNull()
    expect(ready.channels).toContain('Telegram')
  })
  test('bare create command still asks for the goal; a full answer skips channels', () => {
    const state = startChatDiscovery('agent', 'Создай агента')
    expect(state.step).toBe('goal')
    const ready = advanceChatDiscovery(state, 'Разбирать обращения из CRM')
    expect(nextDiscoveryStep(ready)).toBeNull()
    expect(discoveryPrompt(ready)).toMatch(/^Создай агента/)
  })
  test('questions about capabilities never overwrite pending intake', () => {
    const state = startChatDiscovery('team', 'Создай команду для подготовки контента')
    expect(advanceChatDiscovery(state, 'Что ты умеешь?')).toBe(state)
  })
  test('unknown or contradictory format never silently creates a team', () => {
    let state = startChatDiscovery(null, 'Подготовка контента для Telegram')
    expect(state.step).toBe('format')
    state = advanceChatDiscovery(state, 'Не знаю')
    expect(nextDiscoveryStep(state)).toBe('format')
    expect(() => discoveryPrompt(state)).toThrow('DISCOVERY_INCOMPLETE')
    state = advanceChatDiscovery(state, 'один агент или команда')
    expect(nextDiscoveryStep(state)).toBe('format')
    state = advanceChatDiscovery(state, 'один агент')
    expect(nextDiscoveryStep(state)).toBeNull()
    expect(state.requestedKind).toBe('agent')
  })
  test('negated integrations remain negated in the draft', () => {
    const state = startChatDiscovery('team', 'Создай команду для подготовки постов без Telegram, только CSV')
    expect(discoveryPrompt(state)).toContain('без Telegram, только CSV')
  })
})
