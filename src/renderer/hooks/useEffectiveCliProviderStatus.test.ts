import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { createLoadingMultimodelCliStatus } from '@renderer/store/slices/cliInstallerSlice';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { useStoreMock } = vi.hoisted(() => ({ useStoreMock: vi.fn() }));

vi.mock('@renderer/store', () => ({ useStore: useStoreMock }));
vi.mock('@features/codex-account/renderer', () => ({
  isCodexAccountSnapshotPending: vi.fn(() => false),
  mergeCodexCliStatusWithSnapshot: vi.fn((status) => status),
  useCodexAccountSnapshot: vi.fn(() => ({
    snapshot: null,
    loading: false,
    error: null,
  })),
}));

import {
  didExactProjectProviderLaunchProofComplete,
  EXACT_PROJECT_PROVIDER_PROOF_RECOVERY_DELAYS_MS,
  EXACT_PROJECT_PROVIDER_PROOF_REFRESH_TIMEOUT_MS,
  EXACT_PROJECT_PROVIDER_PROOF_RETRY_DELAYS_MS,
  isExactProjectProviderLaunchProofCurrent,
  replaceProjectScopedProviderStatus,
  resolveProjectScopedProviderStatus,
  useExactProjectProviderLaunchProof,
} from './useEffectiveCliProviderStatus';

import type { CliInstallationStatus, CliProviderStatus } from '@shared/types';

const authoritativeProvider = (): CliProviderStatus => ({
  ...createLoadingMultimodelCliStatus().providers.find(
    (provider) => provider.providerId === 'opencode'
  )!,
  supported: true,
  authenticated: true,
  authMethod: 'opencode_configured_local',
  verificationState: 'verified',
  statusCheckOutcome: 'authoritative',
  models: ['openai/gpt-test'],
  modelCatalogRefreshState: 'ready',
  modelCatalog: {
    schemaVersion: 1,
    providerId: 'opencode',
    source: 'app-server',
    status: 'ready',
    fetchedAt: '2026-08-20T00:00:00.000Z',
    staleAt: '2099-08-20T00:00:00.000Z',
    defaultModelId: 'openai/gpt-test',
    defaultLaunchModel: 'openai/gpt-test',
    models: [],
    diagnostics: {
      configReadState: 'ready',
      appServerState: 'healthy',
      message: null,
      code: null,
    },
  },
  capabilities: {
    ...createLoadingMultimodelCliStatus().providers.find(
      (provider) => provider.providerId === 'opencode'
    )!.capabilities,
    teamLaunch: true,
  },
});

type ProofSnapshot = ReturnType<typeof useExactProjectProviderLaunchProof>;

const authorityScope = (projectPath: string, providerId: 'opencode' | 'codex' = 'opencode') => ({
  schemaVersion: 1 as const,
  providerId,
  projectPath,
  globalGeneration: 1,
  profileGeneration: 1,
  catalogGeneration: 1,
});

const HookProbe = ({
  projectPath,
  onSnapshot,
  providerIds = ['opencode'],
  renderRevision = 0,
}: {
  projectPath: string;
  onSnapshot: (snapshot: ProofSnapshot) => void;
  providerIds?: readonly ('opencode' | 'codex')[];
  renderRevision?: number;
}): React.JSX.Element | null => {
  const snapshot = useExactProjectProviderLaunchProof(providerIds, projectPath);
  useEffect(() => onSnapshot(snapshot), [onSnapshot, renderRevision, snapshot]);
  return null;
};

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('useExactProjectProviderLaunchProof retry state machine', () => {
  let storeState: {
    cliProviderLaunchProofByScope: Record<string, unknown>;
    cliProviderStatusLoadingByScope: Record<string, boolean>;
    cliProviderStatusScopeRevision: number;
    fetchCliProviderStatus: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState = {
      cliProviderLaunchProofByScope: {},
      cliProviderStatusLoadingByScope: {},
      cliProviderStatusScopeRevision: 0,
      fetchCliProviderStatus: vi.fn(),
    };
    useStoreMock.mockImplementation((selector: (state: typeof storeState) => unknown) =>
      selector(storeState)
    );
    Object.assign(useStoreMock, { getState: () => storeState });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useStoreMock.mockReset();
    Reflect.deleteProperty(useStoreMock, 'getState');
    document.body.innerHTML = '';
  });

  const mountProbe = async (projectPath: string) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const snapshots: ProofSnapshot[] = [];
    const onSnapshot = (snapshot: ProofSnapshot): void => {
      snapshots.push(snapshot);
    };
    await act(async () => {
      root.render(React.createElement(HookProbe, { projectPath, onSnapshot }));
      await flushPromises();
    });
    return { root, snapshots, onSnapshot };
  };

  it.each(['transient failure', 'legacy partial response'])(
    '%s completes the attempt in conservative degraded state instead of loading forever',
    async () => {
      storeState.fetchCliProviderStatus.mockResolvedValue(false);
      const { root, snapshots } = await mountProbe('/project/a');

      const settled = snapshots.at(-1)!;
      expect(settled.providerLoadingById.get('opencode')).toBe(false);
      expect(settled.providerStatusById.get('opencode')).toBeNull();
      expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(1);

      act(() => root.unmount());
    }
  );

  it('treats a legacy proof without main authority generations as display-only', async () => {
    const provider = authoritativeProvider();
    storeState.fetchCliProviderStatus.mockImplementationOnce(async () => {
      storeState.cliProviderLaunchProofByScope['opencode\0/project/a'] = {
        providerStatus: provider,
        epoch: 1,
        requestId: 1,
        fetchedAtMs: Date.now(),
      };
      return true;
    });
    const { root, snapshots } = await mountProbe('/project/a');

    expect(snapshots.at(-1)?.providerStatusById.get('opencode')).toBeNull();
    expect(snapshots.at(-1)?.providerGenerationById.get('opencode')).toBeNull();
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('backs off after a rejected status batch instead of polling or staying degraded forever', async () => {
    storeState.fetchCliProviderStatus.mockRejectedValue(new Error('transport disconnected'));
    const { root, snapshots } = await mountProbe('/project/a');

    expect(snapshots.at(-1)?.providerLoadingById.get('opencode')).toBe(false);
    expect(snapshots.at(-1)?.providerStatusById.get('opencode')).toBeNull();
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(1);

    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXACT_PROJECT_PROVIDER_PROOF_RECOVERY_DELAYS_MS[0] - 1);
    });
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await flushPromises();
    });
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('continues rejected exact renewals indefinitely with bounded 15/30/60 recovery', async () => {
    storeState.fetchCliProviderStatus.mockRejectedValue(new Error('transport disconnected'));
    const { root } = await mountProbe('/project/a');
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(1);

    for (const [delay, expectedCalls] of [
      [EXACT_PROJECT_PROVIDER_PROOF_RECOVERY_DELAYS_MS[0], 2],
      [EXACT_PROJECT_PROVIDER_PROOF_RECOVERY_DELAYS_MS[1], 3],
      [EXACT_PROJECT_PROVIDER_PROOF_RECOVERY_DELAYS_MS[2], 4],
      [EXACT_PROJECT_PROVIDER_PROOF_RECOVERY_DELAYS_MS[2], 5],
    ] as const) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay - 1);
      });
      expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(expectedCalls - 1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
        await flushPromises();
      });
      expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(expectedCalls);
      expect(vi.getTimerCount()).toBe(1);
    }

    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers a rejected expiry renewal with one backed-off replacement request', async () => {
    const provider = authoritativeProvider();
    let requestId = 0;
    storeState.fetchCliProviderStatus
      .mockImplementationOnce(async () => {
        requestId += 1;
        storeState.cliProviderLaunchProofByScope['opencode\0/project/a'] = {
          providerStatus: provider,
          epoch: 9,
          requestId,
          fetchedAtMs: Date.now(),
          authorityScope: authorityScope('/project/a'),
        };
        return true;
      })
      .mockRejectedValueOnce(new Error('renewal transport disconnected'))
      .mockImplementationOnce(async () => {
        requestId += 1;
        storeState.cliProviderLaunchProofByScope['opencode\0/project/a'] = {
          providerStatus: provider,
          epoch: 9,
          requestId,
          fetchedAtMs: Date.now(),
          authorityScope: authorityScope('/project/a'),
        };
        return true;
      });
    const { root, snapshots } = await mountProbe('/project/a');

    expect(snapshots.at(-1)?.providerGenerationById.get('opencode')).toBe('9:1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001);
      await flushPromises();
    });
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(2);
    expect(snapshots.at(-1)?.providerStatusById.get('opencode')).toBeNull();
    expect(snapshots.at(-1)?.providerLoadingById.get('opencode')).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXACT_PROJECT_PROVIDER_PROOF_RECOVERY_DELAYS_MS[0]);
      await flushPromises();
    });
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(3);
    expect(snapshots.at(-1)?.providerGenerationById.get('opencode')).toBe('9:2');
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles a never-resolving refresh as degraded and fences its late completion', async () => {
    let complete: ((value: boolean) => void) | undefined;
    storeState.fetchCliProviderStatus.mockReturnValue(
      new Promise<boolean>((resolve) => {
        complete = resolve;
      })
    );
    const { root, snapshots } = await mountProbe('/project/a');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXACT_PROJECT_PROVIDER_PROOF_REFRESH_TIMEOUT_MS);
      await flushPromises();
    });
    expect(snapshots.at(-1)?.providerLoadingById.get('opencode')).toBe(false);
    expect(snapshots.at(-1)?.providerStatusById.get('opencode')).toBeNull();

    await act(async () => {
      complete?.(true);
      await flushPromises();
    });
    expect(snapshots.at(-1)?.providerStatusById.get('opencode')).toBeNull();
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('isolates a multi-provider recovery from the timed-out attempt epoch', async () => {
    const base = createLoadingMultimodelCliStatus();
    const codex: CliProviderStatus = {
      ...base.providers.find((provider) => provider.providerId === 'codex')!,
      supported: true,
      authenticated: true,
      authMethod: 'codex_chatgpt',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      capabilities: {
        ...base.providers.find((provider) => provider.providerId === 'codex')!.capabilities,
        teamLaunch: true,
      },
      models: ['gpt-project'],
    };
    const requests: Array<{
      providerId: 'opencode' | 'codex';
      requestEpoch: number;
      resolve: (value: boolean) => void;
    }> = [];
    storeState.fetchCliProviderStatus.mockImplementation((providerId, options) => {
      return new Promise<boolean>((resolve) => {
        requests.push({ providerId, requestEpoch: options?.requestEpoch, resolve });
      });
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const snapshots: ProofSnapshot[] = [];
    const onSnapshot = (snapshot: ProofSnapshot): void => {
      snapshots.push(snapshot);
    };

    await act(async () => {
      root.render(
        React.createElement(HookProbe, {
          projectPath: '/project/a',
          providerIds: ['opencode', 'codex'],
          onSnapshot,
        })
      );
      await flushPromises();
    });
    expect(requests).toHaveLength(2);
    const firstEpoch = requests[0]!.requestEpoch;
    expect(requests.map((request) => request.requestEpoch)).toEqual([firstEpoch, firstEpoch]);

    await act(async () => {
      root.render(
        React.createElement(HookProbe, {
          projectPath: '/project/a',
          providerIds: ['codex', 'opencode'],
          onSnapshot,
          renderRevision: 1,
        })
      );
      await flushPromises();
    });
    expect(requests).toHaveLength(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXACT_PROJECT_PROVIDER_PROOF_REFRESH_TIMEOUT_MS);
      await flushPromises();
    });
    expect(requests).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXACT_PROJECT_PROVIDER_PROOF_RECOVERY_DELAYS_MS[0]);
      await flushPromises();
    });
    expect(requests).toHaveLength(4);
    const recoveryEpoch = requests[2]!.requestEpoch;
    expect(recoveryEpoch).not.toBe(firstEpoch);
    expect(requests.slice(2).map((request) => request.requestEpoch)).toEqual([
      recoveryEpoch,
      recoveryEpoch,
    ]);
    for (const index of [0, 1]) {
      const [firstProvider, firstOptions] = storeState.fetchCliProviderStatus.mock.calls[index]!;
      const [recoveryProvider, recoveryOptions] =
        storeState.fetchCliProviderStatus.mock.calls[index + 2]!;
      expect(recoveryProvider).toBe(firstProvider);
      expect({ ...recoveryOptions, requestEpoch: firstOptions.requestEpoch }).toEqual(firstOptions);
    }

    await act(async () => {
      storeState.cliProviderLaunchProofByScope['opencode\0/project/a'] = {
        providerStatus: authoritativeProvider(),
        epoch: 20,
        requestId: 1,
        fetchedAtMs: Date.now(),
        authorityScope: authorityScope('/project/a'),
      };
      storeState.cliProviderLaunchProofByScope['codex\0/project/a'] = {
        providerStatus: codex,
        epoch: 20,
        requestId: 2,
        fetchedAtMs: Date.now(),
        authorityScope: authorityScope('/project/a', 'codex'),
      };
      requests[0]!.resolve(true);
      requests[1]!.resolve(true);
      await flushPromises();
    });
    expect(snapshots.at(-1)?.providerStatusById.get('opencode')).toBeNull();
    expect(snapshots.at(-1)?.providerStatusById.get('codex')).toBeNull();

    await act(async () => {
      storeState.cliProviderLaunchProofByScope['opencode\0/project/a'] = {
        providerStatus: authoritativeProvider(),
        epoch: 20,
        requestId: 3,
        fetchedAtMs: Date.now(),
        authorityScope: authorityScope('/project/a'),
      };
      requests[3]!.resolve(true);
      await flushPromises();
    });
    expect(snapshots.at(-1)?.providerStatusById.get('opencode')).toBeNull();
    expect(snapshots.at(-1)?.providerStatusById.get('codex')).toBeNull();

    await act(async () => {
      storeState.cliProviderLaunchProofByScope['codex\0/project/a'] = {
        providerStatus: codex,
        epoch: 20,
        requestId: 4,
        fetchedAtMs: Date.now(),
        authorityScope: authorityScope('/project/a', 'codex'),
      };
      requests[2]!.resolve(true);
      await flushPromises();
    });
    expect(snapshots.at(-1)?.providerStatusById.get('opencode')).not.toBeNull();
    expect(snapshots.at(-1)?.providerStatusById.get('codex')).toBe(codex);
    expect(snapshots.at(-1)?.providerGenerationById.get('opencode')).toBe('20:3');
    expect(snapshots.at(-1)?.providerGenerationById.get('codex')).toBe('20:4');

    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an in-flight generation and all timers on unmount', async () => {
    const provider = authoritativeProvider();
    let complete: ((value: boolean) => void) | undefined;
    storeState.fetchCliProviderStatus.mockReturnValue(
      new Promise<boolean>((resolve) => {
        complete = resolve;
      })
    );
    const { root, snapshots } = await mountProbe('/project/a');
    const renderCountBeforeUnmount = snapshots.length;

    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      storeState.cliProviderLaunchProofByScope['opencode\0/project/a'] = {
        providerStatus: provider,
        epoch: 11,
        requestId: 1,
        fetchedAtMs: Date.now(),
        authorityScope: authorityScope('/project/a'),
      };
      complete?.(true);
      await flushPromises();
    });

    expect(snapshots).toHaveLength(renderCountBeforeUnmount);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries with bounded backoff and exposes only the successful exact proof', async () => {
    const provider = authoritativeProvider();
    storeState.fetchCliProviderStatus
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(async () => {
        storeState.cliProviderLaunchProofByScope['opencode\0/project/a'] = {
          providerStatus: provider,
          epoch: 4,
          requestId: 12,
          fetchedAtMs: Date.now(),
          authorityScope: authorityScope('/project/a'),
        };
        return true;
      });
    const { root, snapshots } = await mountProbe('/project/a');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXACT_PROJECT_PROVIDER_PROOF_RETRY_DELAYS_MS[0]);
      await flushPromises();
    });

    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(2);
    expect(snapshots.at(-1)?.providerLoadingById.get('opencode')).toBe(false);
    expect(snapshots.at(-1)?.providerStatusById.get('opencode')).toBe(provider);
    expect(snapshots.at(-1)?.providerGenerationById.get('opencode')).toBe('4:12');
    act(() => root.unmount());
  });

  it('cancels a stale scope retry and prevents its generation from updating the new scope', async () => {
    const provider = authoritativeProvider();
    storeState.fetchCliProviderStatus.mockImplementation(async (_providerId, options) => {
      if (options?.projectPath === '/project/a') {
        return false;
      }
      storeState.cliProviderLaunchProofByScope['opencode\0/project/b'] = {
        providerStatus: provider,
        epoch: 5,
        requestId: 20,
        fetchedAtMs: Date.now(),
        authorityScope: authorityScope('/project/b'),
      };
      return true;
    });
    const { root, snapshots, onSnapshot } = await mountProbe('/project/a');

    act(() => {
      root.render(React.createElement(HookProbe, { projectPath: '/project/b', onSnapshot }));
    });
    await act(async () => {
      await flushPromises();
    });
    expect(
      storeState.fetchCliProviderStatus.mock.calls.filter(
        ([, options]) => options?.projectPath === '/project/b'
      )
    ).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      await flushPromises();
    });

    expect(
      storeState.fetchCliProviderStatus.mock.calls.filter(
        ([, options]) => options?.projectPath === '/project/a'
      )
    ).toHaveLength(1);
    expect(snapshots.at(-1)?.providerStatusById.get('opencode')).toBe(provider);
    expect(snapshots.at(-1)?.providerGenerationById.get('opencode')).toBe('5:20');
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a deferred proof completion after switching projects', async () => {
    const provider = authoritativeProvider();
    let resolveProjectA: ((value: boolean) => void) | null = null;
    storeState.fetchCliProviderStatus.mockImplementation(async (_providerId, options) => {
      if (options?.projectPath === '/project/a') {
        return new Promise<boolean>((resolve) => {
          resolveProjectA = resolve;
        });
      }
      storeState.cliProviderLaunchProofByScope['opencode\0/project/b'] = {
        providerStatus: provider,
        epoch: 5,
        requestId: 21,
        fetchedAtMs: Date.now(),
        authorityScope: authorityScope('/project/b'),
      };
      return true;
    });
    const { root, snapshots, onSnapshot } = await mountProbe('/project/a');

    await act(async () => {
      root.render(React.createElement(HookProbe, { projectPath: '/project/b', onSnapshot }));
      await flushPromises();
    });
    await act(async () => {
      storeState.cliProviderLaunchProofByScope['opencode\0/project/a'] = {
        providerStatus: provider,
        epoch: 5,
        requestId: 22,
        fetchedAtMs: Date.now(),
        authorityScope: authorityScope('/project/a'),
      };
      resolveProjectA?.(true);
      await flushPromises();
    });

    expect(snapshots.at(-1)?.providerStatusById.get('opencode')).toBe(provider);
    expect(snapshots.at(-1)?.providerGenerationById.get('opencode')).toBe('5:21');
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });

  it('cancels the old provider generation when the exact provider scope changes', async () => {
    const base = createLoadingMultimodelCliStatus();
    const codex: CliProviderStatus = {
      ...base.providers.find((provider) => provider.providerId === 'codex')!,
      supported: true,
      authenticated: true,
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      capabilities: {
        ...base.providers.find((provider) => provider.providerId === 'codex')!.capabilities,
        teamLaunch: true,
      },
      models: ['gpt-project'],
    };
    let resolveOpenCode: ((value: boolean) => void) | null = null;
    storeState.fetchCliProviderStatus.mockImplementation(async (providerId) => {
      if (providerId === 'opencode') {
        return new Promise<boolean>((resolve) => {
          resolveOpenCode = resolve;
        });
      }
      storeState.cliProviderLaunchProofByScope['codex\0/project/a'] = {
        providerStatus: codex,
        epoch: 10,
        requestId: 2,
        fetchedAtMs: Date.now(),
        authorityScope: authorityScope('/project/a', 'codex'),
      };
      return true;
    });
    const { root, snapshots, onSnapshot } = await mountProbe('/project/a');

    await act(async () => {
      root.render(
        React.createElement(HookProbe, {
          projectPath: '/project/a',
          providerIds: ['codex'],
          onSnapshot,
        })
      );
      await flushPromises();
    });
    await act(async () => {
      resolveOpenCode?.(true);
      await flushPromises();
    });

    expect(snapshots.at(-1)?.providerStatusById.get('codex')).toBe(codex);
    expect(snapshots.at(-1)?.providerStatusById.has('opencode')).toBe(false);
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes for an authoritative proof change and authorizes only the fetched generation', async () => {
    const provider = authoritativeProvider();
    storeState.fetchCliProviderStatus
      .mockImplementationOnce(async () => {
        storeState.cliProviderLaunchProofByScope['opencode\0/project/a'] = {
          providerStatus: provider,
          epoch: 6,
          requestId: 30,
          fetchedAtMs: Date.now(),
          authorityScope: authorityScope('/project/a'),
        };
        return true;
      })
      .mockResolvedValueOnce(true);
    const { root, snapshots, onSnapshot } = await mountProbe('/project/a');
    expect(snapshots.at(-1)?.providerGenerationById.get('opencode')).toBe('6:30');

    storeState.cliProviderLaunchProofByScope = {
      ...storeState.cliProviderLaunchProofByScope,
      ['opencode\0/project/a']: {
        providerStatus: provider,
        epoch: 6,
        requestId: 31,
        fetchedAtMs: Date.now(),
        authorityScope: authorityScope('/project/a'),
      },
    };
    await act(async () => {
      root.render(
        React.createElement(HookProbe, { projectPath: '/project/a', onSnapshot, renderRevision: 1 })
      );
      await flushPromises();
    });

    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(2);
    expect(snapshots.at(-1)?.providerStatusById.get('opencode')).toBe(provider);
    expect(snapshots.at(-1)?.providerGenerationById.get('opencode')).toBe('6:31');
    act(() => root.unmount());
  });

  it('does not preflight again for a non-authoritative scoped catalog request generation', async () => {
    const provider = authoritativeProvider();
    storeState.fetchCliProviderStatus.mockImplementationOnce(async () => {
      storeState.cliProviderLaunchProofByScope['opencode\0/project/a'] = {
        providerStatus: provider,
        epoch: 8,
        requestId: 40,
        fetchedAtMs: Date.now(),
        authorityScope: authorityScope('/project/a'),
      };
      return true;
    });
    const { root, snapshots, onSnapshot } = await mountProbe('/project/a');

    storeState.cliProviderLaunchProofByScope = {
      ...storeState.cliProviderLaunchProofByScope,
      ['opencode\0/project/a']: {
        providerStatus: {
          ...provider,
          verificationState: 'unknown',
          statusCheckOutcome: 'pending',
          statusCheckErrorCode: 'partial_response',
          capabilities: { ...provider.capabilities, teamLaunch: false },
        },
        epoch: 8,
        requestId: 41,
        fetchedAtMs: Date.now(),
        authorityScope: authorityScope('/project/a'),
      },
    };
    await act(async () => {
      root.render(
        React.createElement(HookProbe, { projectPath: '/project/a', onSnapshot, renderRevision: 1 })
      );
      await flushPromises();
    });

    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(1);
    expect(snapshots.at(-1)?.providerStatusById.get('opencode')).toBeNull();
    expect(snapshots.at(-1)?.providerLoadingById.get('opencode')).toBe(false);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('keeps a valid exact generation authoritative while passive scoped loading changes', async () => {
    const provider = authoritativeProvider();
    storeState.fetchCliProviderStatus.mockImplementationOnce(async () => {
      storeState.cliProviderLaunchProofByScope['opencode\0/project/a'] = {
        providerStatus: provider,
        epoch: 12,
        requestId: 70,
        fetchedAtMs: Date.now(),
        authorityScope: authorityScope('/project/a'),
      };
      return true;
    });
    const { root, snapshots, onSnapshot } = await mountProbe('/project/a');
    expect(snapshots.at(-1)?.providerGenerationById.get('opencode')).toBe('12:70');
    expect(snapshots.at(-1)?.providerLoadingById.get('opencode')).toBe(false);

    storeState.cliProviderStatusLoadingByScope['opencode\0/project/a'] = true;
    await act(async () => {
      root.render(
        React.createElement(HookProbe, { projectPath: '/project/a', onSnapshot, renderRevision: 1 })
      );
      await flushPromises();
    });

    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(1);
    expect(snapshots.at(-1)?.providerStatusById.get('opencode')).toBe(provider);
    expect(snapshots.at(-1)?.providerGenerationById.get('opencode')).toBe('12:70');
    expect(snapshots.at(-1)?.providerLoadingById.get('opencode')).toBe(false);
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses bounded attempts and a single recovery timer without creating a retry storm', async () => {
    storeState.fetchCliProviderStatus.mockResolvedValue(false);
    const { root, snapshots } = await mountProbe('/project/a');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      await flushPromises();
    });

    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(3);
    expect(snapshots.at(-1)?.providerLoadingById.get('opencode')).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXACT_PROJECT_PROVIDER_PROOF_RECOVERY_DELAYS_MS[0] - 1);
    });
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(3);
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('resolveProjectScopedProviderStatus', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useStoreMock.mockReset();
  });

  it('renews the same exact scope through second and third 60-second proof cycles', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    const nowMs = Date.parse('2026-08-20T12:00:00.000Z');
    vi.setSystemTime(nowMs);
    const base = createLoadingMultimodelCliStatus();
    const codex = base.providers.find((provider) => provider.providerId === 'codex')!;
    const providerStatus: CliProviderStatus = {
      ...codex,
      supported: true,
      authenticated: true,
      authMethod: 'codex_chatgpt',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      capabilities: { ...codex.capabilities, teamLaunch: true },
      models: ['gpt-project'],
      modelCatalog: null,
    };
    const scopeKey = 'codex\0/project/models-only';
    let requestId = 12;
    const fetchCliProviderStatus = vi.fn(async () => {
      requestId += 1;
      storeState.cliProviderLaunchProofByScope[scopeKey] = {
        providerStatus,
        requestId,
        epoch: 4,
        fetchedAtMs: Date.now(),
        authorityScope: authorityScope('/project/models-only', 'codex'),
      };
      return true;
    });
    const storeState = {
      cliProviderLaunchProofByScope: {
        [scopeKey]: {
          providerStatus,
          requestId: 12,
          epoch: 4,
          fetchedAtMs: nowMs,
          authorityScope: authorityScope('/project/models-only', 'codex'),
        },
      },
      cliProviderStatusLoadingByScope: {},
      cliProviderStatusScopeRevision: 0,
      fetchCliProviderStatus,
    };
    useStoreMock.mockImplementation((selector) => selector(storeState as never));
    Object.assign(useStoreMock, { getState: () => storeState });

    const onRender = vi.fn<(expiry: number | null) => void>();
    const Harness = (): null => {
      const snapshot = useExactProjectProviderLaunchProof(['codex'], '/project/models-only');
      useEffect(() => {
        onRender(snapshot.providerProofExpiresAtMs);
      });
      return null;
    };
    const container = document.createElement('div');
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(React.createElement(Harness));
        await Promise.resolve();
      });
      expect(fetchCliProviderStatus).toHaveBeenCalledWith('codex', {
        silent: true,
        requestEpoch: expect.any(Number),
        checkReason: 'launch_preflight',
        projectPath: '/project/models-only',
        intent: 'launch-proof',
      });
      expect(onRender).toHaveBeenLastCalledWith(Date.now() + 60_000);
      expect(requestId).toBe(13);
      for (const expectedCalls of [2, 3, 4]) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_001);
          await flushPromises();
        });
        expect(fetchCliProviderStatus).toHaveBeenCalledTimes(expectedCalls);
        expect(requestId).toBe(12 + expectedCalls);
        expect(onRender).toHaveBeenLastCalledWith(Date.now() + 60_000);
        expect(vi.getTimerCount()).toBe(1);
      }
    } finally {
      await act(async () => root.unmount());
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('replaces an expired arrival with a new store generation without extending it locally', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const base = createLoadingMultimodelCliStatus();
    const codex = base.providers.find((provider) => provider.providerId === 'codex')!;
    const providerStatus: CliProviderStatus = {
      ...codex,
      supported: true,
      authenticated: true,
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      capabilities: { ...codex.capabilities, teamLaunch: true },
      models: ['gpt-project'],
    };
    const scopeKey = 'codex\0/project/expired-arrival';
    const fetchCliProviderStatus = vi.fn(async () => {
      storeState.cliProviderLaunchProofByScope[scopeKey] = {
        providerStatus,
        requestId: 2,
        epoch: 1,
        fetchedAtMs: Date.now(),
        authorityScope: authorityScope('/project/expired-arrival', 'codex'),
      };
      return true;
    });
    const storeState = {
      cliProviderLaunchProofByScope: {
        [scopeKey]: {
          providerStatus,
          requestId: 1,
          epoch: 1,
          fetchedAtMs: 39_999,
          authorityScope: authorityScope('/project/expired-arrival', 'codex'),
        },
      },
      cliProviderStatusLoadingByScope: {},
      fetchCliProviderStatus,
    };
    useStoreMock.mockImplementation((selector) => selector(storeState as never));
    Object.assign(useStoreMock, { getState: () => storeState });
    const snapshots: ProofSnapshot[] = [];
    const Probe = (): null => {
      const snapshot = useExactProjectProviderLaunchProof(['codex'], '/project/expired-arrival');
      useEffect(() => {
        snapshots.push(snapshot);
      }, [snapshot]);
      return null;
    };
    const root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(React.createElement(Probe));
      await flushPromises();
      await flushPromises();
    });
    expect(fetchCliProviderStatus).toHaveBeenCalledTimes(1);
    expect(snapshots.at(-1)?.providerGenerationById.get('codex')).toBe('1:2');
    expect(snapshots.at(-1)?.providerProofExpiresAtMs).toBe(160_000);
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not complete exact-scope launch proof when any scoped fetch fails closed', () => {
    expect(didExactProjectProviderLaunchProofComplete([])).toBe(false);
    expect(didExactProjectProviderLaunchProofComplete([true, false, true])).toBe(false);
    expect(didExactProjectProviderLaunchProofComplete([true, true])).toBe(true);
  });

  it('does not reuse completed proof after the launch-proof consumer was disabled', () => {
    const requestKey = '/project/a\u0001opencode\u00011';
    expect(isExactProjectProviderLaunchProofCurrent(requestKey, requestKey, requestKey)).toBe(true);
    expect(isExactProjectProviderLaunchProofCurrent(requestKey, null, requestKey)).toBe(false);
  });

  it('retains global OpenCode display evidence without reusing its launch readiness', () => {
    const base = createLoadingMultimodelCliStatus().providers.find(
      (provider) => provider.providerId === 'opencode'
    )!;
    const globalProvider = {
      ...base,
      supported: true,
      authenticated: true,
      authMethod: 'opencode_configured_local',
      verificationState: 'verified' as const,
      statusCheckOutcome: 'authoritative' as const,
      models: ['openai/global-only'],
      capabilities: { ...base.capabilities, teamLaunch: true },
      modelCatalogRefreshState: 'ready' as const,
      modelCatalog: {
        schemaVersion: 1 as const,
        providerId: 'opencode' as const,
        source: 'app-server' as const,
        status: 'ready' as const,
        fetchedAt: '2026-08-18T00:00:00.000Z',
        staleAt: '2026-08-18T00:10:00.000Z',
        defaultModelId: 'openai/global-only',
        defaultLaunchModel: 'openai/global-only',
        models: [],
        diagnostics: {
          configReadState: 'ready' as const,
          appServerState: 'healthy' as const,
          message: null,
          code: null,
        },
      },
    };

    const projectProvider = resolveProjectScopedProviderStatus('opencode', null, globalProvider);

    expect(projectProvider).toMatchObject({
      providerId: 'opencode',
      authenticated: false,
      statusCheckOutcome: 'pending',
      models: ['openai/global-only'],
      capabilities: { teamLaunch: false },
      modelCatalog: { status: 'stale' },
    });
  });

  it('recomputes aggregate auth after replacing global OpenCode with project scope', () => {
    const status = createLoadingMultimodelCliStatus();
    const globalOpenCode: CliProviderStatus = {
      ...status.providers.find((provider) => provider.providerId === 'opencode')!,
      authenticated: true,
      authMethod: 'opencode_configured_local',
      statusCheckOutcome: 'authoritative' as const,
    };
    const projectOpenCode: CliProviderStatus = {
      ...globalOpenCode,
      authenticated: false,
      authMethod: null,
      statusCheckOutcome: 'pending' as const,
    };
    const globalStatus: CliInstallationStatus = {
      ...status,
      authLoggedIn: true,
      authMethod: 'opencode_configured_local',
      providers: status.providers.map((provider) =>
        provider.providerId === 'opencode' ? globalOpenCode : provider
      ),
    };

    const projectStatus = replaceProjectScopedProviderStatus(
      globalStatus,
      'opencode',
      projectOpenCode
    );

    expect(projectStatus.authLoggedIn).toBe(false);
    expect(projectStatus.authMethod).toBeNull();
  });

  it.each([
    ['anthropic', 'claude.ai'],
    ['codex', 'codex_chatgpt'],
  ] as const)(
    'retains global %s display evidence without reusing launch authority',
    (providerId, authMethod) => {
      const base = createLoadingMultimodelCliStatus().providers.find(
        (provider) => provider.providerId === providerId
      )!;
      const globalProvider: CliProviderStatus = {
        ...base,
        authenticated: true,
        authMethod,
        statusCheckOutcome: 'authoritative',
        models: [`${providerId}/global-model`],
        capabilities: { ...base.capabilities, teamLaunch: true },
        subscriptionRateLimits: {
          primary: {
            usedPercent: 35,
            windowDurationMins: 300,
            resetsAt: 1_777_777_000,
          },
          secondary: null,
        },
      };

      const projectProvider = resolveProjectScopedProviderStatus(providerId, null, globalProvider);

      expect(projectProvider).toMatchObject({
        providerId,
        authenticated: false,
        authMethod: null,
        statusCheckOutcome: 'pending',
        models: [`${providerId}/global-model`],
        capabilities: { teamLaunch: false },
      });
      expect(projectProvider?.subscriptionRateLimits).toEqual(
        globalProvider.subscriptionRateLimits
      );
    }
  );
});
