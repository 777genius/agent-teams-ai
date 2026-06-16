import { describe, expect, it } from 'vitest';

import { deriveContextMetrics, inferContextWindowTokens } from '../contextMetrics';

describe('contextMetrics', () => {
  it('derives exact Anthropic prompt and context usage', () => {
    const metrics = deriveContextMetrics({
      providerId: 'anthropic',
      modelName: 'claude-sonnet-4-5-20250929',
      usage: {
        input_tokens: 1_200,
        cache_creation_input_tokens: 400,
        cache_read_input_tokens: 600,
        output_tokens: 200,
      },
      visibleContextTokens: 550,
    });

    expect(metrics.contextWindowTokens).toBe(200_000);
    expect(metrics.promptInputTokens).toBe(2_200);
    expect(metrics.contextUsedTokens).toBe(2_400);
    expect(metrics.promptInputSource).toBe('anthropic_usage');
    expect(metrics.contextUsedPercentOfContextWindow).toBeCloseTo(1.2);
    expect(metrics.visibleContextPercentOfPromptInput).toBeCloseTo(25);
  });

  it('derives exact OpenAI Responses usage', () => {
    const metrics = deriveContextMetrics({
      modelName: 'gpt-5.4',
      usage: {
        input_tokens: 5_000,
        output_tokens: 250,
      },
      visibleContextTokens: 900,
    });

    expect(metrics.contextWindowTokens).toBe(1_050_000);
    expect(metrics.promptInputTokens).toBe(5_000);
    expect(metrics.contextUsedTokens).toBe(5_250);
    expect(metrics.promptInputSource).toBe('openai_responses_usage');
    expect(metrics.promptInputPercentOfContextWindow).toBeCloseTo(0.47619, 4);
  });

  it('derives exact OpenAI chat usage without double-counting cache or reasoning breakdowns', () => {
    const metrics = deriveContextMetrics({
      providerId: 'codex',
      modelName: 'gpt-5.4',
      usage: {
        prompt_tokens: 2_006,
        completion_tokens: 300,
        prompt_tokens_details: {
          cached_tokens: 1_920,
        },
        completion_tokens_details: {
          reasoning_tokens: 120,
        },
      },
      visibleContextTokens: 900,
    });

    expect(metrics.contextWindowTokens).toBe(1_050_000);
    expect(metrics.promptInputTokens).toBe(2_006);
    expect(metrics.outputTokens).toBe(300);
    expect(metrics.contextUsedTokens).toBe(2_306);
    expect(metrics.promptInputSource).toBe('openai_chat_usage');
  });

  it('does not double-count OpenAI cached-token breakdowns in Responses usage', () => {
    const metrics = deriveContextMetrics({
      providerId: 'codex',
      modelName: 'gpt-5.2-codex',
      usage: {
        input_tokens: 7_500,
        output_tokens: 120,
        input_tokens_details: {
          cached_tokens: 7_168,
        },
        output_tokens_details: {
          reasoning_tokens: 80,
        },
      },
    });

    expect(metrics.contextWindowTokens).toBe(400_000);
    expect(metrics.promptInputTokens).toBe(7_500);
    expect(metrics.outputTokens).toBe(120);
    expect(metrics.contextUsedTokens).toBe(7_620);
    expect(metrics.promptInputSource).toBe('openai_responses_usage');
  });

  it('marks Codex prompt-side usage unavailable when telemetry reports fake zeros', () => {
    const metrics = deriveContextMetrics({
      providerId: 'codex',
      modelName: 'gpt-5.4-mini',
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 35,
      },
      visibleContextTokens: 700,
    });

    expect(metrics.contextWindowTokens).toBe(400_000);
    expect(metrics.promptInputTokens).toBeNull();
    expect(metrics.contextUsedTokens).toBeNull();
    expect(metrics.promptInputSource).toBe('unavailable');
    expect(metrics.visibleContextPercentOfPromptInput).toBeNull();
  });

  it('infers Anthropic native 1M windows from current raw model ids', () => {
    expect(
      inferContextWindowTokens({
        providerId: 'anthropic',
        modelName: 'claude-opus-4-8',
      })
    ).toBe(1_000_000);
    expect(
      inferContextWindowTokens({
        providerId: 'anthropic',
        modelName: 'claude-opus-4-7',
      })
    ).toBe(1_000_000);
    expect(
      inferContextWindowTokens({
        providerId: 'anthropic',
        modelName: 'claude-opus-4-6',
      })
    ).toBe(1_000_000);
    expect(
      inferContextWindowTokens({
        providerId: 'anthropic',
        modelName: 'claude-sonnet-4-6',
      })
    ).toBe(1_000_000);
    expect(
      inferContextWindowTokens({
        providerId: 'anthropic',
        modelName: 'claude-opus-4-9',
      })
    ).toBe(1_000_000);
  });

  it('keeps older raw Anthropic models at 200K unless 1M is explicitly requested', () => {
    expect(
      inferContextWindowTokens({
        providerId: 'anthropic',
        modelName: 'claude-sonnet-4-5-20250929',
      })
    ).toBe(200_000);
    expect(
      inferContextWindowTokens({
        providerId: 'anthropic',
        modelName: 'claude-opus-4-20250514',
      })
    ).toBe(200_000);
    expect(
      inferContextWindowTokens({
        providerId: 'anthropic',
        modelName: 'opus[1m]',
      })
    ).toBe(1_000_000);
    expect(
      inferContextWindowTokens({
        providerId: 'anthropic',
        modelName: 'claude-sonnet-4-5-20250929[1m]',
      })
    ).toBe(1_000_000);
  });

  it('respects limitContext for Anthropic even when the raw model supports 1M', () => {
    expect(
      inferContextWindowTokens({
        providerId: 'anthropic',
        modelName: 'claude-opus-4-6',
        limitContext: true,
      })
    ).toBe(200_000);
  });

  it('infers Anthropic correctly from 1M aliases even when providerId is omitted', () => {
    const metrics = deriveContextMetrics({
      modelName: 'opus[1m]',
      usage: {
        input_tokens: 1_500,
        output_tokens: 100,
      },
    });

    expect(metrics.providerId).toBe('anthropic');
    expect(metrics.contextWindowTokens).toBe(1_000_000);
    expect(metrics.promptInputTokens).toBe(1_500);
    expect(metrics.contextUsedTokens).toBe(1_600);
    expect(metrics.promptInputSource).toBe('anthropic_usage');
  });

  it('supports Codex/OpenAI model-specific context windows', () => {
    expect(
      inferContextWindowTokens({
        providerId: 'codex',
        modelName: 'gpt-5.4-pro',
      })
    ).toBe(1_050_000);
    expect(
      inferContextWindowTokens({
        providerId: 'codex',
        modelName: 'gpt-5.4-mini',
      })
    ).toBe(400_000);
    expect(
      inferContextWindowTokens({
        providerId: 'codex',
        modelName: 'codex-mini-latest',
      })
    ).toBe(200_000);
  });

  it('covers the current team Codex model matrix with documented context windows', () => {
    expect(
      inferContextWindowTokens({
        providerId: 'codex',
        modelName: 'gpt-5.4-mini',
      })
    ).toBe(400_000);
    expect(
      inferContextWindowTokens({
        providerId: 'codex',
        modelName: 'gpt-5.3-codex',
      })
    ).toBe(400_000);
    expect(
      inferContextWindowTokens({
        providerId: 'codex',
        modelName: 'gpt-5.3-codex-spark',
      })
    ).toBe(400_000);
    expect(
      inferContextWindowTokens({
        providerId: 'codex',
        modelName: 'gpt-5.2',
      })
    ).toBe(400_000);
    expect(
      inferContextWindowTokens({
        providerId: 'codex',
        modelName: 'gpt-5.2-codex',
      })
    ).toBe(400_000);
    expect(
      inferContextWindowTokens({
        providerId: 'codex',
        modelName: 'gpt-5.1-codex-mini',
      })
    ).toBe(400_000);
    expect(
      inferContextWindowTokens({
        providerId: 'codex',
        modelName: 'gpt-5.1-codex-max',
      })
    ).toBe(400_000);
  });

  it('prefers an explicit context window override over inferred model defaults', () => {
    const metrics = deriveContextMetrics({
      providerId: 'anthropic',
      modelName: 'claude-opus-4-6',
      contextWindowTokens: 200_000,
      usage: {
        input_tokens: 1_000,
        output_tokens: 100,
      },
    });

    expect(metrics.contextWindowTokens).toBe(200_000);
    expect(metrics.promptInputTokens).toBe(1_000);
    expect(metrics.contextUsedTokens).toBe(1_100);
  });
});
