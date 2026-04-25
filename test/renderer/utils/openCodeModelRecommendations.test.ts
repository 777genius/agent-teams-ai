import { describe, expect, it } from 'vitest';

import {
  compareOpenCodeTeamModelRecommendations,
  getOpenCodeTeamModelRecommendation,
  isOpenCodeTeamModelRecommended,
} from '@renderer/utils/openCodeModelRecommendations';

describe('getOpenCodeTeamModelRecommendation', () => {
  it('marks models that passed real OpenCode Agent Teams E2E as recommended', () => {
    expect(getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3-coder-flash')).toMatchObject({
      level: 'recommended',
      label: 'Recommended',
    });
    expect(
      getOpenCodeTeamModelRecommendation(' OPENROUTER/GOOGLE/GEMINI-3-FLASH-PREVIEW ')
    ).toMatchObject({
      level: 'recommended',
      label: 'Recommended',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/moonshotai/kimi-k2.6')).toMatchObject({
      level: 'recommended',
      label: 'Recommended',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/z-ai/glm-5.1')).toMatchObject({
      level: 'recommended',
      label: 'Recommended',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/z-ai/glm-5')).toMatchObject({
      level: 'recommended',
      label: 'Recommended',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/minimax/minimax-m2.7')).toMatchObject({
      level: 'recommended',
      label: 'Recommended',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/google/gemini-3.1-pro-preview')
    ).toMatchObject({
      level: 'recommended',
      label: 'Recommended',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/anthropic/claude-sonnet-4.6')
    ).toMatchObject({
      level: 'recommended',
      label: 'Recommended',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/anthropic/claude-opus-4.6')).toMatchObject({
      level: 'recommended',
      label: 'Recommended',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/anthropic/claude-opus-4.7')).toMatchObject({
      level: 'recommended',
      label: 'Recommended',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/mistralai/devstral-2512')).toMatchObject({
      level: 'recommended',
      label: 'Recommended',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/openai/gpt-5.4')).toMatchObject({
      level: 'recommended',
      label: 'Recommended',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/openai/gpt-5.3-codex')).toMatchObject({
      level: 'recommended',
      label: 'Recommended',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/x-ai/grok-4-fast')).toMatchObject({
      level: 'recommended',
      label: 'Recommended',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/x-ai/grok-4.1-fast')).toMatchObject({
      level: 'recommended',
      label: 'Recommended',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/xiaomi/mimo-v2-pro')).toMatchObject({
      level: 'recommended',
      label: 'Recommended',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/openai/gpt-5.1-codex')).toMatchObject({
      level: 'recommended',
      label: 'Recommended',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/qwen/qwen3-max')).toMatchObject({
      level: 'recommended',
      label: 'Recommended',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/mistralai/mistral-medium-3.1')
    ).toMatchObject({
      level: 'recommended',
      label: 'Recommended',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/google/gemini-3.1-flash-lite-preview')
    ).toMatchObject({
      level: 'recommended',
      label: 'Recommended',
    });
    expect(isOpenCodeTeamModelRecommended('openrouter/qwen/qwen3-coder-flash')).toBe(true);
  });

  it('keeps similarly named models distinct when real E2E disagreed', () => {
    expect(getOpenCodeTeamModelRecommendation('opencode/minimax-m2.5-free')).toMatchObject({
      level: 'recommended-with-limits',
      label: 'Recommended with limits',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/minimax/minimax-m2.5:free')
    ).toMatchObject({
      level: 'not-recommended',
    });
  });

  it('marks passing free routes as recommended with limits', () => {
    expect(getOpenCodeTeamModelRecommendation('openrouter/openai/gpt-oss-120b:free')).toMatchObject(
      {
        level: 'recommended-with-limits',
        label: 'Recommended with limits',
      }
    );
    expect(isOpenCodeTeamModelRecommended('openrouter/openai/gpt-oss-120b:free')).toBe(true);
  });

  it('marks models with real launch or messaging failures as not recommended', () => {
    expect(getOpenCodeTeamModelRecommendation('openrouter/openai/gpt-oss-20b:free')).toMatchObject({
      level: 'not-recommended',
      label: 'Not recommended',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/google/gemini-3-pro-preview')
    ).toMatchObject({
      level: 'not-recommended',
      label: 'Not recommended',
    });
    expect(
      getOpenCodeTeamModelRecommendation('openrouter/google/gemini-2.5-flash-lite')
    ).toMatchObject({
      level: 'not-recommended',
      label: 'Not recommended',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/deepseek/deepseek-v3.2')).toMatchObject({
      level: 'not-recommended',
      label: 'Not recommended',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/x-ai/grok-code-fast-1')).toMatchObject({
      level: 'not-recommended',
      label: 'Not recommended',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/openai/gpt-5.2-codex')).toMatchObject({
      level: 'not-recommended',
      label: 'Not recommended',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/moonshotai/kimi-k2-thinking')).toMatchObject({
      level: 'not-recommended',
      label: 'Not recommended',
    });
    expect(getOpenCodeTeamModelRecommendation('openrouter/openai/gpt-5.1-chat')).toMatchObject({
      level: 'not-recommended',
      label: 'Not recommended',
    });
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
    expect(getOpenCodeTeamModelRecommendation('openrouter/mistralai/devstral-medium')).toMatchObject(
      {
        level: 'unavailable-in-opencode',
        label: 'Unavailable in OpenCode',
      }
    );
    expect(isOpenCodeTeamModelRecommended('openrouter/qwen/qwen3-coder-plus')).toBe(false);
  });

  it('does not label noisy or unproven models as good or bad', () => {
    expect(getOpenCodeTeamModelRecommendation('opencode/big-pickle')).toBeNull();
    expect(getOpenCodeTeamModelRecommendation('openrouter/x-ai/grok-4.20')).toBeNull();
    expect(getOpenCodeTeamModelRecommendation('')).toBeNull();
  });

  it('sorts recommended, limited, neutral, unavailable, and not-recommended routes by status', () => {
    const models = [
      'openrouter/openai/gpt-oss-20b:free',
      'openrouter/qwen/qwen3-coder-plus',
      'opencode/big-pickle',
      'openrouter/openai/gpt-oss-120b:free',
      'openrouter/qwen/qwen3-coder-flash',
    ];

    expect(
      [...models].sort((left, right) => compareOpenCodeTeamModelRecommendations(left, right))
    ).toEqual([
      'openrouter/qwen/qwen3-coder-flash',
      'openrouter/openai/gpt-oss-120b:free',
      'opencode/big-pickle',
      'openrouter/qwen/qwen3-coder-plus',
      'openrouter/openai/gpt-oss-20b:free',
    ]);
  });
});
