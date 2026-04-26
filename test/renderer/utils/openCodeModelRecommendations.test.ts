import { describe, expect, it } from 'vitest';

import {
  compareOpenCodeTeamModelRecommendations,
  getOpenCodeTeamModelRecommendation,
  isOpenCodeTeamModelRecommended,
} from '@renderer/utils/openCodeModelRecommendations';

describe('getOpenCodeTeamModelRecommendation', () => {
  it('keeps Claude Sonnet 4.6 as tested while recommendations are disabled', () => {
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/anthropic/claude-sonnet-4.6')
    ).toMatchObject({
      level: 'tested',
      label: 'Tested',
    });
    expect(isOpenCodeTeamModelRecommended('openrouter/anthropic/claude-sonnet-4.6')).toBe(false);
  });

  it('marks models that passed real OpenCode Agent Teams smoke E2E as tested', () => {
    expect(getOpenCodeTeamModelRecommendation('openrouter/mistralai/codestral-2508')).toMatchObject({
      level: 'tested',
      label: 'Tested',
    });
    expect(
      getOpenCodeTeamModelRecommendation(' OPENROUTER/GOOGLE/GEMINI-3-FLASH-PREVIEW ')
    ).toMatchObject({
      level: 'tested',
      label: 'Tested',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/moonshotai/kimi-k2.6')).toMatchObject({
      level: 'tested',
      label: 'Tested',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/z-ai/glm-5.1')).toMatchObject({
      level: 'tested',
      label: 'Tested',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/openai/gpt-5.3-codex')).toMatchObject({
      level: 'tested',
      label: 'Tested',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/openai/gpt-5-nano')).toMatchObject({
      level: 'tested',
      label: 'Tested',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/minimax/minimax-m2')).toMatchObject({
      level: 'tested',
      label: 'Tested',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/google/gemma-4-26b-a4b-it')
    ).toMatchObject({
      level: 'tested',
      label: 'Tested',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/x-ai/grok-4.1-fast')).toMatchObject({
      level: 'tested',
      label: 'Tested',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/google/gemini-3.1-flash-lite-preview')
    ).toMatchObject({
      level: 'tested',
      label: 'Tested',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/z-ai/glm-4.7-flash')).toMatchObject({
      level: 'tested',
      label: 'Tested',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/z-ai/glm-4.7')).toMatchObject({
      level: 'tested',
      label: 'Tested',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/stepfun/step-3.5-flash')).toMatchObject({
      level: 'tested',
      label: 'Tested',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/minimax/minimax-m2.1')).toMatchObject({
      level: 'tested',
      label: 'Tested',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/minimax/minimax-m2.7')).toMatchObject({
      level: 'tested',
      label: 'Tested',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/xiaomi/mimo-v2-pro')).toMatchObject({
      level: 'tested',
      label: 'Tested',
    });
    expect(isOpenCodeTeamModelRecommended('openrouter/mistralai/codestral-2508')).toBe(false);
  });

  it('keeps similarly named models distinct when real E2E disagreed', () => {
    expect(getOpenCodeTeamModelRecommendation('opencode/minimax-m2.5-free')).toMatchObject({
      level: 'tested-with-limits',
      label: 'Tested with limits',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/minimax/minimax-m2.5:free')
    ).toMatchObject({
      level: 'not-recommended',
    });
  });

  it('marks models with real launch or messaging failures as not recommended', () => {
    for (const modelId of [
      'openrouter/openai/gpt-oss-20b:free',
      'openrouter/openai/gpt-oss-120b:free',
      'openrouter/google/gemini-3-pro-preview',
      'openrouter/google/gemini-2.5-flash-lite',
      'openrouter/deepseek/deepseek-v3.2',
      'openrouter/x-ai/grok-code-fast-1',
      'openrouter/openai/gpt-5.1',
      'openrouter/openai/gpt-5.4',
      'openrouter/z-ai/glm-5-turbo',
      'openrouter/qwen/qwen3.6-plus',
      'openrouter/qwen/qwen3-coder-flash',
      'openrouter/qwen/qwen3-coder',
      'openrouter/google/gemini-3.1-pro-preview',
      'openrouter/anthropic/claude-opus-4.6',
      'openrouter/mistralai/mistral-medium-3',
      'openrouter/nvidia/nemotron-nano-9b-v2',
      'openrouter/liquid/lfm-2.5-1.2b-thinking:free',
      'openrouter/deepseek/deepseek-r1-distill-llama-70b',
    ]) {
      expect(getOpenCodeTeamModelRecommendation(modelId)).toMatchObject({
        level: 'not-recommended',
        label: 'Not recommended',
      });
    }
  });

  it('does not mark provider allowance or depleted-credit failures as model verdicts', () => {
    for (const modelId of [
      'openrouter/openai/gpt-5.1-codex-max',
      'openrouter/openai/gpt-5.2-chat',
      'openrouter/x-ai/grok-3',
      'openrouter/anthropic/claude-sonnet-4',
      'openrouter/anthropic/claude-opus-4.1',
      'openrouter/openai/gpt-5-pro',
      'openrouter/openai/gpt-5.2-pro',
      'openrouter/openai/gpt-5.4-pro',
      'openrouter/moonshotai/kimi-k2.5',
      'openrouter/openai/gpt-5-mini',
      'openrouter/google/gemini-2.5-flash-lite-preview-09-2025',
    ]) {
      expect(getOpenCodeTeamModelRecommendation(modelId)).toBeNull();
    }
  });

  it('marks OpenRouter routes missing from the OpenCode catalog as unavailable, not bad', () => {
    expect(getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3-coder-plus')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3-coder-next')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3-coder:free')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3-next-80b-a3b-instruct:free')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/google/gemini-2.0-flash-lite-001')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/openai/gpt-4.1-nano')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/openai/gpt-4o-mini-2024-07-18')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/openai/gpt-4o-mini-search-preview')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen-plus')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen-turbo')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3-235b-a22b-2507')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/deepseek/deepseek-v3.2-exp')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3-32b')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3-14b')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3-8b')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/qwen/qwq-32b')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/deepseek/deepseek-chat')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/mistralai/mistral-nemo')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/mistralai/mistral-small-24b-instruct-2501')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/cohere/command-r7b-12-2024')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/cohere/command-r-08-2024')).toMatchObject(
      {
        level: 'unavailable-in-opencode',
        label: 'Unavailable in OpenCode',
      }
    );
    expect(getOpenCodeTeamModelRecommendation('openrouter/rekaai/reka-flash-3')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/rekaai/reka-edge')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/nvidia/nemotron-3-nano-30b-a3b')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/minimax/minimax-01')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/nvidia/llama-3.3-nemotron-super-49b-v1.5')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3-max-thinking')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/mistralai/mistral-large-2512')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/mistralai/devstral-medium')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/mistralai/devstral-small')).toMatchObject(
      {
        level: 'unavailable-in-opencode',
        label: 'Unavailable in OpenCode',
      }
    );
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/mistralai/ministral-14b-2512')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/mistralai/ministral-8b-2512')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/mistralai/ministral-3b-2512')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/minimax/minimax-m2-her')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/xiaomi/mimo-v2.5')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/xiaomi/mimo-v2.5-pro')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/x-ai/grok-4.20')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/google/gemini-3.1-flash-image-preview')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/z-ai/glm-5v-turbo')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/x-ai/grok-4.20-multi-agent')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/mistralai/mistral-small-creative')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/openai/gpt-5.3-chat')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/mistralai/voxtral-small-24b-2507')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/openai/gpt-5-chat')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen-2.5-72b-instruct')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/tngtech/deepseek-r1t2-chimera')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/google/gemini-2.5-pro-preview')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/mistralai/mistral-saba')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/mistralai/mistral-large-2411')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3-vl-30b-a3b-instruct')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/inclusionai/ling-2.6-1t:free')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/inclusionai/ling-2.6-flash:free')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/meta-llama/llama-3.1-8b-instruct')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen-2.5-7b-instruct')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/amazon/nova-lite-v1')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/z-ai/glm-4-32b')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/bytedance-seed/seed-1.6-flash')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/meta-llama/llama-4-scout')).toMatchObject(
      {
        level: 'unavailable-in-opencode',
        label: 'Unavailable in OpenCode',
      }
    );
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/meta-llama/llama-3.3-70b-instruct')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/bytedance-seed/seed-2.0-mini')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3-vl-32b-instruct')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/alibaba/tongyi-deepresearch-30b-a3b')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/arcee-ai/trinity-large-preview')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/amazon/nova-micro-v1')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/arcee-ai/trinity-mini')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3.5-9b')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/essentialai/rnj-1-instruct')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/upstage/solar-pro-3')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/allenai/olmo-3.1-32b-instruct')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen-plus-2025-07-28')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/tencent/hy3-preview:free')).toMatchObject(
      {
        level: 'unavailable-in-opencode',
        label: 'Unavailable in OpenCode',
      }
    );
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3-vl-8b-instruct')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/nex-agi/deepseek-v3.1-nex-n1')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/baidu/ernie-4.5-vl-28b-a3b')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/thedrummer/rocinante-12b')).toMatchObject(
      {
        level: 'unavailable-in-opencode',
        label: 'Unavailable in OpenCode',
      }
    );
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/meta-llama/llama-3.1-70b-instruct')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen-plus-2025-07-28:thinking')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/z-ai/glm-4.6v')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/anthropic/claude-3-haiku')).toMatchObject(
      {
        level: 'unavailable-in-opencode',
        label: 'Unavailable in OpenCode',
      }
    );
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/bytedance-seed/seed-2.0-lite')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3-235b-a22b')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3.5-122b-a10b')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/deepseek/deepseek-r1-0528')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/amazon/nova-2-lite-v1')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/openai/o3-mini')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/mistralai/mistral-large-2407')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/thedrummer/unslopnemo-12b')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3-vl-235b-a22b-instruct')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3-vl-8b-thinking')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/kwaipilot/kat-coder-pro-v2')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/openai/o4-mini-high')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/openai/o3-mini-high')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/openai/gpt-4o')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/cohere/command-r-plus-08-2024')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3-vl-30b-a3b-thinking')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/sao10k/l3.1-euryale-70b')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3.5-27b')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/arcee-ai/virtuoso-large')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/openai/gpt-3.5-turbo')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/bytedance-seed/seed-1.6')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/nvidia/llama-3.1-nemotron-70b-instruct')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen-vl-max')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3-vl-235b-a22b-thinking')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/openai/gpt-audio-mini')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/amazon/nova-pro-v1')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/relace/relace-search')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen-max')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/mistralai/pixtral-large-2411')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/mistralai/mixtral-8x22b-instruct')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3.5-35b-a3b')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3-30b-a3b')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/baidu/ernie-4.5-21b-a3b')).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/nousresearch/hermes-4-70b')
    ).toMatchObject({
      level: 'unavailable-in-opencode',
      label: 'Unavailable in OpenCode',
    });
    for (const modelId of [
      'openrouter/openai/gpt-3.5-turbo-16k',
      'openrouter/mistralai/mistral-large',
      'openrouter/openai/o4-mini-deep-research',
      'openrouter/ai21/jamba-large-1.7',
      'openrouter/openai/o3',
      'openrouter/openai/gpt-audio',
      'openrouter/openai/gpt-4o-audio-preview',
      'openrouter/openai/gpt-4o-2024-11-20',
      'openrouter/openai/gpt-4o-2024-08-06',
      'openrouter/amazon/nova-premier-v1',
      'openrouter/anthropic/claude-3.7-sonnet:thinking',
      'openrouter/openai/gpt-4o-2024-05-13',
      'openrouter/~anthropic/claude-opus-latest',
      'openrouter/openai/gpt-4-turbo',
      'openrouter/openai/gpt-4-turbo-preview',
      'openrouter/openai/gpt-4-1106-preview',
      'openrouter/openai/o3-deep-research',
      'openrouter/openai/o1',
      'openrouter/openai/o3-pro',
      'openrouter/anthropic/claude-opus-4.6-fast',
      'openrouter/openai/gpt-5.5-pro',
      'openrouter/openrouter/auto',
      'openrouter/openrouter/pareto-code',
      'openrouter/openrouter/bodybuilder',
      'openrouter/baidu/qianfan-ocr-fast:free',
      'openrouter/google/lyria-3-pro-preview',
      'openrouter/ibm-granite/granite-4.0-h-micro',
      'openrouter/microsoft/phi-4',
      'openrouter/meta-llama/llama-guard-4-12b',
      'openrouter/qwen/qwen-vl-plus',
      'openrouter/deepseek/deepseek-r1-distill-qwen-32b',
      'openrouter/google/lyria-3-clip-preview',
      'openrouter/liquid/lfm-2-24b-a2b',
      'openrouter/meta-llama/llama-3.2-1b-instruct',
      'openrouter/bytedance/ui-tars-1.5-7b',
      'openrouter/baidu/ernie-4.5-21b-a3b-thinking',
      'openrouter/arcee-ai/spotlight',
      'openrouter/meta-llama/llama-3.2-3b-instruct',
      'openrouter/meta-llama/llama-guard-3-8b',
      'openrouter/nousresearch/hermes-3-llama-3.1-70b',
      'openrouter/allenai/olmo-3-32b-think',
      'openrouter/tencent/hunyuan-a13b-instruct',
      'openrouter/meta-llama/llama-4-maverick',
      'openrouter/nvidia/nemotron-nano-12b-v2-vl',
      'openrouter/thedrummer/cydonia-24b-v4.1',
      'openrouter/microsoft/wizardlm-2-8x22b',
      'openrouter/arcee-ai/coder-large',
      'openrouter/thedrummer/skyfall-36b-v2',
      'openrouter/baidu/ernie-4.5-300b-a47b',
      'openrouter/sao10k/l3.3-euryale-70b',
    ]) {
      expect(getOpenCodeTeamModelRecommendation(modelId)).toMatchObject({
        level: 'unavailable-in-opencode',
        label: 'Unavailable in OpenCode',
      });
    }
    expect(isOpenCodeTeamModelRecommended('openrouter/qwen/qwen3-coder-plus')).toBe(false);
  });

  it('does not label noisy or unproven models as good or bad', () => {
    expect(getOpenCodeTeamModelRecommendation('opencode/big-pickle')).toBeNull();
    expect(getOpenCodeTeamModelRecommendation('openrouter/x-ai/grok-4.20-unknown')).toBeNull();
    expect(getOpenCodeTeamModelRecommendation('')).toBeNull();
  });

  it('sorts tested, tested-with-limits, neutral, unavailable, and not-recommended routes by status', () => {
    const models = [
      'openrouter/openai/gpt-oss-20b:free',
      'openrouter/qwen/qwen3-coder-plus',
      'opencode/big-pickle',
      'opencode/minimax-m2.5-free',
      'openrouter/mistralai/codestral-2508',
      'openrouter/anthropic/claude-sonnet-4.6',
    ];

    expect(
      [...models].sort((left, right) => compareOpenCodeTeamModelRecommendations(left, right))
    ).toEqual([
      'openrouter/mistralai/codestral-2508',
      'openrouter/anthropic/claude-sonnet-4.6',
      'opencode/minimax-m2.5-free',
      'opencode/big-pickle',
      'openrouter/qwen/qwen3-coder-plus',
      'openrouter/openai/gpt-oss-20b:free',
    ]);
  });
});
