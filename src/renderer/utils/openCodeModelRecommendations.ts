export type OpenCodeTeamModelRecommendationLevel =
  | 'recommended'
  | 'recommended-with-limits'
  | 'tested'
  | 'tested-with-limits'
  | 'unavailable-in-opencode'
  | 'not-recommended';

export interface OpenCodeTeamModelRecommendation {
  readonly level: OpenCodeTeamModelRecommendationLevel;
  readonly label: string;
  readonly reason: string;
}

const PASSED_REAL_AGENT_TEAMS_E2E_REASON =
  'This exact model route passed real OpenCode Agent Teams smoke E2E: launch, direct reply, and teammate-to-teammate relay.';

const PASSED_FREE_ROUTE_REAL_AGENT_TEAMS_E2E_REASON =
  'This exact free model route passed real OpenCode Agent Teams smoke E2E, but free routes can still have capacity limits, rate limits, and variable latency.';

const PASSED_GAUNTLET_REAL_AGENT_TEAMS_E2E_REASON =
  'This exact model route passed the deeper OpenCode Agent Teams gauntlet: repeated launches, peer relays, concurrent deliveries, taskRefs, and transcript hygiene.';

const PASSED_GAUNTLET_WITH_LIMITS_REASON =
  'This exact model route passed the deeper OpenCode Agent Teams gauntlet, but has a production caveat such as free-route capacity, preview availability, cost, or latency variance.';

const OPENCODE_TEAM_RECOMMENDED_MODELS = new Set<string>([]);

const OPENCODE_TEAM_RECOMMENDED_WITH_LIMITS_MODELS = new Set<string>([]);

const OPENCODE_TEAM_TESTED_MODELS = new Set<string>([
  'openrouter/anthropic/claude-haiku-4.5',
  'openrouter/anthropic/claude-sonnet-4.6',
  'openrouter/google/gemini-2.5-flash',
  'openrouter/google/gemini-3.1-flash-lite-preview',
  'openrouter/google/gemini-3-flash-preview',
  'openrouter/google/gemma-4-26b-a4b-it',
  'openrouter/minimax/minimax-m2',
  'openrouter/minimax/minimax-m2.1',
  'openrouter/minimax/minimax-m2.5',
  'openrouter/minimax/minimax-m2.7',
  'openrouter/moonshotai/kimi-k2.6',
  'openrouter/mistralai/codestral-2508',
  'openrouter/openai/gpt-5.1-codex-mini',
  'openrouter/openai/gpt-5.3-codex',
  'openrouter/openai/gpt-5-nano',
  'openrouter/stepfun/step-3.5-flash',
  'openrouter/x-ai/grok-4.1-fast',
  'openrouter/xiaomi/mimo-v2-pro',
  'openrouter/z-ai/glm-4.7',
  'openrouter/z-ai/glm-4.7-flash',
  'openrouter/z-ai/glm-5.1',
]);

const OPENCODE_TEAM_TESTED_WITH_LIMITS_MODELS = new Set<string>(['opencode/minimax-m2.5-free']);

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
    'openrouter/google/gemini-2.0-flash-lite-001',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/gpt-4.1-nano',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/gpt-4o-mini-2024-07-18',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/gpt-4o-mini-search-preview',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen-plus',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen-turbo',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen3-coder:free',
    'This free route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen3-next-80b-a3b-instruct:free',
    'This free route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen3-235b-a22b-2507',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen3-32b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen3-14b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen3-8b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwq-32b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/deepseek/deepseek-v3.2-exp',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/deepseek/deepseek-chat',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/mistralai/mistral-nemo',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/mistralai/mistral-small-24b-instruct-2501',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/mistralai/mistral-small-3.1-24b-instruct',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/mistralai/mixtral-8x7b-instruct',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/cohere/command-r7b-12-2024',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/cohere/command-r-08-2024',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/rekaai/reka-flash-3',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/rekaai/reka-edge',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/nvidia/nemotron-3-nano-30b-a3b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/minimax/minimax-01',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/nvidia/llama-3.3-nemotron-super-49b-v1.5',
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
    'openrouter/mistralai/devstral-small',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/mistralai/mistral-large-2512',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/mistralai/ministral-14b-2512',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/mistralai/ministral-8b-2512',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/mistralai/ministral-3b-2512',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen3.5-35b-a3b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen3-30b-a3b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/baidu/ernie-4.5-21b-a3b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/nousresearch/hermes-4-70b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/minimax/minimax-m2-her',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/xiaomi/mimo-v2.5',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/xiaomi/mimo-v2.5-pro',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/x-ai/grok-4.20',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/google/gemini-3.1-flash-image-preview',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/z-ai/glm-5v-turbo',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/x-ai/grok-4.20-multi-agent',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/mistralai/mistral-small-creative',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/gpt-5.3-chat',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/mistralai/voxtral-small-24b-2507',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/gpt-5-chat',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen-2.5-72b-instruct',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/tngtech/deepseek-r1t2-chimera',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/google/gemini-2.5-pro-preview',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/mistralai/mistral-saba',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/mistralai/mistral-large-2411',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen3-vl-30b-a3b-instruct',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/inclusionai/ling-2.6-1t:free',
    'This free route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/inclusionai/ling-2.6-flash:free',
    'This free route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/meta-llama/llama-3.1-8b-instruct',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen-2.5-7b-instruct',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/amazon/nova-lite-v1',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/z-ai/glm-4-32b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/bytedance-seed/seed-1.6-flash',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/meta-llama/llama-4-scout',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/meta-llama/llama-3.3-70b-instruct',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/bytedance-seed/seed-2.0-mini',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen3-vl-32b-instruct',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/alibaba/tongyi-deepresearch-30b-a3b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/arcee-ai/trinity-large-preview',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/amazon/nova-micro-v1',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/arcee-ai/trinity-mini',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen3.5-9b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/essentialai/rnj-1-instruct',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/upstage/solar-pro-3',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/allenai/olmo-3.1-32b-instruct',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen-plus-2025-07-28',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/tencent/hy3-preview:free',
    'This free route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen3-vl-8b-instruct',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/nex-agi/deepseek-v3.1-nex-n1',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/baidu/ernie-4.5-vl-28b-a3b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/thedrummer/rocinante-12b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/meta-llama/llama-3.1-70b-instruct',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen-plus-2025-07-28:thinking',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/z-ai/glm-4.6v',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/anthropic/claude-3-haiku',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/bytedance-seed/seed-2.0-lite',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen3-235b-a22b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen3.5-122b-a10b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/deepseek/deepseek-r1-0528',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/amazon/nova-2-lite-v1',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/o3-mini',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/mistralai/mistral-large-2407',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/thedrummer/unslopnemo-12b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen3-vl-235b-a22b-instruct',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen3-vl-8b-thinking',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/kwaipilot/kat-coder-pro-v2',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/o4-mini-high',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/o3-mini-high',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/gpt-4o',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/cohere/command-r-plus-08-2024',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen3-vl-30b-a3b-thinking',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/sao10k/l3.1-euryale-70b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen3.5-27b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/arcee-ai/virtuoso-large',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/gpt-3.5-turbo',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/bytedance-seed/seed-1.6',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/nvidia/llama-3.1-nemotron-70b-instruct',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen-vl-max',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen3-vl-235b-a22b-thinking',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/gpt-audio-mini',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/amazon/nova-pro-v1',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/relace/relace-search',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen-max',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/mistralai/pixtral-large-2411',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/mistralai/mixtral-8x22b-instruct',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/gpt-3.5-turbo-16k',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/mistralai/mistral-large',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/o4-mini-deep-research',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/ai21/jamba-large-1.7',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/o3',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/gpt-audio',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/gpt-4o-audio-preview',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/gpt-4o-2024-11-20',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/gpt-4o-2024-08-06',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/amazon/nova-premier-v1',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/anthropic/claude-3.7-sonnet:thinking',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/gpt-4o-2024-05-13',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/~anthropic/claude-opus-latest',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/gpt-4-turbo',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/gpt-4-turbo-preview',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/gpt-4-1106-preview',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/o3-deep-research',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/o1',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/o3-pro',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/anthropic/claude-opus-4.6-fast',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openai/gpt-5.5-pro',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openrouter/auto',
    'This aggregator route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openrouter/pareto-code',
    'This aggregator route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/openrouter/bodybuilder',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/baidu/qianfan-ocr-fast:free',
    'This free route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/google/lyria-3-pro-preview',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/ibm-granite/granite-4.0-h-micro',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/microsoft/phi-4',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/meta-llama/llama-guard-4-12b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/qwen/qwen-vl-plus',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/deepseek/deepseek-r1-distill-qwen-32b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/google/lyria-3-clip-preview',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/liquid/lfm-2-24b-a2b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/meta-llama/llama-3.2-1b-instruct',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/bytedance/ui-tars-1.5-7b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/baidu/ernie-4.5-21b-a3b-thinking',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/arcee-ai/spotlight',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/meta-llama/llama-3.2-3b-instruct',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/meta-llama/llama-guard-3-8b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/nousresearch/hermes-3-llama-3.1-70b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/allenai/olmo-3-32b-think',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/tencent/hunyuan-a13b-instruct',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/meta-llama/llama-4-maverick',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/nvidia/nemotron-nano-12b-v2-vl',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/thedrummer/cydonia-24b-v4.1',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/microsoft/wizardlm-2-8x22b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/arcee-ai/coder-large',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/thedrummer/skyfall-36b-v2',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/baidu/ernie-4.5-300b-a47b',
    'This route exists in OpenRouter, but was not found in the live OpenCode provider catalog used for Agent Teams launch.',
  ],
  [
    'openrouter/sao10k/l3.3-euryale-70b',
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
    'openrouter/anthropic/claude-opus-4.6',
    'Fresh OpenCode Agent Teams gauntlet launched but timed out already on direct reply.',
  ],
  [
    'openrouter/anthropic/claude-opus-4.7',
    'Fresh OpenCode Agent Teams gauntlet failed OpenCode launch readiness.',
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
    'openrouter/google/gemini-3.1-pro-preview',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness before producing usable Agent Teams behavior.',
  ],
  [
    'openrouter/google/gemini-3.1-pro-preview-customtools',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because production Agent Teams prompts exceeded the route/key token allowance.',
  ],
  [
    'openrouter/google/gemini-2.5-pro-preview-05-06',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/deepseek/deepseek-v3.2',
    'Real OpenCode Agent Teams E2E passed direct reply but failed peer relay after treating Agent Teams MCP tools as unavailable.',
  ],
  [
    'openrouter/deepseek/deepseek-v3.2-speciale',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because OpenRouter reported no tool-use endpoint for this route.',
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
    'openrouter/minimax/minimax-m1',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because production Agent Teams prompts exceeded the route/key token allowance.',
  ],
  [
    'openrouter/moonshotai/kimi-k2-thinking',
    'Real OpenCode Agent Teams E2E failed during launch reconciliation with an aborted assistant message.',
  ],
  [
    'openrouter/moonshotai/kimi-k2.5',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/moonshotai/kimi-k2-0905',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/moonshotai/kimi-k2',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/openai/gpt-5.2-codex',
    'Real OpenCode Agent Teams E2E failed launch readiness because model verification timed out.',
  ],
  [
    'openrouter/openai/gpt-5.2',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/openai/gpt-5-mini',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/openai/gpt-5-codex',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because production Agent Teams prompts exceeded the route/key token allowance.',
  ],
  [
    'openrouter/openai/gpt-5.5',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/openai/gpt-5.1-chat',
    'Real OpenCode Agent Teams E2E passed direct reply but failed peer relay by delegating to the lead instead of messaging the requested teammate.',
  ],
  [
    'openrouter/openai/gpt-5.1',
    'Fresh OpenCode Agent Teams gauntlet passed direct and peer relays but failed concurrent delivery, taskRefs, and duplicate-token correctness.',
  ],
  [
    'openrouter/openai/gpt-5.1-codex',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness during model verification.',
  ],
  [
    'openrouter/openai/gpt-5.4-mini',
    'Fresh OpenCode Agent Teams gauntlet passed direct and peer relays but failed concurrent delivery, taskRefs, and duplicate-token correctness.',
  ],
  [
    'openrouter/openai/gpt-5.4',
    'Fresh OpenCode Agent Teams gauntlet passed direct and peer relays but failed concurrent delivery, taskRefs, and duplicate-token correctness.',
  ],
  [
    'openrouter/openai/gpt-oss-20b:free',
    'Execution verification passed, but real Agent Teams E2E produced fake tool text instead of MCP message_send.',
  ],
  [
    'openrouter/openai/gpt-oss-120b:free',
    'Fresh OpenCode Agent Teams gauntlet passed direct reply but timed out on peer relay and later Agent Teams stages.',
  ],
  [
    'openrouter/google/gemma-4-26b-a4b-it:free',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness during model verification.',
  ],
  [
    'openrouter/google/gemma-4-31b-it:free',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness during model verification.',
  ],
  [
    'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
    'Fresh OpenCode Agent Teams gauntlet passed direct reply but failed peer relay and later Agent Teams stages.',
  ],
  [
    'openrouter/nvidia/nemotron-3-nano-30b-a3b:free',
    'Fresh OpenCode Agent Teams gauntlet passed direct reply but failed peer relay and later Agent Teams stages.',
  ],
  [
    'openrouter/nvidia/nemotron-nano-12b-v2-vl:free',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because model verification timed out.',
  ],
  [
    'openrouter/nvidia/nemotron-nano-9b-v2:free',
    'Fresh OpenCode Agent Teams gauntlet passed direct reply but failed peer relay through OpenCode tool usage.',
  ],
  [
    'openrouter/google/gemma-3-12b-it',
    'Fresh OpenCode Agent Teams gauntlet launched but timed out already on direct reply.',
  ],
  [
    'openrouter/openai/gpt-oss-safeguard-20b',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/google/gemini-2.5-flash-lite-preview-09-2025',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
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
  [
    'openrouter/z-ai/glm-4.5',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because production Agent Teams prompts exceeded the route/key token allowance.',
  ],
  [
    'openrouter/z-ai/glm-5-turbo',
    'Real OpenCode Agent Teams gauntlet passed direct reply but failed peer relay and concurrent delivery.',
  ],
  [
    'openrouter/qwen/qwen3.5-flash-02-23',
    'Real OpenCode Agent Teams gauntlet completed the flow but failed duplicate-token correctness.',
  ],
  [
    'openrouter/qwen/qwen3-coder-flash',
    'Fresh OpenCode Agent Teams gauntlet passed direct and first relay, then failed chained and concurrent reply flow.',
  ],
  [
    'openrouter/qwen/qwen3-coder',
    'Fresh OpenCode Agent Teams gauntlet failed concurrent delivery, taskRefs, and protocol cleanliness.',
  ],
  [
    'openrouter/qwen/qwen3.6-plus',
    'Real OpenCode Agent Teams gauntlet completed most stages but failed taskRefs and duplicate-token correctness.',
  ],
  [
    'openrouter/qwen/qwen3.5-plus-02-15',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/qwen/qwen3.5-397b-a17b',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/qwen/qwen3-30b-a3b-instruct-2507',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/qwen/qwen3-30b-a3b-thinking-2507',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/inception/mercury-2',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because production Agent Teams prompts exceeded the route/key token allowance.',
  ],
  [
    'openrouter/prime-intellect/intellect-3',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because production Agent Teams prompts exceeded the route/key token allowance.',
  ],
  [
    'openrouter/openai/gpt-4.1-mini',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because production Agent Teams prompts exceeded the route/key token allowance.',
  ],
  [
    'openrouter/openai/o4-mini',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance even at the reduced verification cap.',
  ],
  [
    'openrouter/arcee-ai/trinity-large-thinking',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because production Agent Teams prompts exceeded the route/key token allowance.',
  ],
  [
    'openrouter/qwen/qwen3-235b-a22b-thinking-2507',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because production Agent Teams prompts exceeded the route/key token allowance.',
  ],
  [
    'openrouter/xiaomi/mimo-v2-omni',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because production Agent Teams prompts exceeded the route/key token allowance.',
  ],
  [
    'openrouter/deepseek/deepseek-r1',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because production Agent Teams prompts exceeded the route/key token allowance.',
  ],
  [
    'openrouter/openai/gpt-4.1',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance even at the reduced verification cap.',
  ],
  [
    'openrouter/openai/gpt-5',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance even at the reduced verification cap.',
  ],
  [
    'openrouter/openai/gpt-5.1-codex-max',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/openai/gpt-5.2-chat',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/x-ai/grok-3',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/anthropic/claude-sonnet-4',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/x-ai/grok-3-beta',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/anthropic/claude-opus-4.1',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/anthropic/claude-opus-4',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/openai/gpt-5-pro',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/openai/gpt-5.2-pro',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/openai/gpt-5.4-pro',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/liquid/lfm-2.5-1.2b-thinking:free',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because OpenRouter reported no tool-use endpoint for this free route.',
  ],
  [
    'openrouter/liquid/lfm-2.5-1.2b-instruct:free',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because OpenRouter reported no tool-use endpoint for this free route.',
  ],
  [
    'openrouter/google/gemma-3-4b-it:free',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because OpenRouter reported no tool-use endpoint for this free route.',
  ],
  [
    'openrouter/meta-llama/llama-3.2-3b-instruct:free',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because OpenRouter reported no tool-use endpoint for this free route.',
  ],
  [
    'openrouter/google/gemma-3-27b-it:free',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because OpenRouter reported no tool-use endpoint for this free route.',
  ],
  [
    'openrouter/nousresearch/hermes-3-llama-3.1-405b:free',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because OpenRouter reported no tool-use endpoint for this free route.',
  ],
  [
    'openrouter/google/gemma-3-4b-it',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because OpenRouter reported no tool-use endpoint for this route.',
  ],
  [
    'openrouter/cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because OpenRouter reported no tool-use endpoint for this free route.',
  ],
  [
    'openrouter/google/gemma-3-12b-it:free',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because OpenRouter reported no tool-use endpoint for this free route.',
  ],
  [
    'openrouter/meta-llama/llama-3.2-11b-vision-instruct',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because OpenRouter reported no tool-use endpoint for this route.',
  ],
  [
    'openrouter/qwen/qwen2.5-vl-72b-instruct',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because OpenRouter reported no tool-use endpoint for this route.',
  ],
  [
    'openrouter/deepseek/deepseek-r1-distill-llama-70b',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because OpenRouter reported no tool-use endpoint for this route.',
  ],
  [
    'openrouter/z-ai/glm-4.5v',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because production Agent Teams prompts exceeded the route/key token allowance.',
  ],
  [
    'openrouter/qwen/qwen3-max',
    'Fresh OpenCode Agent Teams gauntlet passed direct and peer relays but failed concurrent delivery, taskRefs, and duplicate-token correctness.',
  ],
  [
    'openrouter/xiaomi/mimo-v2-flash',
    'Real OpenCode Agent Teams gauntlet failed concurrent reply delivery and taskRefs for one teammate.',
  ],
  [
    'openrouter/mistralai/mistral-small-2603',
    'Real OpenCode Agent Teams gauntlet passed direct and first relay but failed chained/concurrent relay.',
  ],
  [
    'openrouter/deepseek/deepseek-v4-pro',
    'Real OpenCode Agent Teams gauntlet passed direct reply but timed out on peer relay and concurrent delivery.',
  ],
  [
    'openrouter/x-ai/grok-4',
    'Real OpenCode Agent Teams gauntlet passed direct reply but failed peer relay with an empty assistant turn.',
  ],
  [
    'openrouter/google/gemini-2.0-flash-001',
    'Real OpenCode Agent Teams gauntlet passed direct and first relay but failed chained/concurrent relay.',
  ],
  [
    'openrouter/google/gemma-3n-e4b-it',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because OpenRouter reported no tool-use endpoint for this route.',
  ],
  [
    'openrouter/google/gemma-3n-e2b-it:free',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because OpenRouter reported no tool-use endpoint for this free route.',
  ],
  [
    'openrouter/deepseek/deepseek-chat-v3.1',
    'Real OpenCode Agent Teams gauntlet failed concurrent replies, taskRefs, and duplicate-token correctness.',
  ],
  [
    'openrouter/z-ai/glm-4.5-air',
    'Real OpenCode Agent Teams gauntlet passed direct reply but failed peer relay through OpenCode tool handling.',
  ],
  [
    'openrouter/anthropic/claude-sonnet-4.5',
    'Fresh OpenCode Agent Teams gauntlet hit concurrent reply, taskRefs, and protocol failure; keep below Tested until rerun passes.',
  ],
  [
    'openrouter/anthropic/claude-opus-4.5',
    'Fresh OpenCode Agent Teams gauntlet hit concurrent reply, taskRefs, and protocol failure; keep below Tested until rerun passes.',
  ],
  [
    'openrouter/anthropic/claude-3.5-haiku',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because production Agent Teams prompts exceeded the route/key token allowance.',
  ],
  [
    'openrouter/anthropic/claude-3.7-sonnet',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/mistralai/mistral-medium-3',
    'Real OpenCode Agent Teams gauntlet timed out already on direct reply.',
  ],
  [
    'openrouter/mistralai/mistral-medium-3.1',
    'Fresh OpenCode Agent Teams gauntlet passed direct reply but timed out on peer relay and later Agent Teams stages.',
  ],
  [
    'openrouter/mistralai/devstral-2512',
    'Fresh OpenCode Agent Teams gauntlet failed OpenCode launch readiness.',
  ],
  [
    'openrouter/x-ai/grok-3-mini',
    'Real OpenCode Agent Teams gauntlet passed direct reply but failed peer relay and concurrent delivery.',
  ],
  [
    'openrouter/x-ai/grok-3-mini-beta',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/qwen/qwen3-next-80b-a3b-instruct',
    'Real OpenCode Agent Teams gauntlet passed direct reply but timed out on peer relay through OpenCode.',
  ],
  [
    'openrouter/z-ai/glm-4.6',
    'Fresh OpenCode Agent Teams gauntlet regressed versus older smoke: direct reply passed, but peer relay failed.',
  ],
  [
    'openrouter/openai/gpt-oss-120b',
    'Real OpenCode Agent Teams gauntlet passed direct and first relay but failed chained relay, concurrent delivery, transcript hygiene, and duplicate-token correctness.',
  ],
  [
    'openrouter/qwen/qwen3-coder-30b-a3b-instruct',
    'Real OpenCode Agent Teams gauntlet passed direct and peer relays but failed concurrent delivery, taskRefs, and duplicate-token correctness.',
  ],
  [
    'openrouter/qwen/qwen-2.5-coder-32b-instruct',
    'Fresh OpenCode Agent Teams gauntlet failed launch readiness because OpenRouter reported no tool-use endpoint for this route.',
  ],
  [
    'openrouter/x-ai/grok-4-fast',
    'Fresh OpenCode Agent Teams gauntlet passed direct and peer relays but failed concurrent delivery, taskRefs, transcript hygiene, and duplicate-token correctness.',
  ],
  [
    'openrouter/openai/gpt-5.4-nano',
    'Real OpenCode Agent Teams gauntlet passed direct and peer relays but failed concurrent delivery, taskRefs, and duplicate-token correctness.',
  ],
  [
    'openrouter/nvidia/nemotron-3-super-120b-a12b',
    'Real OpenCode Agent Teams gauntlet passed direct reply but failed peer relay, concurrent delivery, transcript hygiene, and latency stability.',
  ],
  [
    'openrouter/mistralai/mistral-small-3.2-24b-instruct',
    'Real OpenCode Agent Teams gauntlet passed direct and peer relays but failed concurrent delivery, taskRefs, and duplicate-token correctness.',
  ],
  [
    'openrouter/google/gemma-4-31b-it',
    'Real OpenCode Agent Teams gauntlet launched but timed out already on direct reply.',
  ],
  [
    'openrouter/openai/gpt-oss-20b',
    'Real OpenCode Agent Teams gauntlet launched but timed out already on direct reply.',
  ],
  [
    'openrouter/google/gemma-3-27b-it',
    'Real OpenCode Agent Teams gauntlet launched but timed out already on direct reply.',
  ],
  [
    'openrouter/openai/gpt-4o-mini',
    'Fresh OpenCode Agent Teams gauntlet passed direct and peer relays but failed concurrent delivery, taskRefs, and duplicate-token correctness.',
  ],
  [
    'openrouter/deepseek/deepseek-chat-v3-0324',
    'Real OpenCode Agent Teams gauntlet passed direct reply but failed peer relay, concurrent delivery, transcript hygiene, and latency stability.',
  ],
  [
    'openrouter/deepseek/deepseek-v3.1-terminus',
    'Fresh OpenCode Agent Teams gauntlet was blocked during launch by OpenRouter key/max_tokens allowance under production Agent Teams prompts.',
  ],
  [
    'openrouter/qwen/qwen3-next-80b-a3b-thinking',
    'Real OpenCode Agent Teams gauntlet launched but timed out already on direct reply.',
  ],
  [
    'openrouter/nvidia/nemotron-nano-9b-v2',
    'Real OpenCode Agent Teams gauntlet passed direct reply but failed peer relay, concurrent delivery, transcript hygiene, and latency stability.',
  ],
]);

function normalizeOpenCodeTeamModelId(modelId: string | null | undefined): string {
  return modelId?.trim().toLowerCase() ?? '';
}

function isOpenCodeProviderAllowanceReason(reason: string): boolean {
  return /(?:allowance|max_tokens|max-token)/i.test(reason);
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
      reason: PASSED_GAUNTLET_REAL_AGENT_TEAMS_E2E_REASON,
    };
  }

  if (OPENCODE_TEAM_RECOMMENDED_WITH_LIMITS_MODELS.has(normalizedModelId)) {
    return {
      level: 'recommended-with-limits',
      label: 'Recommended with limits',
      reason: PASSED_GAUNTLET_WITH_LIMITS_REASON,
    };
  }

  if (OPENCODE_TEAM_TESTED_MODELS.has(normalizedModelId)) {
    return {
      level: 'tested',
      label: 'Tested',
      reason: PASSED_REAL_AGENT_TEAMS_E2E_REASON,
    };
  }

  if (OPENCODE_TEAM_TESTED_WITH_LIMITS_MODELS.has(normalizedModelId)) {
    return {
      level: 'tested-with-limits',
      label: 'Tested with limits',
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
    if (isOpenCodeProviderAllowanceReason(notRecommendedReason)) {
      return null;
    }

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
  if (recommendation?.level === 'tested') {
    return 2;
  }
  if (recommendation?.level === 'tested-with-limits') {
    return 3;
  }
  if (recommendation?.level === 'unavailable-in-opencode') {
    return 5;
  }
  if (recommendation?.level === 'not-recommended') {
    return 6;
  }
  return 4;
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
