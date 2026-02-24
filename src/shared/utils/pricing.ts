// eslint-disable-next-line no-restricted-imports -- resources/ is outside src/, no alias available
import pricingData from '../../../resources/pricing.json';

export interface LiteLLMPricing {
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
  input_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_200k_tokens?: number;
  cache_creation_input_token_cost_above_200k_tokens?: number;
  cache_read_input_token_cost_above_200k_tokens?: number;
  [key: string]: unknown;
}

export interface DisplayPricing {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

const TIER_THRESHOLD = 200_000;

const PRICING_MAP = pricingData as Record<string, unknown>;

// Pre-compute lowercase key map for O(1) case-insensitive lookups
const LOWERCASE_KEY_MAP = new Map<string, string>();
for (const key of Object.keys(PRICING_MAP)) {
  if (!LOWERCASE_KEY_MAP.has(key.toLowerCase())) {
    LOWERCASE_KEY_MAP.set(key.toLowerCase(), key);
  }
}

function isLiteLLMPricing(entry: unknown): entry is LiteLLMPricing {
  return (
    !!entry &&
    typeof entry === 'object' &&
    'input_cost_per_token' in entry &&
    'output_cost_per_token' in entry
  );
}

function tryGetPricing(key: string): LiteLLMPricing | null {
  const entry = PRICING_MAP[key];
  return isLiteLLMPricing(entry) ? entry : null;
}

export function getPricing(modelName: string): LiteLLMPricing | null {
  const exact = tryGetPricing(modelName);
  if (exact) return exact;

  const lowerName = modelName.toLowerCase();
  const originalKey = LOWERCASE_KEY_MAP.get(lowerName);
  if (originalKey) {
    return tryGetPricing(originalKey);
  }

  return null;
}

export function calculateTieredCost(tokens: number, baseRate: number, tieredRate?: number): number {
  if (tokens <= 0) return 0;
  if (tieredRate == null || tokens <= TIER_THRESHOLD) {
    return tokens * baseRate;
  }
  const costBelow = TIER_THRESHOLD * baseRate;
  const costAbove = (tokens - TIER_THRESHOLD) * tieredRate;
  return costBelow + costAbove;
}

export function calculateMessageCost(
  modelName: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number
): number {
  const pricing = getPricing(modelName);
  if (!pricing) {
    if (inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || cacheCreationTokens > 0) {
      console.warn(`[pricing] No pricing data for model "${modelName}", cost will be $0`);
    }
    return 0;
  }

  const inputCost = calculateTieredCost(
    inputTokens,
    pricing.input_cost_per_token,
    pricing.input_cost_per_token_above_200k_tokens
  );
  const outputCost = calculateTieredCost(
    outputTokens,
    pricing.output_cost_per_token,
    pricing.output_cost_per_token_above_200k_tokens
  );
  const cacheCreationCost = calculateTieredCost(
    cacheCreationTokens,
    pricing.cache_creation_input_token_cost ?? 0,
    pricing.cache_creation_input_token_cost_above_200k_tokens
  );
  const cacheReadCost = calculateTieredCost(
    cacheReadTokens,
    pricing.cache_read_input_token_cost ?? 0,
    pricing.cache_read_input_token_cost_above_200k_tokens
  );

  return inputCost + outputCost + cacheCreationCost + cacheReadCost;
}

export function getDisplayPricing(modelName: string): DisplayPricing | null {
  const pricing = getPricing(modelName);
  if (!pricing) return null;

  return {
    input: pricing.input_cost_per_token * 1_000_000,
    output: pricing.output_cost_per_token * 1_000_000,
    cache_read: (pricing.cache_read_input_token_cost ?? 0) * 1_000_000,
    cache_creation: (pricing.cache_creation_input_token_cost ?? 0) * 1_000_000,
  };
}
