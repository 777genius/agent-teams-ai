import { describe, expect, it } from 'vitest';

import {
  buildLeadContextUsagePayloadForRun,
  buildLeadContextUsagePayloadFromState,
  deriveLeadContextUsageStateFromUsage,
  emitLeadContextUsageForRun,
  getInitialLeadContextWindowTokensForRequest,
  getInitialLeadContextWindowTokensForRun,
  getLeadContextUsageForTeam,
  updateLeadContextUsageFromUsageForRun,
} from '../TeamProvisioningLeadContextUsage';

import type { TeamChangeEvent } from '@shared/types';

describe('lead context usage helpers', () => {
  it('builds an unavailable payload when no usage state exists', () => {
    expect(buildLeadContextUsagePayloadFromState(null, '2026-01-01T00:00:00.000Z')).toEqual({
      promptInputTokens: null,
      outputTokens: null,
      contextUsedTokens: null,
      contextWindowTokens: null,
      contextUsedPercent: null,
      promptInputSource: 'unavailable',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('calculates and clamps context usage percent', () => {
    expect(
      buildLeadContextUsagePayloadFromState(
        {
          promptInputTokens: 100,
          outputTokens: 10,
          contextUsedTokens: 15_000,
          contextWindowTokens: 10_000,
          promptInputSource: 'anthropic_usage',
        },
        '2026-01-01T00:00:00.000Z'
      ).contextUsedPercent
    ).toBe(100);

    expect(
      buildLeadContextUsagePayloadFromState(
        {
          promptInputTokens: 100,
          outputTokens: 10,
          contextUsedTokens: 2_500,
          contextWindowTokens: 10_000,
          promptInputSource: 'anthropic_usage',
        },
        '2026-01-01T00:00:00.000Z'
      ).contextUsedPercent
    ).toBe(25);
  });

  it('infers an Anthropic default context window when model is omitted', () => {
    expect(
      getInitialLeadContextWindowTokensForRequest({
        providerId: 'anthropic',
        limitContext: false,
      })
    ).toBeGreaterThan(0);
  });

  it('infers the initial context window from a run request', () => {
    expect(
      getInitialLeadContextWindowTokensForRun({
        request: {
          providerId: 'anthropic',
          model: 'opus[1m]',
          limitContext: false,
        },
        leadContextUsage: null,
      })
    ).toBe(1_000_000);
  });

  it('builds a run payload using an injectable clock', () => {
    expect(
      buildLeadContextUsagePayloadForRun(
        {
          request: {},
          leadContextUsage: {
            promptInputTokens: 100,
            outputTokens: 25,
            contextUsedTokens: 125,
            contextWindowTokens: 1_000,
            promptInputSource: 'anthropic_usage',
            lastUsageMessageId: 'msg-1',
            lastEmittedAt: 10,
          },
        },
        () => '2026-01-02T00:00:00.000Z'
      )
    ).toMatchObject({
      promptInputTokens: 100,
      outputTokens: 25,
      contextUsedTokens: 125,
      contextWindowTokens: 1_000,
      contextUsedPercent: 13,
      promptInputSource: 'anthropic_usage',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('emits lead context usage for the current completed run', () => {
    const emitted: TeamChangeEvent[] = [];
    const run = {
      teamName: 'team-a',
      runId: 'run-1',
      provisioningComplete: true,
      request: {},
      leadContextUsage: {
        promptInputTokens: 100,
        outputTokens: 25,
        contextUsedTokens: 125,
        contextWindowTokens: 1_000,
        promptInputSource: 'anthropic_usage' as const,
        lastUsageMessageId: 'msg-1',
        lastEmittedAt: 10,
      },
    };

    expect(
      emitLeadContextUsageForRun(
        run,
        {
          isCurrentTrackedRun: () => true,
          nowMs: () => 3_000,
          nowIso: () => '2026-01-03T00:00:00.000Z',
          emitTeamChange: (event) => emitted.push(event),
        },
        2_000
      )
    ).toBe(true);

    expect(run.leadContextUsage.lastEmittedAt).toBe(3_000);
    expect(emitted).toEqual([
      {
        type: 'lead-context',
        teamName: 'team-a',
        runId: 'run-1',
        detail: JSON.stringify({
          promptInputTokens: 100,
          outputTokens: 25,
          contextUsedTokens: 125,
          contextWindowTokens: 1_000,
          contextUsedPercent: 13,
          promptInputSource: 'anthropic_usage',
          updatedAt: '2026-01-03T00:00:00.000Z',
        }),
      },
    ]);
  });

  it('does not emit lead context usage without usage, completion, current run, or throttle clearance', () => {
    const baseRun = {
      teamName: 'team-a',
      runId: 'run-1',
      provisioningComplete: true,
      request: {},
      leadContextUsage: {
        promptInputTokens: 100,
        outputTokens: 25,
        contextUsedTokens: 125,
        contextWindowTokens: 1_000,
        promptInputSource: 'anthropic_usage' as const,
        lastUsageMessageId: 'msg-1',
        lastEmittedAt: 1_500,
      },
    };
    const emitTeamChange = () => {
      throw new Error('unexpected lead-context emission');
    };

    expect(
      emitLeadContextUsageForRun(
        { ...baseRun, leadContextUsage: null },
        {
          isCurrentTrackedRun: () => true,
          nowMs: () => 3_000,
          nowIso: () => '2026-01-03T00:00:00.000Z',
          emitTeamChange,
        },
        2_000
      )
    ).toBe(false);

    expect(
      emitLeadContextUsageForRun(
        { ...baseRun, provisioningComplete: false },
        {
          isCurrentTrackedRun: () => true,
          nowMs: () => 3_000,
          nowIso: () => '2026-01-03T00:00:00.000Z',
          emitTeamChange,
        },
        2_000
      )
    ).toBe(false);

    expect(
      emitLeadContextUsageForRun(
        baseRun,
        {
          isCurrentTrackedRun: () => false,
          nowMs: () => 3_000,
          nowIso: () => '2026-01-03T00:00:00.000Z',
          emitTeamChange,
        },
        2_000
      )
    ).toBe(false);

    expect(
      emitLeadContextUsageForRun(
        baseRun,
        {
          isCurrentTrackedRun: () => true,
          nowMs: () => 3_000,
          nowIso: () => '2026-01-03T00:00:00.000Z',
          emitTeamChange,
        },
        2_000
      )
    ).toBe(false);
  });

  it('returns null usage when there is no tracked run or no usable in-memory usage state', () => {
    expect(
      getLeadContextUsageForTeam('team-a', {
        getTrackedRunId: () => null,
        getRun: () => undefined,
        nowIso: () => '2026-01-02T00:00:00.000Z',
      })
    ).toEqual({ usage: null, runId: null });

    expect(
      getLeadContextUsageForTeam('team-a', {
        getTrackedRunId: () => 'run-1',
        getRun: () => ({
          request: {},
          leadContextUsage: null,
          processKilled: false,
          cancelRequested: false,
        }),
        nowIso: () => '2026-01-02T00:00:00.000Z',
      })
    ).toEqual({ usage: null, runId: null });
  });

  it('returns null usage for killed or cancelled tracked runs', () => {
    const leadContextUsage = {
      promptInputTokens: 100,
      outputTokens: 25,
      contextUsedTokens: 125,
      contextWindowTokens: 1_000,
      promptInputSource: 'anthropic_usage' as const,
      lastUsageMessageId: 'msg-1',
      lastEmittedAt: 10,
    };

    expect(
      getLeadContextUsageForTeam('team-a', {
        getTrackedRunId: () => 'run-1',
        getRun: () => ({
          request: {},
          leadContextUsage,
          processKilled: true,
          cancelRequested: false,
        }),
        nowIso: () => '2026-01-02T00:00:00.000Z',
      })
    ).toEqual({ usage: null, runId: null });

    expect(
      getLeadContextUsageForTeam('team-a', {
        getTrackedRunId: () => 'run-1',
        getRun: () => ({
          request: {},
          leadContextUsage,
          processKilled: false,
          cancelRequested: true,
        }),
        nowIso: () => '2026-01-02T00:00:00.000Z',
      })
    ).toEqual({ usage: null, runId: null });
  });

  it('returns tracked usage with an injectable timestamp', () => {
    expect(
      getLeadContextUsageForTeam('team-a', {
        getTrackedRunId: () => 'run-1',
        getRun: () => ({
          request: {},
          leadContextUsage: {
            promptInputTokens: 100,
            outputTokens: 25,
            contextUsedTokens: 125,
            contextWindowTokens: 1_000,
            promptInputSource: 'anthropic_usage',
            lastUsageMessageId: 'msg-1',
            lastEmittedAt: 10,
          },
          processKilled: false,
          cancelRequested: false,
        }),
        nowIso: () => '2026-01-02T00:00:00.000Z',
      })
    ).toEqual({
      usage: {
        promptInputTokens: 100,
        outputTokens: 25,
        contextUsedTokens: 125,
        contextWindowTokens: 1_000,
        contextUsedPercent: 13,
        promptInputSource: 'anthropic_usage',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      runId: 'run-1',
    });
  });

  it('derives usage state while preserving requested Anthropic context window', () => {
    expect(
      deriveLeadContextUsageStateFromUsage({
        previousUsage: null,
        request: {
          providerId: 'anthropic',
          model: 'opus[1m]',
          limitContext: false,
        },
        usage: {
          input_tokens: 12,
          cache_creation_input_tokens: 34,
          cache_read_input_tokens: 56,
          output_tokens: 7,
        },
        modelName: 'claude-opus-4-6',
      })
    ).toEqual({
      promptInputTokens: 102,
      outputTokens: 7,
      contextUsedTokens: 109,
      contextWindowTokens: 1_000_000,
      promptInputSource: 'anthropic_usage',
      lastUsageMessageId: null,
      lastEmittedAt: 0,
    });
  });

  it('preserves previous context window when new usage cannot infer one', () => {
    expect(
      deriveLeadContextUsageStateFromUsage({
        previousUsage: {
          promptInputTokens: 10,
          outputTokens: 1,
          contextUsedTokens: 11,
          contextWindowTokens: 123_456,
          promptInputSource: 'anthropic_usage',
          lastUsageMessageId: 'msg-1',
          lastEmittedAt: 42,
        },
        request: {},
        usage: {
          input_tokens: 20,
          output_tokens: 2,
        },
        modelName: undefined,
      })
    ).toMatchObject({
      promptInputTokens: 20,
      outputTokens: 2,
      contextUsedTokens: 22,
      contextWindowTokens: 123_456,
      lastUsageMessageId: 'msg-1',
      lastEmittedAt: 42,
    });
  });

  it('updates run usage state from provider usage data', () => {
    const run = {
      request: {
        providerId: 'anthropic',
        model: 'opus[1m]',
        limitContext: false,
      },
      leadContextUsage: null,
    };

    updateLeadContextUsageFromUsageForRun(
      run,
      {
        input_tokens: 12,
        cache_creation_input_tokens: 34,
        cache_read_input_tokens: 56,
        output_tokens: 7,
      },
      'claude-opus-4-6'
    );

    expect(run.leadContextUsage).toMatchObject({
      promptInputTokens: 102,
      outputTokens: 7,
      contextUsedTokens: 109,
      contextWindowTokens: 1_000_000,
      promptInputSource: 'anthropic_usage',
    });
  });
});
