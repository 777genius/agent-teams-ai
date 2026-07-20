import { describe, expect, it } from 'vitest';

import { resolveOpenCodeQuickConnectGate } from './runtimeProviderQuickConnect';

import type { OpenCodeRuntimeStatus } from '@shared/types';

function runtimeStatus(state: OpenCodeRuntimeStatus['state']): OpenCodeRuntimeStatus {
  return {
    installed: false,
    source: 'missing',
    state,
  };
}

describe('resolveOpenCodeQuickConnectGate', () => {
  it.each(['downloading', 'installing'] as const)(
    'keeps concrete %s progress visible while the runtime request is pending',
    (state) => {
      expect(
        resolveOpenCodeQuickConnectGate({
          runtimeStatus: runtimeStatus(state),
          runtimeStatusLoading: true,
          provider: null,
          cliStatusLoading: false,
        })
      ).toBe('installing');
    }
  );

  it('surfaces a concrete runtime failure while the request flag is still pending', () => {
    expect(
      resolveOpenCodeQuickConnectGate({
        runtimeStatus: runtimeStatus('failed'),
        runtimeStatusLoading: true,
        provider: null,
        cliStatusLoading: false,
      })
    ).toBe('error');
  });

  it('keeps a usable installed runtime ready when only its update failed', () => {
    expect(
      resolveOpenCodeQuickConnectGate({
        runtimeStatus: {
          installed: true,
          source: 'app-managed',
          state: 'failed',
          version: '1.18.3',
          error: 'registry unavailable',
        },
        runtimeStatusLoading: false,
        provider: null,
        cliStatusLoading: false,
      })
    ).toBe('ready');
  });

  it('keeps an installed runtime ready during a background status refresh', () => {
    expect(
      resolveOpenCodeQuickConnectGate({
        runtimeStatus: {
          ...runtimeStatus('ready'),
          installed: true,
          source: 'app-managed',
          version: '1.18.3',
        },
        runtimeStatusLoading: true,
        provider: null,
        cliStatusLoading: false,
      })
    ).toBe('ready');
  });

  it('requires an OpenCode update before loading provider and model catalogs', () => {
    expect(
      resolveOpenCodeQuickConnectGate({
        runtimeStatus: {
          installed: true,
          source: 'path',
          state: 'ready',
          version: '1.15.6',
        },
        runtimeStatusLoading: false,
        provider: null,
        cliStatusLoading: false,
      })
    ).toBe('missing');
  });
});
