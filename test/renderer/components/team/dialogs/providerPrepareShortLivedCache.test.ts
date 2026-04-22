import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetShortLivedProviderPrepareCacheForTests,
  getShortLivedProviderPrepareModelResults,
  storeShortLivedProviderPrepareModelResults,
} from '@renderer/components/team/dialogs/providerPrepareShortLivedCache';

describe('providerPrepareShortLivedCache', () => {
  afterEach(() => {
    __resetShortLivedProviderPrepareCacheForTests();
    vi.useRealTimers();
  });

  it('stores only successful OpenCode deep verification results', () => {
    storeShortLivedProviderPrepareModelResults({
      providerId: 'opencode',
      cacheKey: 'key-1',
      modelResultsById: {
        'opencode/minimax-m2.5-free': {
          status: 'ready',
          line: 'minimax-m2.5-free - verified',
          warningLine: null,
        },
        'opencode/nemotron-3-super-free': {
          status: 'notes',
          line: 'nemotron-3-super-free - check failed - timed out',
          warningLine: 'nemotron-3-super-free - check failed - timed out',
        },
      },
    });

    expect(
      getShortLivedProviderPrepareModelResults({
        providerId: 'opencode',
        cacheKey: 'key-1',
      })
    ).toEqual({
      'opencode/minimax-m2.5-free': {
        status: 'ready',
        line: 'minimax-m2.5-free - verified',
        warningLine: null,
      },
    });
  });

  it('expires cached OpenCode results after the short-lived TTL', () => {
    vi.useFakeTimers();
    storeShortLivedProviderPrepareModelResults({
      providerId: 'opencode',
      cacheKey: 'key-2',
      modelResultsById: {
        'opencode/minimax-m2.5-free': {
          status: 'ready',
          line: 'minimax-m2.5-free - verified',
          warningLine: null,
        },
      },
    });

    vi.advanceTimersByTime(45_001);

    expect(
      getShortLivedProviderPrepareModelResults({
        providerId: 'opencode',
        cacheKey: 'key-2',
      })
    ).toEqual({});
  });

  it('does not store short-lived cache for non-OpenCode providers', () => {
    storeShortLivedProviderPrepareModelResults({
      providerId: 'codex',
      cacheKey: 'key-3',
      modelResultsById: {
        'gpt-5.4': {
          status: 'ready',
          line: '5.4 - verified',
          warningLine: null,
        },
      },
    });

    expect(
      getShortLivedProviderPrepareModelResults({
        providerId: 'codex',
        cacheKey: 'key-3',
      })
    ).toEqual({});
  });
});
