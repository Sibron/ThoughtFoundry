// Minimal Anthropic Messages API client for Supabase Edge Functions (Deno).
// No SDK — direct fetch keeps the cold start small.

export type AnthropicModel =
  | 'claude-haiku-4-5'
  | 'claude-sonnet-4-6'
  | 'claude-opus-4-7'

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AnthropicResult {
  text: string
  inputTokens: number
  outputTokens: number
}

// USD per million tokens (list prices, conservative). Used for client-side cost tracking.
const PRICING: Record<AnthropicModel, { input: number; output: number }> = {
  'claude-haiku-4-5':  { input: 1.0,  output: 5.0  },
  'claude-sonnet-4-6': { input: 3.0,  output: 15.0 },
  'claude-opus-4-7':   { input: 15.0, output: 75.0 }
}

export function estimateCost(
  model: AnthropicModel,
  inputTokens: number,
  outputTokens: number
): number {
  const p = PRICING[model]
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000
}

export async function callAnthropic(opts: {
  apiKey: string
  model: AnthropicModel
  system: string
  messages: AnthropicMessage[]
  maxTokens?: number
}): Promise<AnthropicResult> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.system,
      messages: opts.messages
    })
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Anthropic ${res.status}: ${errText}`)
  }

  const data = await res.json()
  const text = (data.content ?? [])
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text)
    .join('')

  return {
    text,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0
  }
}

// Pull JSON out of a possibly-fenced Claude response.
export function parseJsonFromResponse<T>(text: string): T {
  const trimmed = text.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonText = fence ? fence[1].trim() : trimmed
  return JSON.parse(jsonText) as T
}
