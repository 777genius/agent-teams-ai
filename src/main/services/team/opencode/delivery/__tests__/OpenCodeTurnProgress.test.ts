import { describe, expect, it } from 'vitest';

import {
  hasOpenCodeInferredTurnProgress,
  normalizeOpenCodeTurnUsedTokens,
  type OpenCodeObservedTurnRecord,
  resolveOpenCodeTurnProgress,
} from '../OpenCodeTurnProgress';

import type { OpenCodeDeliveryResponseObservation } from '../../bridge/OpenCodeBridgeCommandContract';

function record(overrides: Partial<OpenCodeObservedTurnRecord> = {}): OpenCodeObservedTurnRecord {
  return {
    observedAssistantMessageId: 'assistant-1',
    observedAssistantPreview: 'Reading the board.',
    observedToolCallNames: ['glob'],
    lastTurnProgressAt: null,
    observedTurnUsedTokens: null,
    ...overrides,
  };
}

function observation(
  overrides: Partial<OpenCodeDeliveryResponseObservation> = {}
): OpenCodeDeliveryResponseObservation {
  return {
    state: 'pending',
    deliveredUserMessageId: 'runtime-prompt-1',
    assistantMessageId: 'assistant-1',
    toolCallNames: ['glob'],
    visibleMessageToolCallId: null,
    visibleReplyMessageId: null,
    visibleReplyCorrelation: null,
    latestAssistantPreview: 'Reading the board.',
    reason: null,
    ...overrides,
  };
}

describe('hasOpenCodeInferredTurnProgress', () => {
  it('reads the same three signals the retry gate infers a live turn from', () => {
    expect(hasOpenCodeInferredTurnProgress(record(), observation())).toBe(false);
    expect(
      hasOpenCodeInferredTurnProgress(record(), observation({ assistantMessageId: 'assistant-2' }))
    ).toBe(true);
    expect(
      hasOpenCodeInferredTurnProgress(record(), observation({ toolCallNames: ['glob', 'read'] }))
    ).toBe(true);
    expect(
      hasOpenCodeInferredTurnProgress(
        record(),
        observation({ latestAssistantPreview: 'Reading the board. Now writing.' })
      )
    ).toBe(true);
  });

  it('needs a previous assistant message id before a changed id counts', () => {
    expect(
      hasOpenCodeInferredTurnProgress(
        record({ observedAssistantMessageId: null }),
        observation({ assistantMessageId: 'assistant-2' })
      )
    ).toBe(false);
  });

  it('does not read a shrinking tool list as progress', () => {
    expect(
      hasOpenCodeInferredTurnProgress(
        record({ observedToolCallNames: ['glob', 'read'] }),
        observation({ toolCallNames: [] })
      )
    ).toBe(false);
  });
});

describe('normalizeOpenCodeTurnUsedTokens', () => {
  it('accepts a finite non-negative count and rejects everything else', () => {
    expect(normalizeOpenCodeTurnUsedTokens(1024)).toBe(1024);
    expect(normalizeOpenCodeTurnUsedTokens(1024.7)).toBe(1024);
    expect(normalizeOpenCodeTurnUsedTokens(0)).toBe(0);
    expect(normalizeOpenCodeTurnUsedTokens(-1)).toBeNull();
    expect(normalizeOpenCodeTurnUsedTokens(Number.NaN)).toBeNull();
    expect(normalizeOpenCodeTurnUsedTokens(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeOpenCodeTurnUsedTokens(null)).toBeNull();
    expect(normalizeOpenCodeTurnUsedTokens(undefined)).toBeNull();
  });
});

describe('resolveOpenCodeTurnProgress', () => {
  const OBSERVED_AT = '2026-04-25T10:05:00.000Z';

  it('stamps progress when the runtime turn spend grows', () => {
    expect(
      resolveOpenCodeTurnProgress(record({ observedTurnUsedTokens: 12_000 }), {
        responseObservation: observation(),
        turnUsedTokens: 12_500,
        observedAt: OBSERVED_AT,
      })
    ).toEqual({ lastTurnProgressAt: OBSERVED_AT, observedTurnUsedTokens: 12_500 });
  });

  // Negative control: the first sample is a baseline and must never count as
  // progress. A lane that stopped an hour ago still reports the tokens its last
  // turn spent, so a single sample proves nothing about this turn.
  it('never treats the first usage sample as progress', () => {
    expect(
      resolveOpenCodeTurnProgress(record({ observedTurnUsedTokens: null }), {
        responseObservation: observation(),
        turnUsedTokens: 183_000,
        observedAt: OBSERVED_AT,
      })
    ).toEqual({ lastTurnProgressAt: null, observedTurnUsedTokens: 183_000 });
  });

  it('does not stamp progress for an unchanged or shrinking turn spend', () => {
    for (const turnUsedTokens of [12_000, 11_000]) {
      expect(
        resolveOpenCodeTurnProgress(record({ observedTurnUsedTokens: 12_000 }), {
          responseObservation: observation(),
          turnUsedTokens,
          observedAt: OBSERVED_AT,
        })
      ).toMatchObject({ lastTurnProgressAt: null });
    }
  });

  it('keeps the previous baseline when this observation carries no sample', () => {
    expect(
      resolveOpenCodeTurnProgress(record({ observedTurnUsedTokens: 12_000 }), {
        responseObservation: observation(),
        observedAt: OBSERVED_AT,
      })
    ).toEqual({ lastTurnProgressAt: null, observedTurnUsedTokens: 12_000 });
  });

  it('keeps the earlier progress stamp when this observation shows none', () => {
    expect(
      resolveOpenCodeTurnProgress(
        record({ lastTurnProgressAt: '2026-04-25T10:04:00.000Z', observedTurnUsedTokens: 12_000 }),
        {
          responseObservation: observation(),
          turnUsedTokens: 12_000,
          observedAt: OBSERVED_AT,
        }
      )
    ).toEqual({
      lastTurnProgressAt: '2026-04-25T10:04:00.000Z',
      observedTurnUsedTokens: 12_000,
    });
  });

  it('stamps progress from the inferred signals without any usage probe', () => {
    expect(
      resolveOpenCodeTurnProgress(record(), {
        responseObservation: observation({ toolCallNames: ['glob', 'read'] }),
        observedAt: OBSERVED_AT,
      })
    ).toEqual({ lastTurnProgressAt: OBSERVED_AT, observedTurnUsedTokens: null });
  });
});
