/** Capability of Agent Teams' *managed integration*, not of upstream OpenCode.
 * An auth session or model catalog alone never qualifies a model execution. */
export type OpenCodeProviderCompatibilityState = 'supported' | 'unverified' | 'incompatible';
export type OpenCodeProviderCompatibilityReason = 'cli-plugin' | 'subscription-oauth';
export type OpenCodeProviderGeneration = 'v1' | 'v2';

export type OpenCodeProviderCompatibility =
  | { readonly state: 'supported'; readonly reason: null; readonly canConnect: true }
  | { readonly state: 'unverified'; readonly reason: null; readonly canConnect: true }
  | {
      readonly state: 'incompatible';
      readonly reason: OpenCodeProviderCompatibilityReason;
      readonly canConnect: false;
    };

// The names on the left include both user-facing plan ids and native provider ids.
// The V2 exclusions mean *Agent Teams has not adapted the route*, not that the
// corresponding upstream plugin cannot run on V2.
const V1_INTEGRATIONS = new Set([
  'supergrok', 'zai-coding-plan', 'minimax-token-plan', 'minimax-coding-plan',
  'github-copilot', 'kimi-code-membership', 'kimi-for-coding',
  'kiro', 'cursor', 'cursor-acp', 'openai-plus-pro', 'openai',
  'xiaomi-mimo-token-plan', 'xiaomi-token-plan-ams',
  'xiaomi-token-plan-sgp', 'xiaomi-token-plan-cn',
  'openrouter', 'vercel',
]);
const V2_CLI_NOT_ADAPTED = new Set(['cursor', 'cursor-acp', 'kiro']);
const V2_OAUTH_NOT_ADAPTED = new Set(['supergrok', 'github-copilot']);

const SUPPORTED: OpenCodeProviderCompatibility = {
  state: 'supported', reason: null, canConnect: true,
};
const UNVERIFIED: OpenCodeProviderCompatibility = {
  state: 'unverified', reason: null, canConnect: true,
};
const CLI_UNAVAILABLE: OpenCodeProviderCompatibility = {
  state: 'incompatible', reason: 'cli-plugin', canConnect: false,
};
const OAUTH_UNAVAILABLE: OpenCodeProviderCompatibility = {
  state: 'incompatible', reason: 'subscription-oauth', canConnect: false,
};

/** Single generation matrix for Quick Connect, onboarding and advanced settings.
 * Do not infer "supported" from a saved credential or a successful CLI login. */
export function resolveOpenCodeProviderCompatibility(
  planOrProviderId: string,
  generation: OpenCodeProviderGeneration,
  authMethod?: string | null
): OpenCodeProviderCompatibility {
  const id = planOrProviderId.trim().toLowerCase();
  if (generation === 'v1') return V1_INTEGRATIONS.has(id) ? SUPPORTED : UNVERIFIED;
  if (V2_CLI_NOT_ADAPTED.has(id)) return CLI_UNAVAILABLE;
  if ((id === 'xai' && authMethod === 'oauth') || V2_OAUTH_NOT_ADAPTED.has(id))
    return OAUTH_UNAVAILABLE;
  return UNVERIFIED;
}

/** An OAuth-only provider row must not be treated as an available API-key route. */
export function inferOpenCodeProviderAuthMethod(authMethods: readonly string[]): 'oauth' | null {
  const distinct = new Set(authMethods);
  return distinct.size === 1 && distinct.has('oauth') ? 'oauth' : null;
}

/** Undefined is used by existing, unmanaged callers. Null is an unknown selected runtime. */
export function isOpenCodeProviderConnectionBlocked(
  providerId: string,
  generation: OpenCodeProviderGeneration | null | undefined,
  authMethod?: string | null
): boolean {
  if (generation === undefined) return false;
  if (generation === null) return true;
  return !resolveOpenCodeProviderCompatibility(providerId, generation, authMethod).canConnect;
}
