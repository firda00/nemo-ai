// OpenRouter LLM gateway (model-agnostic per NEMO_AI_SPEC §4).
// One API, many models — the model id is chosen per agent (agents.model),
// e.g. "openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet", "google/gemini-...".

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export async function callOpenRouter(opts: {
  apiKey: string
  model: string
  messages: ChatMsg[]
  temperature?: number
  maxTokens?: number
}): Promise<{ content: string; tokens: number; citations: string[] }> {
  // Free models are flaky + rate-limited, so retry transient errors (429 / 5xx)
  // with backoff. 402 = out of credits (no retry).
  const MAX = 3
  let res: Response | null = null
  for (let attempt = 1; attempt <= MAX; attempt++) {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://nemo.ai',
        'X-Title': 'Nemo AI',
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.6,
        max_tokens: opts.maxTokens ?? 800,
      }),
    })
    if (res.ok) break
    if (res.status === 402) throw new Error('NO_CREDITS')
    if ((res.status === 429 || res.status >= 500) && attempt < MAX) {
      await new Promise((r) => setTimeout(r, attempt * 1500))
      continue
    }
    const detail = await res.text()
    throw new Error(`OpenRouter ${res.status}: ${detail}`)
  }
  if (!res || !res.ok) throw new Error('OpenRouter: retries exhausted')

  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content?.trim() ?? ''
  const tokens = data?.usage?.total_tokens ?? 0
  // Perplexity "online" models return the sources they used here.
  const citations: string[] = Array.isArray(data?.citations)
    ? data.citations
    : Array.isArray(data?.choices?.[0]?.message?.annotations)
      ? data.choices[0].message.annotations.map((a: { url_citation?: { url?: string } }) => a?.url_citation?.url).filter(Boolean)
      : []
  return { content, tokens, citations }
}

// deno-lint-ignore no-explicit-any
export function buildSystemPrompt(agent: any, knowledge: string): string {
  const p = agent?.prompt ?? {}
  const LANG_NAME: Record<string, string> = { uz: 'Uzbek', ru: 'Russian', en: 'English' }
  const langRule =
    agent?.default_lang && agent.default_lang !== 'auto'
      ? `Always reply in ${LANG_NAME[agent.default_lang] ?? 'the customer\'s language'}.`
      : 'Reply in the SAME language the customer writes in (Uzbek, Russian or English).'

  return [
    `You are "${agent?.name ?? 'Nemo'}", an AI assistant working for a business on the Nemo AI platform.`,
    p.role ? `Your role: ${p.role}` : '',
    p.tasks ? `Your tasks: ${p.tasks}` : '',
    p.tone ? `Tone of voice: ${p.tone}` : '',
    p.rules ? `Rules you MUST follow: ${p.rules}` : '',
    langRule,
    knowledge ? `\nKnowledge base — use it to answer accurately:\n${knowledge}` : '',
    `Be concise, friendly and helpful. If you cannot help or the request is sensitive, say a human operator will join shortly.`,
  ]
    .filter(Boolean)
    .join('\n')
}
