// Portable-upstream: zero Orca-specific imports; candidate for upstream config
// fields `allowedModels` / `requireAllowlisted` (plan: upstream contribution 3).

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

export const OPENROUTER_FREE_ALIAS = 'openrouter/free'

export const OPENROUTER_PINNED_FREE_MODELS = [
  'google/gemini-2.0-flash-exp:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'meta-llama/llama-3.3-70b-instruct:free'
] as const

export type ModelPolicyDecision =
  | { kind: 'allowed'; model: string }
  | { kind: 'refused'; model: string; reason: string }

export function isModelAllowlisted(model: string): boolean {
  return model === OPENROUTER_FREE_ALIAS || model.endsWith(':free')
}

export function resolveModelPolicy(model: string, allowPaid: boolean): ModelPolicyDecision {
  if (isModelAllowlisted(model)) {
    return { kind: 'allowed', model }
  }
  if (!allowPaid) {
    return {
      kind: 'refused',
      model,
      reason: `Model "${model}" is not in the free allowlist; pass --allow-paid to permit it.`
    }
  }
  return { kind: 'allowed', model }
}
