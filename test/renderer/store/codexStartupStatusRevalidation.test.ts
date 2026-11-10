import { api } from '@renderer/api';
import { installCodexStartupStatusRevalidation } from '@renderer/store/codexStartupStatusRevalidation';
import {
  createCliInstallerSlice,
  createLoadingMultimodelCliStatus,
} from '@renderer/store/slices/cliInstallerSlice';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import type { CodexAccountSnapshotDto } from '@features/codex-account/contracts';
import type { CliInstallerSlice } from '@renderer/store/slices/cliInstallerSlice';
import type { CliProviderStatus } from '@shared/types';
import type { StateCreator } from 'zustand';

vi.mock('@renderer/api', () => ({
  api: { cliInstaller: { getProviderStatus: vi.fn() } },
}));

const healthyAccount: CodexAccountSnapshotDto = {
  preferredAuthMode: 'auto',
  effectiveAuthMode: 'chatgpt',
  launchAllowed: true,
  launchIssueMessage: null,
  launchReadinessState: 'ready_chatgpt',
  appServerState: 'healthy',
  appServerStatusMessage: null,
  managedAccount: { type: 'chatgpt', email: null, planType: 'plus' },
  apiKey: { available: false, source: null, sourceLabel: null },
  requiresOpenaiAuth: true,
  login: { status: 'idle', error: null, startedAt: null },
  rateLimits: null,
  updatedAt: '2026-11-10T12:00:00.000Z',
};

function fixture() {
  const store = createStore<CliInstallerSlice>()(
    createCliInstallerSlice as unknown as StateCreator<CliInstallerSlice>
  );
  const status = createLoadingMultimodelCliStatus();
  const unknown: CliProviderStatus = {
    ...status.providers.find((provider) => provider.providerId === 'codex')!,
    supported: true,
    statusCheckOutcome: 'authoritative',
    statusMessage: null,
  };
  store.setState({ cliStatus: status });
  let onSnapshot: ((_event: unknown, snapshot: CodexAccountSnapshotDto) => void) | undefined;
  const unsubscribe = vi.fn();
  const accountApi = {
    getCodexAccountSnapshot: vi.fn(async () => healthyAccount),
    onCodexAccountSnapshotChanged: vi.fn((callback: typeof onSnapshot) => {
      onSnapshot = callback;
      return unsubscribe;
    }),
  };
  const cleanup = installCodexStartupStatusRevalidation(store, accountApi);
  return {
    store,
    unknown,
    accountApi,
    cleanup,
    unsubscribe,
    push: (snapshot = healthyAccount) => onSnapshot?.({}, snapshot),
  };
}

afterEach(() => vi.clearAllMocks());

describe('Codex startup status revalidation', () => {
  it.each(['unknown', 'timeout'] as const)(
    'keeps recovery pending across the deferred account lookup and queued runtime check after %s',
    async (initialStatus) => {
      const test = fixture();
      const pendingTransitions: boolean[] = [];
      const unsubscribePending = test.store.subscribe((state) => {
        if (pendingTransitions.at(-1) !== state.codexStatusRecoveryPending) {
          pendingTransitions.push(state.codexStatusRecoveryPending);
        }
      });
      let finishAccount!: (snapshot: CodexAccountSnapshotDto) => void;
      let finishProvider!: (provider: CliProviderStatus) => void;
      test.accountApi.getCodexAccountSnapshot.mockReturnValueOnce(
        new Promise((resolve) => {
          finishAccount = resolve;
        })
      );
      vi.mocked(api.cliInstaller.getProviderStatus).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishProvider = resolve;
          })
      );
      try {
        test.store.setState({
          cliStatus: {
            ...createLoadingMultimodelCliStatus(),
            providers: [
              {
                ...test.unknown,
                ...(initialStatus === 'timeout'
                  ? {
                      statusCheckOutcome: 'transient_error' as const,
                      statusCheckErrorCode: 'timeout' as const,
                      verificationState: 'error' as const,
                    }
                  : {}),
              },
            ],
          },
        });
        expect(test.store.getState().codexStatusRecoveryPending).toBe(true);
        expect(test.store.getState().cliProviderStatusLoading.codex).not.toBe(true);
        await vi.waitFor(() =>
          expect(test.accountApi.getCodexAccountSnapshot).toHaveBeenCalledTimes(1)
        );
        expect(test.store.getState().codexStatusRecoveryPending).toBe(true);
        finishAccount(healthyAccount);
        await vi.waitFor(() => expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledTimes(1));
        expect(test.store.getState().codexStatusRecoveryPending).toBe(true);
        expect(test.store.getState().cliProviderStatusLoading.codex).toBe(true);
        finishProvider({ ...test.unknown, authenticated: true, verificationState: 'verified' });
        await vi.waitFor(() =>
          expect(test.store.getState().codexStatusRecoveryPending).toBe(false)
        );
        expect(pendingTransitions).toEqual([true, false]);
      } finally {
        unsubscribePending();
        test.cleanup();
      }
    }
  );

  it.each(['signed out', 'lookup failed'] as const)(
    'settles recovery without retrying when the account is %s',
    async (outcome) => {
      const test = fixture();
      if (outcome === 'lookup failed')
        test.accountApi.getCodexAccountSnapshot.mockRejectedValueOnce(
          new Error('Test-only account unavailable')
        );
      else
        test.accountApi.getCodexAccountSnapshot.mockResolvedValueOnce({
          ...healthyAccount,
          effectiveAuthMode: null,
          launchAllowed: false,
        });
      try {
        test.store.setState({
          cliStatus: { ...createLoadingMultimodelCliStatus(), providers: [test.unknown] },
        });
        expect(test.store.getState().codexStatusRecoveryPending).toBe(true);
        await vi.waitFor(() =>
          expect(test.store.getState().codexStatusRecoveryPending).toBe(false)
        );
        expect(api.cliInstaller.getProviderStatus).not.toHaveBeenCalled();
        expect(test.accountApi.getCodexAccountSnapshot).toHaveBeenCalledTimes(1);
      } finally {
        test.cleanup();
      }
    }
  );

  it('rechecks after account warming races the initial probe, without joining the old request', async () => {
    const test = fixture();
    let resolveInitial!: (provider: CliProviderStatus) => void;
    let resolveFresh!: (provider: CliProviderStatus) => void;
    vi.mocked(api.cliInstaller.getProviderStatus)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFresh = resolve;
          })
      );
    try {
      const initial = test.store.getState().fetchCliProviderStatus('codex');
      test.push();
      await Promise.resolve();
      expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledTimes(1);
      resolveInitial(test.unknown);
      await initial;
      await vi.waitFor(() => expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledTimes(2));
      expect(
        test.store.getState().cliStatus?.providers.find((p) => p.providerId === 'codex')
      ).toMatchObject({ authenticated: false, capabilities: { teamLaunch: false } });
      resolveFresh({ ...test.unknown, authenticated: true, verificationState: 'verified' });
      await vi.waitFor(() =>
        expect(test.store.getState().cliProviderStatusLoading.codex).toBe(false)
      );
      test.push();
      test.push({ ...healthyAccount, updatedAt: '2026-11-10T12:01:00.000Z' });
      await Promise.resolve();
      expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledTimes(2);
      expect(test.accountApi.getCodexAccountSnapshot).not.toHaveBeenCalled();
    } finally {
      test.cleanup();
    }
  });


  it('settles a failed recheck when the account push precedes the unknown status', async () => {
    const test = fixture();
    let finishRecheck!: (provider: CliProviderStatus) => void;
    vi.mocked(api.cliInstaller.getProviderStatus).mockImplementationOnce(
      () => new Promise((resolve) => { finishRecheck = resolve; })
    );
    try {
      test.push();
      test.store.setState({
        cliStatus: { ...createLoadingMultimodelCliStatus(), providers: [test.unknown] },
      });
      await vi.waitFor(() => expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledTimes(1));
      expect(test.store.getState().codexStatusRecoveryPending).toBe(true);
      finishRecheck(test.unknown);
      await vi.waitFor(() => expect(test.store.getState().codexStatusRecoveryPending).toBe(false));
      expect(test.accountApi.getCodexAccountSnapshot).not.toHaveBeenCalled();
      expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledTimes(1);
    } finally {
      test.cleanup();
    }
  });

  it('discovers an already warm account once and does not retry every account update after failure', async () => {
    const test = fixture();
    vi.mocked(api.cliInstaller.getProviderStatus).mockResolvedValue(test.unknown);
    try {
      test.store.setState({
        cliStatus: { ...createLoadingMultimodelCliStatus(), providers: [test.unknown] },
      });
      await vi.waitFor(() => expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledTimes(1));
      expect(test.accountApi.getCodexAccountSnapshot).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(test.store.getState().codexStatusRecoveryPending).toBe(false));
      test.push();
      test.push();
      await Promise.resolve();
      expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledTimes(1);
    } finally {
      test.cleanup();
    }
  });

  it('bounds timeout recovery even when repeated account snapshots stay ready', async () => {
    const test = fixture();
    const timeout: CliProviderStatus = {
      ...test.unknown,
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'timeout',
      verificationState: 'error',
    };
    vi.mocked(api.cliInstaller.getProviderStatus).mockResolvedValue(timeout);
    try {
      test.store.setState({
        cliStatus: { ...createLoadingMultimodelCliStatus(), providers: [timeout] },
      });
      // The one recovery read retains the store's existing single timeout retry.
      await vi.waitFor(() => expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(test.store.getState().codexStatusRecoveryPending).toBe(false));
      test.push();
      test.push();
      await Promise.resolve();
      expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledTimes(2);
      expect(test.store.getState().cliStatus?.providers[0]).toMatchObject({
        authenticated: false,
        statusCheckErrorCode: 'timeout',
        capabilities: { teamLaunch: false },
      });
    } finally {
      test.cleanup();
    }
  });

  it('ignores signed-out snapshots and unsubscribes with pending work on disposal', async () => {
    const test = fixture();
    test.push({ ...healthyAccount, effectiveAuthMode: null, launchAllowed: false });
    test.store.setState({
      cliStatus: { ...createLoadingMultimodelCliStatus(), providers: [test.unknown] },
    });
    expect(test.store.getState().codexStatusRecoveryPending).toBe(true);
    test.cleanup();
    expect(test.store.getState().codexStatusRecoveryPending).toBe(false);
    await Promise.resolve();
    expect(test.unsubscribe).toHaveBeenCalledTimes(1);
    expect(api.cliInstaller.getProviderStatus).not.toHaveBeenCalled();
    expect(test.accountApi.getCodexAccountSnapshot).not.toHaveBeenCalled();
  });
});
