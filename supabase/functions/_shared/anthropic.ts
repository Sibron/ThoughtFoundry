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

// USD per million tokens (current list prices). Used for cost tracking + the
// client-side monthly cap. Keep in sync with the official model pricing —
// an over-estimate here silently trips the monthly-cap block in the UI.
const PRICING: Record<AnthropicModel, { input: number; output: number }> = {
  'claude-haiku-4-5':  { input: 1.0,  output: 5.0  },
  'claude-sonnet-4-6': { input: 3.0,  output: 15.0 },
  'claude-opus-4-7':   { input: 5.0,  output: 25.0 }
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
  operation?: string
}): Promise<AnthropicResult> {
  // Basic structured logging — request. Never logs the prompt body or key,
  // only sizes/metadata, so it is safe to leave on in the function logs.
  const tag = opts.operation ? `[anthropic:${opts.operation}]` : '[anthropic]'
  const startedAt = Date.now()
  console.log(`${tag} request`, JSON.stringify({
    model: opts.model,
    maxTokens: opts.maxTokens ?? 1024,
    systemChars: opts.system.length,
    messageCount: opts.messages.length
  }))

  let res: Response
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
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
  } catch (err) {
    // Network / fetch-level failure (DNS, TLS, timeout) — log and rethrow.
    console.error(`${tag} fetch failed`, err instanceof Error ? err.message : String(err))
    throw new Error(`Anthropic request failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!res.ok) {
    const errText = await res.text()
    console.error(`${tag} error`, JSON.stringify({ status: res.status, body: errText.slice(0, 500) }))
    throw new Error(`Anthropic ${res.status}: ${errText}`)
  }

  const data = await res.json()
  const text = (data.content ?? [])
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text)
    .join('')

  const inputTokens = data.usage?.input_tokens ?? 0
  const outputTokens = data.usage?.output_tokens ?? 0
  console.log(`${tag} response`, JSON.stringify({
    status: res.status,
    ms: Date.now() - startedAt,
    inputTokens,
    outputTokens,
    textChars: text.length,
    stopReason: data.stop_reason ?? null
  }))

  return { text, inputTokens, outputTokens }
}

// Pull JSON out of a possibly-fenced Claude response.
export function parseJsonFromResponse<T>(text: string): T {
  const trimmed = text.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonText = fence ? fence[1].trim() : trimmed
  return JSON.parse(jsonText) as T
}
