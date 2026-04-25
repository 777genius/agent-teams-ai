export type OpenCodeTeamModelRecommendationLevel =
  | 'recommended'
  | 'recommended-with-limits'
  | 'unavailable-in-opencode'
  | 'not-recommended';

export interface OpenCodeTeamModelRecommendation {
  readonly level: OpenCodeTeamModelRecommendationLevel;
  readonly label: string;
  readonly reason: string;
}

const PASSED_REAL_AGENT_TEAMS_E2E_REASON =
  'This exact model route passed real OpenCode Agent Teams E2E: launch, direct reply, and teammate-to-teammate relay.';

const PASSED_FREE_ROUTE_REAL_AGENT_TEAMS_E2E_REASON =
  'This exact free model route passed real OpenCode Agent Teams E2E, but free routes can still have capacity limits, rate limits, and variable latency.';

const OPENCODE_TEAM_RECOMMENDED_MODELS = new Set<string>([
  'openrouter/anthropic/claude-haiku-4.5',
  'openrouter/anthropic/claude-opus-4.6',
  'openrouter/anthropic/claude-opus-4.7',
  'openrouter/anthropic/claude-sonnet-4.5',
  'openrouter/anthropic/claude-sonnet-4.6',
  'openrouter/google/gemini-2.5-flash',
  'openrouter/google/gemini-3.1-flash-lite-preview',
  'openrouter/google/gemini-3.1-pro-preview',
  'openrouter/google/gemini-3-flash-preview',
  'openrouter/minimax/minimax-m2.5',
  'openrouter/minimax/minimax-m2.7',
  'openrouter/moonshotai/kimi-k2.6',
  'openrouter/mistralai/codestral-2508',
  'openrouter/mistralai/devstral-2512',
  'openrouter/mistralai/mistral-medium-3.1',
  'openrouter/openai/gpt-5.1',
  'openrouter/openai/gpt-5.1-codex',
  'openrouter/openai/gpt-5.1-codex-mini',
  'openrouter/openai/gpt-5.3-codex',
  'openrouter/openai/gpt-5.4',
  'openrouter/openai/gpt-5.4-mini',
  'openrouter/qwen/qwen3-max',
  'openrouter/qwen/qwen3-coder',
  'openrouter/qwen/qwen3-coder-flash',
  'openrouter/x-ai/grok-4.1-fast',
  'openrouter/x-ai/grok-4-fast',
  'openrouter/xiaomi/mimo-v2-pro',
  'openrouter/z-ai/glm-4.6',
  'openrouter/z-ai/glm-5',
  'openrouter/z-ai/glm-5.1',
]);

const OPENCODE_TEAM_RECOMMENDED_WITH_LIMITS_MODELS = new Set<string>([
  'opencode/minimax-m2.5-free',
  'openrouter/openai/gpt-oss-120b:free',
]);

const OPENCODE_TEAM_UNAVAILABLE_MODELS = new Map<string, string>([
  [
    'openrouter/qwen/qwen3-coder-plus',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen3-coder-next',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen3-max-thinking',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/mistralai/devstral-medium',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/mistralai/mistral-large-2512',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
]);

const OPENCODE_TEAM_NOT_RECOMMENDED_MODELS = new Map<string, string>([
  [
    'opencode/ling-2.6-flash-free',
    'Real OpenCode Agent Teams E2E showed unreliable peer relay for this model.',
  ],
  [
    'opencode/nemotron-3-super-free',
    'Real OpenCode Agent Teams E2E showed empty assistant turns during peer relay.',
  ],
  [
    'openrouter/google/gemini-2.5-pro',
    'Real OpenCode Agent Teams E2E passed direct reply but failed peer relay.',
  ],
  [
    'openrouter/google/gemini-2.5-flash-lite',
    'Real OpenCode Agent Teams E2E passed direct reply but failed peer relay with plain/control-character output instead of MCP message_send.',
  ],
  [
    'openrouter/google/gemini-3-pro-preview',
    'OpenRouter reported no runnable endpoints for this model during execution verification.',
  ],
  [
    'openrouter/deepseek/deepseek-v3.2',
    'Real OpenCode Agent Teams E2E passed direct reply but failed peer relay after treating Agent Teams MCP tools as unavailable.',
  ],
  [
    'openrouter/meta-llama/llama-3.3-70b-instruct:free',
    'Execution verification timed out before Agent Teams launch could proceed.',
  ],
  [
    'openrouter/minimax/minimax-m2.5:free',
    'This OpenRouter free route for MiniMax M2.5 passed direct reply but failed teammate-to-teammate relay. The non-free OpenRouter route and the OpenCode free alias are tracked separately.',
  ],
  [
    'openrouter/moonshotai/kimi-k2-thinking',
    'Real OpenCode Agent Teams E2E failed during launch reconciliation with an aborted assistant message.',
  ],
  [
    'openrouter/openai/gpt-5.2-codex',
    'Real OpenCode Agent Teams E2E failed launch readiness because model verification timed out.',
  ],
  [
    'openrouter/openai/gpt-5.1-chat',
    'Real OpenCode Agent Teams E2E passed direct reply but failed peer relay by delegating to the lead instead of messaging the requested teammate.',
  ],
  [
    'openrouter/openai/gpt-oss-20b:free',
    'Execution verification passed, but real Agent Teams E2E produced fake tool text instead of MCP message_send.',
  ],
  [
    'openrouter/openrouter/free',
    'Aggregator routing was unstable in real Agent Teams E2E and timed out during peer relay.',
  ],
  [
    'openrouter/x-ai/grok-code-fast-1',
    'Real OpenCode Agent Teams E2E passed direct reply but failed peer relay by delegating to the lead instead of messaging the requested teammate.',
  ],
  [
    'openrouter/z-ai/glm-4.5-air:free',
    'Real OpenCode Agent Teams E2E was slow and failed peer relay with empty assistant turns.',
  ],
]);

function normalizeOpenCodeTeamModelId(modelId: string | null | undefined): string {
  return modelId?.trim().toLowerCase() ?? '';
}

export function getOpenCodeTeamModelRecommendation(
  modelId: string | null | undefined
): OpenCodeTeamModelRecommendation | null {
  const normalizedModelId = normalizeOpenCodeTeamModelId(modelId);
  if (!normalizedModelId) {
    return null;
  }

  if (OPENCODE_TEAM_RECOMMENDED_MODELS.has(normalizedModelId)) {
    return {
      level: 'recommended',
      label: 'Recommended',
      reason: PASSED_REAL_AGENT_TEAMS_E2E_REASON,
    };
  }

  if (OPENCODE_TEAM_RECOMMENDED_WITH_LIMITS_MODELS.has(normalizedModelId)) {
    return {
      level: 'recommended-with-limits',
      label: 'Recommended with limits',
      reason: PASSED_FREE_ROUTE_REAL_AGENT_TEAMS_E2E_REASON,
    };
  }

  const unavailableReason = OPENCODE_TEAM_UNAVAILABLE_MODELS.get(normalizedModelId);
  if (unavailableReason) {
    return {
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
      reason: unavailableReason,
    };
  }

  const notRecommendedReason = OPENCODE_TEAM_NOT_RECOMMENDED_MODELS.get(normalizedModelId);
  if (notRecommendedReason) {
    return {
      level: 'not-recommended',
      label: 'Not recommended',
      reason: notRecommendedReason,
    };
  }

  return null;
}

export function isOpenCodeTeamModelRecommended(modelId: string | null | undefined): boolean {
  const recommendation = getOpenCodeTeamModelRecommendation(modelId);
  return (
    recommendation?.level === 'recommended' || recommendation?.level === 'recommended-with-limits'
  );
}

export function getOpenCodeTeamModelRecommendationSortRank(
  modelId: string | null | undefined
): number {
  const recommendation = getOpenCodeTeamModelRecommendation(modelId);
  if (recommendation?.level === 'recommended') {
    return 0;
  }
  if (recommendation?.level === 'recommended-with-limits') {
    return 1;
  }
  if (recommendation?.level === 'unavailable-in-opencode') {
    return 3;
  }
  if (recommendation?.level === 'not-recommended') {
    return 4;
  }
  return 2;
}

export function compareOpenCodeTeamModelRecommendations(
  leftModelId: string | null | undefined,
  rightModelId: string | null | undefined
): number {
  const leftRank = getOpenCodeTeamModelRecommendationSortRank(leftModelId);
  const rightRank = getOpenCodeTeamModelRecommendationSortRank(rightModelId);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return 0;
}
