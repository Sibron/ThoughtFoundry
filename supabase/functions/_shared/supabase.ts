// deno-lint-ignore-file no-explicit-any
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Returns a Supabase client scoped to the caller's JWT — RLS is enforced.
export function getUserClient(req: Request): SupabaseClient<any, 'public', any> {
  const authHeader = req.headers.get('Authorization') ?? ''
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  )
}

export async function requireUserId(client: SupabaseClient): Promise<string> {
  const { data, error } = await client.auth.getUser()
  if (error || !data.user) throw new Error('Unauthorized')
  return data.user.id
}

export async function logUsage(
  client: SupabaseClient,
  args: {
    userId: string
    model: string
    operation: string
    inputTokens: number
    outputTokens: number
    costUsd: number
  }
): Promise<void> {
  await client.from('ai_usage').insert({
    user_id: args.userId,
    model: args.model,
    operation: args.operation,
    input_tokens: args.inputTokens,
    output_tokens: args.outputTokens,
    cost_usd: args.costUsd
  })
}
