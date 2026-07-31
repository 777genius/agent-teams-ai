import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetShortLivedProviderPrepareCacheForTests,
  getShortLivedProviderPrepareModelIssueReasons,
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
    expect(
      getShortLivedProviderPrepareModelIssueReasons({
        providerId: 'opencode',
        cacheKey: 'key-1',
      })
    ).toEqual({
      modelAdvisoryReasonByValue: {
        'opencode/nemotron-3-super-free': 'timed out',
      },
      modelIssueReasonByValue: {},
      modelUnavailableReasonByValue: {},
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

  it('stores short-lived OpenCode failed model results as blocking unavailable issues', () => {
    storeShortLivedProviderPrepareModelResults({
      providerId: 'opencode',
      cacheKey: 'key-4',
      modelResultsById: {
        'openai/gpt-5.4': {
          status: 'failed',
          line: 'GPT-5.4 - unavailable - OpenCode provider authentication failed',
          warningLine: null,
        },
      },
    });

    expect(
      getShortLivedProviderPrepareModelResults({
        providerId: 'opencode',
        cacheKey: 'key-4',
      })
    ).toEqual({});
    expect(
      getShortLivedProviderPrepareModelIssueReasons({
        providerId: 'opencode',
        cacheKey: 'key-4',
      })
    ).toEqual({
      modelAdvisoryReasonByValue: {},
      modelIssueReasonByValue: {},
      modelUnavailableReasonByValue: {
        'openai/gpt-5.4': 'OpenCode provider authentication failed',
      },
    });
  });

  it('clears a short-lived issue when a later result verifies the same model', () => {
    storeShortLivedProviderPrepareModelResults({
      providerId: 'opencode',
      cacheKey: 'key-5',
      modelResultsById: {
        'openai/gpt-5.4': {
          status: 'failed',
          line: 'GPT-5.4 - unavailable - OpenCode provider authentication failed',
          warningLine: null,
        },
      },
    });
    storeShortLivedProviderPrepareModelResults({
      providerId: 'opencode',
      cacheKey: 'key-5',
      modelResultsById: {
        'openai/gpt-5.4': {
          status: 'ready',
          line: 'GPT-5.4 - verified',
          warningLine: null,
        },
      },
    });

    expect(
      getShortLivedProviderPrepareModelIssueReasons({
        providerId: 'opencode',
        cacheKey: 'key-5',
      })
    ).toEqual({
      modelAdvisoryReasonByValue: {},
      modelIssueReasonByValue: {},
      modelUnavailableReasonByValue: {},
    });
  });

  it('clears a short-lived successful result when a later advisory targets the same model', () => {
    storeShortLivedProviderPrepareModelResults({
      providerId: 'opencode',
      cacheKey: 'key-7',
      modelResultsById: {
        'openai/gpt-5.4': {
          status: 'ready',
          line: 'GPT-5.4 - verified',
          warningLine: null,
        },
      },
    });
    storeShortLivedProviderPrepareModelResults({
      providerId: 'opencode',
      cacheKey: 'key-7',
      modelResultsById: {
        'openai/gpt-5.4': {
          status: 'notes',
          line: 'GPT-5.4 - check failed - Model verification timed out',
          warningLine: 'GPT-5.4 - check failed - Model verification timed out',
        },
      },
    });

    expect(
      getShortLivedProviderPrepareModelResults({
        providerId: 'opencode',
        cacheKey: 'key-7',
      })
    ).toEqual({});
    expect(
      getShortLivedProviderPrepareModelIssueReasons({
        providerId: 'opencode',
        cacheKey: 'key-7',
      })
    ).toEqual({
      modelAdvisoryReasonByValue: {
        'openai/gpt-5.4': 'Model verification timed out',
      },
      modelIssueReasonByValue: {},
      modelUnavailableReasonByValue: {},
    });
  });

  it('clears a short-lived successful result when a later failure targets the same model', () => {
    storeShortLivedProviderPrepareModelResults({
      providerId: 'opencode',
      cacheKey: 'key-8',
      modelResultsById: {
        'openai/gpt-5.4': {
          status: 'ready',
          line: 'GPT-5.4 - verified',
          warningLine: null,
        },
      },
    });
    storeShortLivedProviderPrepareModelResults({
      providerId: 'opencode',
      cacheKey: 'key-8',
      modelResultsById: {
        'openai/gpt-5.4': {
          status: 'failed',
          line: 'GPT-5.4 - unavailable - OpenCode provider authentication failed',
          warningLine: null,
        },
      },
    });

    expect(
      getShortLivedProviderPrepareModelResults({
        providerId: 'opencode',
        cacheKey: 'key-8',
      })
    ).toEqual({});
    expect(
      getShortLivedProviderPrepareModelIssueReasons({
        providerId: 'opencode',
        cacheKey: 'key-8',
      })
    ).toEqual({
      modelAdvisoryReasonByValue: {},
      modelIssueReasonByValue: {},
      modelUnavailableReasonByValue: {
        'openai/gpt-5.4': 'OpenCode provider authentication failed',
      },
    });
  });

  it('expires short-lived OpenCode issues after the issue TTL', () => {
    vi.useFakeTimers();
    storeShortLivedProviderPrepareModelResults({
      providerId: 'opencode',
      cacheKey: 'key-6',
      modelResultsById: {
        'openai/gpt-5.4': {
          status: 'failed',
          line: 'GPT-5.4 - unavailable - OpenCode provider authentication failed',
          warningLine: null,
        },
      },
    });

    vi.advanceTimersByTime(90_001);

    expect(
      getShortLivedProviderPrepareModelIssueReasons({
        providerId: 'opencode',
        cacheKey: 'key-6',
      })
    ).toEqual({
      modelAdvisoryReasonByValue: {},
      modelIssueReasonByValue: {},
      modelUnavailableReasonByValue: {},
    });
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
    expect(
      getShortLivedProviderPrepareModelIssueReasons({
        providerId: 'codex',
        cacheKey: 'key-3',
      })
    ).toEqual({
      modelAdvisoryReasonByValue: {},
      modelIssueReasonByValue: {},
      modelUnavailableReasonByValue: {},
    });
  });
});
